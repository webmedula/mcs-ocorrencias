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
import { enviarResposta } from "./notify.js";

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
  if (!u || !ok || !u.ativo) return res.status(401).json({ erro: "E-mail ou senha incorretos." });
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
  res.json(a.tipo === "usuario" ? { tipo: "usuario", nome: a.nome, email: a.email, papel: a.papel } : { tipo: "ia", nome: a.nome });
});

// Tudo abaixo exige estar logado (pessoa ou chave do Gerente IA)
admin.use(exigirLogin);

// ---------- Ocorrências ----------
admin.get("/ocorrencias", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const canal = String(req.query.canal ?? "");
  const status = String(req.query.status ?? "");
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = 25;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (canal in CANAIS) { where.push("canal = ?"); args.push(canal); }
  if (status in STATUS) { where.push("status = ?"); args.push(status); }
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    where.push("(protocolo LIKE ? ESCAPE '\\' OR pedido LIKE ? ESCAPE '\\' OR nome LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const cond = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ocorrencias ${cond}`).get(...args) as { n: number }).n;
  const itens = db
    .prepare(
      `SELECT protocolo, canal, pedido, tipo, nome, email, status, tiny_status, criado_em, atualizado_em,
              (SELECT COUNT(*) FROM anexos a WHERE a.ocorrencia_id = o.id) AS fotos
       FROM ocorrencias o ${cond} ORDER BY o.criado_em DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, porPagina, (pagina - 1) * porPagina);
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
  const { ip_hash: _ip, tiny_json: _t, ...resto } = o;
  res.json({ ...resto, tiny, anexos, eventos });
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
  res.json({ ok: true });
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
  res.status(201).json({ id: Number(r.lastInsertRowid), token });
});

admin.delete("/chaves/:id", soGerente, (req, res) => {
  const id = campoId.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ erro: "Chave inválida." });
  db.prepare("UPDATE chaves_api SET ativa = 0 WHERE id = ?").run(id.data);
  res.json({ ok: true });
});

// Erros desta área sempre em JSON
admin.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[admin]", err);
  res.status(500).json({ erro: "Erro interno." });
});
