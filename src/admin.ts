import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { z } from "zod";
import { CANAIS, STATUS, TIPOS, config, type Status } from "./config.js";
import { db } from "./db.js";
import {
  conferirSenha, criarSessao, encerrarSessao, exigirLogin, gastarTempo, gerarChave, hashSenha,
  identificar, nomeDoAtor, senhaForte, soGerente, soPessoas,
} from "./auth.js";
import { enviarRedefinicao, enviarResposta } from "./notify.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import QRCode from "qrcode";
import { registrar, checarFalhas, checarLoginNovo } from "./registro.js";
import { anonimizar, excluir, exportarDados } from "./lgpd.js";
import { fazerBackup, listarBackups, pastaBackups } from "./rotinas.js";
import { pastaProdutos, MlErro, desconectar, enviarMensagem, sincronizar, statusConexao, urlAutorizacao } from "./ml.js";

const uploadsDir = path.join(config.dataDir, "uploads");
export const admin = express.Router();
admin.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
admin.use(identificar);

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas de login. Aguarde alguns minutos." },
});

const statusKeys = Object.keys(STATUS) as [Status, ...Status[]];
const campoId = z.coerce.number().int().positive();

function oc(protocolo: string) {
  return db.prepare("SELECT * FROM ocorrencias WHERE protocolo = ?").get(protocolo.toUpperCase()) as any | undefined;
}
const invalido = (res: express.Response, e: z.ZodError) =>
  res.status(400).json({ erro: e.issues[0]?.message ?? "Dados inválidos." });

// ---------- Sessão ----------
admin.post("/login", limiteLogin, (req, res) => {
  const p = z.object({ email: z.string().trim().toLowerCase().max(160), senha: z.string().max(200) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: "Informe e-mail e senha." });
  const u = db.prepare("SELECT * FROM usuarios WHERE email = ?").get(p.data.email) as any | undefined;
  const ok = u ? conferirSenha(p.data.senha, u.senha_hash) : (gastarTempo(p.data.senha), false);
  if (!u || !ok || !u.ativo) {
    registrar("login_falha", { usuarioId: u?.id, email: p.data.email, detalhe: u && ok && !u.ativo ? "conta desativada" : null, req });
    if (u) checarFalhas(p.data.email);
    return res.status(401).json({ erro: "E-mail ou senha incorretos." });
  }
  checarLoginNovo(u, req);
  registrar("login_ok", { usuarioId: u.id, email: u.email, req });
  db.prepare("UPDATE usuarios SET ultimo_login = datetime('now') WHERE id = ?").run(u.id);
  criarSessao(res, u.id);
  res.json({ nome: u.nome, email: u.email, papel: u.papel });
});

admin.post("/logout", (req, res) => {
  encerrarSessao(req, res);
  res.json({ ok: true });
});

admin.get("/me", (req, res) => {
  const a = req.ator;
  if (!a) return res.status(401).json({ erro: "Não autenticado." });
  if (a.tipo !== "usuario") return res.json({ tipo: "ia", nome: a.nome });
  const av = db.prepare("SELECT avisar_email FROM usuarios WHERE id = ?").get(a.id) as { avisar_email: number } | undefined;
  res.json({ tipo: "usuario", nome: a.nome, email: a.email, papel: a.papel, avisarEmail: Boolean(av?.avisar_email) });
});

// Tudo abaixo exige estar logado (pessoa ou chave do Gerente IA)

// ---------- Recuperação de senha por e-mail (v1.3.0) ----------
const limiteEsqueci = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { erro: "Muitos pedidos. Aguarde alguns minutos e tente de novo." },
});
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const RESPOSTA_ESQUECI = { ok: true, mensagem: "Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha. Ele vale por 1 hora." };

admin.post("/esqueci", limiteEsqueci, async (req, res) => {
  const p = z.object({ email: z.string().trim().toLowerCase().max(160) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: "Informe o e-mail." });
  const u = db.prepare("SELECT id, nome, email FROM usuarios WHERE email = ? AND ativo = 1").get(p.data.email) as
    | { id: number; nome: string; email: string } | undefined;
  // Mesma resposta exista a conta ou não (não revela quem tem acesso)
  if (u && dentroDoLimite(`esqueci:${u.id}`, 3)) {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM redefinicoes WHERE usuario_id = ?").run(u.id);
    db.prepare("INSERT INTO redefinicoes (token_hash, usuario_id, expira_em) VALUES (?,?, datetime('now','+60 minutes'))").run(sha(token), u.id);
    registrar("redefinicao_pedida", { usuarioId: u.id, email: u.email, req });
    try { await enviarRedefinicao(u, `${config.publicUrl}/painel#redefinir=${token}`); }
    catch (e: any) { console.error("[painel] falha ao enviar redefinição:", e?.message); }
  }
  res.json(RESPOSTA_ESQUECI);
});

const limiteRedefinir = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente de novo." },
});
admin.post("/redefinir", limiteRedefinir, (req, res) => {
  const p = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), nova: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: "Link inválido." });
  if (!senhaForte(p.data.nova)) return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 10 caracteres." });
  const r = db
    .prepare("SELECT usuario_id FROM redefinicoes WHERE token_hash = ? AND usado = 0 AND expira_em > datetime('now')")
    .get(sha(p.data.token)) as { usuario_id: number } | undefined;
  if (!r) return res.status(400).json({ erro: "Este link venceu ou já foi usado. Peça um novo." });
  db.transaction(() => {
    db.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(hashSenha(p.data.nova), r.usuario_id);
    db.prepare("DELETE FROM redefinicoes WHERE usuario_id = ?").run(r.usuario_id);
    db.prepare("DELETE FROM sessoes WHERE usuario_id = ?").run(r.usuario_id);
  })();
  registrar("senha_redefinida", { usuarioId: r.usuario_id, detalhe: "por link de e-mail", req });
  res.json({ ok: true });
});

admin.use(exigirLogin);

// ---------- Ocorrências ----------
function produtosDe(json: string | null | undefined): any[] {
  try { const j = json ? JSON.parse(json) : []; return Array.isArray(j) ? j : []; } catch { return []; }
}

// Foto do produto (guardada no volume). Só quem está logado.
admin.get("/produto-img/:arquivo", (req, res) => {
  const a = req.params.arquivo;
  if (!/^[a-f0-9]{16}\.(jpg|png|webp)$/.test(a)) return res.status(404).json({ erro: "Imagem não encontrada." });
  const caminho = path.join(pastaProdutos, a);
  if (!fs.existsSync(caminho)) return res.status(404).json({ erro: "Imagem não encontrada." });
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(caminho);
});

admin.get("/ocorrencias", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const canal = String(req.query.canal ?? "");
  const status = String(req.query.status ?? "");
  const origem = String(req.query.origem ?? "");
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = 25;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (canal in CANAIS) { where.push("canal = ?"); args.push(canal); }
  if (status in STATUS) { where.push("status = ?"); args.push(status); }
  if (origem === "ml" || origem === "formulario") { where.push("origem = ?"); args.push(origem); }
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    where.push("(protocolo LIKE ? ESCAPE '\\' OR pedido LIKE ? ESCAPE '\\' OR nome LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const cond = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ocorrencias ${cond}`).get(...args) as { n: number }).n;
  const itens = db
    .prepare(
      `SELECT protocolo, canal, pedido, tipo, nome, email, status, tiny_status, origem, prazo_em, criado_em, atualizado_em, produto_json,
              (SELECT COUNT(*) FROM anexos a WHERE a.ocorrencia_id = o.id) AS fotos
       FROM ocorrencias o ${cond} ORDER BY o.criado_em DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, porPagina, (pagina - 1) * porPagina)
    .map((r: any) => {
      const { produto_json, ...resto } = r;
      const p = produtosDe(produto_json)[0];
      return { ...resto, produto: p ? { foto: p.foto, titulo: p.titulo } : null };
    });
  const contagem: Record<string, number> = Object.fromEntries(statusKeys.map((k) => [k, 0]));
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM ocorrencias GROUP BY status").all() as { status: string; n: number }[])
    contagem[r.status] = r.n;
  res.json({ itens, total, pagina, porPagina, contagem, canais: CANAIS, tipos: TIPOS, status: STATUS });
});

admin.get("/ocorrencias/:protocolo", (req, res) => {
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  const anexos = db.prepare("SELECT id, original, mime, tamanho FROM anexos WHERE ocorrencia_id = ? ORDER BY id").all(o.id);
  const eventos = db
    .prepare("SELECT id, texto, publico, autor, criado_em FROM eventos WHERE ocorrencia_id = ? ORDER BY id")
    .all(o.id);
  let tiny: unknown = null;
  try { tiny = o.tiny_json ? JSON.parse(o.tiny_json) : null; } catch { /* ignora */ }
  const { ip_hash: _ip, tiny_json: _t, ml_json: mlJson, produto_json: pj, ...resto } = o;
  let ml: unknown = null;
  if (o.origem === "ml") {
    let claim: any = null;
    try { claim = mlJson ? JSON.parse(mlJson) : null; } catch { /* ignora */ }
    const mensagens = db
      .prepare("SELECT remetente, destinatario, texto, anexos, autor, data FROM ml_mensagens WHERE ocorrencia_id = ? ORDER BY data, id")
      .all(o.id);
    ml = { claim, mensagens, destinatario: claim?.stage === "dispute" ? "mediator" : "complainant", encerrada: claim?.status === "closed" };
  }
  res.json({ ...resto, tiny, anexos, eventos, ml, produtos: produtosDe(pj) });
});

admin.patch("/ocorrencias/:protocolo/status", (req, res) => {
  const p = z.object({ status: z.enum(statusKeys, { errorMap: () => ({ message: "Status inválido." }) }) }).safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  if (o.status === p.data.status) return res.json({ status: o.status });
  db.transaction(() => {
    db.prepare("UPDATE ocorrencias SET status = ?, atualizado_em = datetime('now') WHERE id = ?").run(p.data.status, o.id);
    db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,1,?)").run(
      o.id, `Status atualizado: ${STATUS[p.data.status]}.`, nomeDoAtor(req.ator!),
    );
  })();
  res.json({ status: p.data.status });
});

const texto = z.object({ texto: z.string().trim().min(2, "Escreva o texto.").max(3000) });

admin.post("/ocorrencias/:protocolo/notas", (req, res) => {
  const p = texto.safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)").run(o.id, p.data.texto, nomeDoAtor(req.ator!));
  db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(o.id);
  res.status(201).json({ ok: true });
});

// Resposta ao cliente: só pessoas (o Gerente IA não responde clientes)
admin.post("/ocorrencias/:protocolo/resposta", soPessoas, async (req, res) => {
  const p = texto.safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  if (o.anonimizada) return res.status(400).json({ erro: "Os dados desta ocorrência foram removidos." });
  if (o.origem === "ml") return res.status(400).json({ erro: "Reclamações do Mercado Livre são respondidas pela mensagem do próprio Mercado Livre." });
  db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,1,?)").run(o.id, p.data.texto, nomeDoAtor(req.ator!));
  db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(o.id);
  let emailEnviado = false;
  try {
    emailEnviado = await enviarResposta({ protocolo: o.protocolo, nome: o.nome, email: o.email }, p.data.texto);
  } catch (e: any) {
    console.error(`[mail] FALHA ao enviar resposta de ${o.protocolo}:`, e?.message);
  }
  res.status(201).json({ ok: true, emailEnviado });
});

// Fotos: só pessoas logadas
admin.get("/anexos/:id", soPessoas, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  if (!id.success) return res.status(404).end();
  const a = db.prepare("SELECT arquivo, mime FROM anexos WHERE id = ?").get(id.data) as { arquivo: string; mime: string } | undefined;
  if (!a) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=300");
  res.type(a.mime).sendFile(path.join(uploadsDir, path.basename(a.arquivo)));
});

// ---------- Mercado Livre ----------
// Limite de mensagens enviadas ao ML por hora (protege contra automação em laço)
const envios = new Map<string, number[]>();
function dentroDoLimite(chave: string, max: number): boolean {
  const agora = Date.now();
  const lista = (envios.get(chave) ?? []).filter((t) => agora - t < 3600_000);
  if (lista.length >= max) { envios.set(chave, lista); return false; }
  lista.push(agora);
  envios.set(chave, lista);
  return true;
}
const erroMl = (res: express.Response, e: unknown) => {
  if (e instanceof MlErro) return res.status(e.status >= 400 && e.status < 600 && e.status !== 401 ? e.status : 502).json({ erro: e.message });
  throw e;
};

// Pessoas e o Gerente IA podem responder o comprador dentro da reclamação do ML
admin.post("/ocorrencias/:protocolo/ml/mensagem", async (req, res) => {
  const p = texto.safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  if (o.origem !== "ml") return res.status(400).json({ erro: "Esta ocorrência não veio do Mercado Livre." });
  if (o.anonimizada) return res.status(400).json({ erro: "Os dados desta ocorrência foram removidos." });
  const a = req.ator!;
  if (!dentroDoLimite(`${a.tipo}:${a.id}`, a.tipo === "ia" ? 20 : 120))
    return res.status(429).json({ erro: "Muitas mensagens na última hora. Aguarde um pouco." });
  try {
    const r = await enviarMensagem(o, p.data.texto, nomeDoAtor(a));
    db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)").run(
      o.id, `Mensagem enviada no Mercado Livre (${r.destinatario === "mediator" ? "ao mediador" : "ao comprador"}).`, nomeDoAtor(a),
    );
    if (o.status === "nova") db.prepare("UPDATE ocorrencias SET status = 'em_analise' WHERE id = ?").run(o.id);
    res.status(201).json({ ok: true, destinatario: r.destinatario });
  } catch (e) {
    return erroMl(res, e);
  }
});

admin.get("/ml/status", soGerente, (_req, res) => res.json(statusConexao()));

admin.post("/ml/conectar", soGerente, (req, res) => {
  try {
    res.json({ url: urlAutorizacao((req.ator as { id: number }).id) });
  } catch (e) {
    return erroMl(res, e);
  }
});

admin.post("/ml/sincronizar", soGerente, async (_req, res) => {
  const r = await sincronizar();
  res.json({ ...r, ...statusConexao() });
});

admin.delete("/ml", soGerente, (_req, res) => {
  desconectar();
  res.json({ ok: true });
});

// ---------- Minha conta ----------
admin.post("/eu/senha", soPessoas, (req, res) => {
  const p = z.object({ atual: z.string().max(200), nova: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: "Dados inválidos." });
  if (!senhaForte(p.data.nova)) return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 10 caracteres." });
  const a = req.ator as { id: number };
  const u = db.prepare("SELECT senha_hash FROM usuarios WHERE id = ?").get(a.id) as { senha_hash: string };
  if (!conferirSenha(p.data.atual, u.senha_hash)) return res.status(400).json({ erro: "A senha atual está incorreta." });
  db.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(hashSenha(p.data.nova), a.id);
  db.prepare("DELETE FROM sessoes WHERE usuario_id = ?").run(a.id);
  criarSessao(res, a.id);
  registrar("senha_alterada", { usuarioId: a.id, detalhe: "pela própria pessoa", req });
  res.json({ ok: true });
});

admin.post("/eu/avisos", soPessoas, (req, res) => {
  const p = z.object({ email: z.boolean() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: "Dados inválidos." });
  db.prepare("UPDATE usuarios SET avisar_email = ? WHERE id = ?").run(p.data.email ? 1 : 0, (req.ator as { id: number }).id);
  res.json({ ok: true, avisarEmail: p.data.email });
});

// ---------- Equipe (só gerente) ----------
admin.get("/usuarios", soGerente, (_req, res) => {
  res.json(db.prepare("SELECT id, nome, email, papel, ativo, criado_em, ultimo_login FROM usuarios ORDER BY ativo DESC, nome").all());
});

admin.post("/usuarios", soGerente, (req, res) => {
  const p = z
    .object({
      nome: z.string().trim().min(2, "Informe o nome.").max(120),
      email: z.string().trim().toLowerCase().email("E-mail inválido.").max(160),
      senha: z.string(),
      papel: z.enum(["gerente", "atendimento"], { errorMap: () => ({ message: "Perfil inválido." }) }),
    })
    .safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  if (!senhaForte(p.data.senha)) return res.status(400).json({ erro: "A senha precisa ter pelo menos 10 caracteres." });
  try {
    const r = db
      .prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?,?,?,?)")
      .run(p.data.nome, p.data.email, hashSenha(p.data.senha), p.data.papel);
    registrar("usuario_criado", { usuarioId: (req.ator as { id: number }).id, email: p.data.email, detalhe: `perfil ${p.data.papel}`, req });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e: any) {
    if (e?.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ erro: "Já existe um usuário com esse e-mail." });
    throw e;
  }
});

admin.patch("/usuarios/:id", soGerente, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  const p = z
    .object({
      nome: z.string().trim().min(2).max(120).optional(),
      papel: z.enum(["gerente", "atendimento"]).optional(),
      ativo: z.boolean().optional(),
      senha: z.string().optional(),
    })
    .safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ erro: "Dados inválidos." });
  const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(id.data) as any | undefined;
  if (!alvo) return res.status(404).json({ erro: "Usuário não encontrado." });
  const eu = req.ator as { id: number };
  const novoPapel = p.data.papel ?? alvo.papel;
  const novoAtivo = p.data.ativo ?? Boolean(alvo.ativo);
  if (alvo.id === eu.id && (!novoAtivo || novoPapel !== "gerente"))
    return res.status(400).json({ erro: "Você não pode desativar nem rebaixar a sua própria conta." });
  if (p.data.senha !== undefined && !senhaForte(p.data.senha))
    return res.status(400).json({ erro: "A senha precisa ter pelo menos 10 caracteres." });
  db.transaction(() => {
    db.prepare("UPDATE usuarios SET nome = ?, papel = ?, ativo = ? WHERE id = ?").run(
      p.data.nome ?? alvo.nome, novoPapel, novoAtivo ? 1 : 0, alvo.id,
    );
    if (p.data.senha !== undefined) db.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(hashSenha(p.data.senha), alvo.id);
    if (p.data.senha !== undefined || !novoAtivo) db.prepare("DELETE FROM sessoes WHERE usuario_id = ?").run(alvo.id);
  })();
  registrar("usuario_alterado", { usuarioId: eu.id, email: alvo.email, detalhe: [p.data.senha !== undefined ? "senha trocada" : "", p.data.ativo !== undefined ? (novoAtivo ? "reativado" : "desativado") : "", p.data.papel ? `perfil ${novoPapel}` : ""].filter(Boolean).join(", ") || "dados", req });
  res.json({ ok: true });
});

// ---------- Chaves do Gerente IA (só gerente) ----------
admin.get("/chaves", soGerente, (_req, res) => {
  res.json(db.prepare("SELECT id, nome, prefixo, ativa, criado_por, criado_em, ultimo_uso FROM chaves_api ORDER BY ativa DESC, id DESC").all());
});

admin.post("/chaves", soGerente, (req, res) => {
  const p = z.object({ nome: z.string().trim().min(2, "Dê um nome à chave.").max(60) }).safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const { token, prefixo, hash } = gerarChave();
  const r = db
    .prepare("INSERT INTO chaves_api (nome, prefixo, token_hash, criado_por) VALUES (?,?,?,?)")
    .run(p.data.nome, prefixo, hash, nomeDoAtor(req.ator!));
  // O token só aparece agora; depois só o prefixo fica visível.
  registrar("chave_criada", { usuarioId: (req.ator as { id: number }).id, detalhe: p.data.nome, req });
  res.status(201).json({ id: Number(r.lastInsertRowid), token });
});

admin.delete("/chaves/:id", soGerente, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ erro: "Chave inválida." });
  db.prepare("UPDATE chaves_api SET ativa = 0 WHERE id = ?").run(id.data);
  registrar("chave_revogada", { usuarioId: (req.ator as { id: number }).id, detalhe: `chave ${id.data}`, req });
  res.json({ ok: true });
});

// Erros desta área sempre em JSON

// ---------- Modelos de resposta (v1.3.0) ----------
const modeloSchema = z.object({ titulo: z.string().trim().min(2).max(80), texto: z.string().trim().min(2).max(2000) });

function preencher(texto: string, o?: { nome?: string; protocolo?: string; pedido?: string }): string {
  if (!o) return texto;
  return texto.replace(/\{nome\}/g, o.nome ?? "").replace(/\{protocolo\}/g, o.protocolo ?? "").replace(/\{pedido\}/g, o.pedido ?? "");
}

// Pessoas e Gerente IA leem. Com ?protocolo=, já vem com {nome}, {protocolo} e {pedido} preenchidos.
admin.get("/modelos", (req, res) => {
  const o = req.query.protocolo ? oc(String(req.query.protocolo)) : undefined;
  const itens = db.prepare("SELECT id, titulo, texto FROM modelos ORDER BY id").all() as { id: number; titulo: string; texto: string }[];
  res.json(itens.map((m) => ({ ...m, texto_pronto: preencher(m.texto, o) })));
});
admin.post("/modelos", soGerente, (req, res) => {
  const p = modeloSchema.safeParse(req.body);
  if (!p.success) return invalido(res, p.error);
  const r = db.prepare("INSERT INTO modelos (titulo, texto) VALUES (?,?)").run(p.data.titulo, p.data.texto);
  res.status(201).json({ id: r.lastInsertRowid });
});
admin.patch("/modelos/:id", soGerente, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  const p = modeloSchema.safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ erro: "Dados inválidos." });
  const r = db.prepare("UPDATE modelos SET titulo = ?, texto = ? WHERE id = ?").run(p.data.titulo, p.data.texto, id.data);
  if (!r.changes) return res.status(404).json({ erro: "Modelo não encontrado." });
  res.json({ ok: true });
});
admin.delete("/modelos/:id", soGerente, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ erro: "Dados inválidos." });
  db.prepare("DELETE FROM modelos WHERE id = ?").run(id.data);
  res.json({ ok: true });
});

// ---------- Números (v1.3.0) ----------
admin.get("/estatisticas", (req, res) => {
  const dias = [7, 30, 90, 365].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
  const desde = `-${dias} days`;
  const rows = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as any[];
  const um = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as any;
  const total = um("SELECT COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now', ?)", desde).n;
  const primeira = um(
    `SELECT AVG((julianday(p.t) - julianday(o.criado_em)) * 24) h, COUNT(*) n FROM ocorrencias o
     JOIN (SELECT ocorrencia_id, MIN(criado_em) t FROM eventos WHERE autor IS NOT NULL GROUP BY ocorrencia_id) p ON p.ocorrencia_id = o.id
     WHERE o.criado_em >= datetime('now', ?)`, desde);
  const resolucao = um(
    `SELECT AVG((julianday(atualizado_em) - julianday(criado_em)) * 24) h, COUNT(*) n FROM ocorrencias
     WHERE status = 'resolvida' AND criado_em >= datetime('now', ?)`, desde);
  const arred = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  res.json({
    dias, total,
    abertas: um("SELECT COUNT(*) n FROM ocorrencias WHERE status != 'resolvida'").n,
    resolvidas: um("SELECT COUNT(*) n FROM ocorrencias WHERE status = 'resolvida' AND criado_em >= datetime('now', ?)", desde).n,
    horasPrimeiraResposta: arred(primeira.h), horasResolucao: arred(resolucao.h),
    porStatus: rows("SELECT status k, COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now', ?) GROUP BY status", desde),
    porCanal: rows("SELECT canal k, COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now', ?) GROUP BY canal ORDER BY n DESC", desde),
    porTipo: rows("SELECT tipo k, COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now', ?) GROUP BY tipo ORDER BY n DESC", desde),
    porOrigem: rows("SELECT origem k, COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now', ?) GROUP BY origem", desde),
    porSemana: rows("SELECT strftime('%Y-%m-%d', criado_em, 'weekday 1', '-7 days') k, COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now','-56 days') GROUP BY k ORDER BY k"),
    canais: CANAIS, tipos: TIPOS,
  });
});

// ---------- QR code por canal (v1.3.0) ----------
admin.get("/qr", async (req, res) => {
  const canal = String(req.query.canal ?? "");
  if (canal && !(canal in CANAIS)) return res.status(400).json({ erro: "Canal inválido." });
  const url = canal ? `${config.publicUrl}/?canal=${canal}` : `${config.publicUrl}/`;
  const png = req.query.formato === "png";
  const opcoes = { margin: 2, errorCorrectionLevel: "M" as const };
  res.setHeader("Content-Disposition", `inline; filename="qr-${canal || "geral"}.${png ? "png" : "svg"}"`);
  if (png) { res.type("png").send(await QRCode.toBuffer(url, { ...opcoes, width: 800 })); return; }
  res.type("image/svg+xml").send(await QRCode.toString(url, { ...opcoes, type: "svg" }));
});

// ---------- Backup (só gerente) ----------
admin.get("/backups", soGerente, (_req, res) => res.json(listarBackups()));
admin.post("/backups", soGerente, async (_req, res) => {
  try { res.status(201).json({ nome: await fazerBackup() }); }
  catch (e: any) { res.status(500).json({ erro: "Não foi possível criar o backup: " + (e?.message ?? "erro") }); }
});
admin.get("/backups/fotos.tar.gz", soGerente, (_req, res) => {
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", 'attachment; filename="fotos-ocorrencias.tar.gz"');
  const tar = spawn("tar", ["-czf", "-", "-C", config.dataDir, "uploads"]);
  tar.stdout.pipe(res);
  tar.on("error", () => res.destroy());
  res.on("close", () => tar.kill());
});
admin.get("/backups/:nome", soGerente, (req, res) => {
  const nome = req.params.nome;
  if (!/^ocorrencias-\d{4}-\d{2}-\d{2}\.db$/.test(nome) || !fs.existsSync(path.join(pastaBackups, nome)))
    return res.status(404).json({ erro: "Backup não encontrado." });
  res.download(path.join(pastaBackups, nome), nome);
});


// ---------- Dados pessoais / LGPD (v1.4.0) ----------
const confirmacao = z.object({ confirmar: z.string() });
// Confirmação simples: a palavra da ação (ou, como antes, o protocolo).
const confirmou = (texto: string, palavra: string, protocolo: string) => {
  const t = texto.trim().toUpperCase();
  return t === palavra || t === protocolo;
};

admin.get("/ocorrencias/:protocolo/exportar", soPessoas, (req, res) => {
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  registrar("dados_exportados", { usuarioId: (req.ator as { id: number }).id, detalhe: o.protocolo, req });
  res.setHeader("Content-Disposition", `attachment; filename="dados-${o.protocolo}.json"`);
  res.type("application/json").send(JSON.stringify(exportarDados(o), null, 2));
});

admin.post("/ocorrencias/:protocolo/anonimizar", soGerente, (req, res) => {
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  const p = confirmacao.safeParse(req.body);
  if (!p.success || !confirmou(p.data.confirmar, "ANONIMIZAR", o.protocolo)) return res.status(400).json({ erro: "Digite ANONIMIZAR para confirmar." });
  anonimizar(o.id);
  registrar("ocorrencia_anonimizada", { usuarioId: (req.ator as { id: number }).id, detalhe: o.protocolo, req });
  res.json({ ok: true });
});

admin.post("/ocorrencias/:protocolo/excluir", soGerente, (req, res) => {
  const o = oc(req.params.protocolo);
  if (!o) return res.status(404).json({ erro: "Ocorrência não encontrada." });
  const p = confirmacao.safeParse(req.body);
  if (!p.success || !confirmou(p.data.confirmar, "EXCLUIR", o.protocolo)) return res.status(400).json({ erro: "Digite EXCLUIR para confirmar." });
  excluir(o.id);
  registrar("ocorrencia_excluida", { usuarioId: (req.ator as { id: number }).id, detalhe: o.protocolo, req });
  res.json({ ok: true });
});

// ---------- Registro de atividades (só gerente) ----------
admin.get("/registro", soGerente, (req, res) => {
  const so = String(req.query.so ?? "");
  const where = so === "acessos" ? "WHERE r.tipo LIKE 'login%' OR r.tipo LIKE 'alerta%'" : "";
  res.json(
    db.prepare(
      `SELECT r.id, r.tipo, COALESCE(u.nome, r.email) AS quem, r.email, r.detalhe, r.ip, r.criado_em
       FROM registro r LEFT JOIN usuarios u ON u.id = r.usuario_id ${where} ORDER BY r.id DESC LIMIT 100`,
    ).all(),
  );
});

admin.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[admin]", err);
  res.status(500).json({ erro: "Erro interno." });
});
