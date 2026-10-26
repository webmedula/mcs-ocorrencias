import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config, CANAIS, TIPOS, STATUS, type Canal, type Tipo, type Status } from "./config.js";
import { db } from "./db.js";
import { gerarProtocolo, hashIp } from "./protocol.js";
import { buscarPedido } from "./tiny.js";
import { admin } from "./admin.js";
import { MlErro, concluirAutorizacao, sincronizar } from "./ml.js";
import { avisarEquipeEmail, avisarTelegram, enviarConfirmacao, enviarTelegram, descreverErroMail, esc, type OcorrenciaResumo } from "./notify.js";
import { dadosDaPesquisa, responderPesquisa } from "./pesquisa.js";
import { completarProdutosTiny } from "./produtos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const uploadsDir = path.join(config.dataDir, "uploads");

export const app = express();
app.set("trust proxy", config.trustProxy === "false" ? false : Number(config.trustProxy) || config.trustProxy);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);
app.use(express.json({ limit: "20kb" }));

// ---------- Upload de fotos ----------
const EXT_POR_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString("hex") + (EXT_POR_MIME[file.mimetype] ?? ".bin")),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 20 },
  // Rejeita (em vez de ignorar em silêncio) arquivos que não sejam foto
  fileFilter: (_req, file, cb) =>
    file.mimetype in EXT_POR_MIME ? cb(null, true) : cb(new Error("TIPO_INVALIDO")),
});

// Confere a assinatura real do arquivo (não confia só no mimetype enviado)
function assinaturaValida(file: string, mime: string): boolean {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (mime === "image/png") return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === "image/webp")
    return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  return false;
}

// ---------- Validação ----------
const canais = Object.keys(CANAIS) as [Canal, ...Canal[]];
const tipos = Object.keys(TIPOS) as [Tipo, ...Tipo[]];

z.setErrorMap((issue, ctx) => {
  if (issue.code === "invalid_type" && issue.received === "undefined") return { message: "Campo obrigatório." };
  if (issue.code === "invalid_enum_value") return { message: "Opção inválida." };
  return { message: ctx.defaultError };
});

const schema = z.object({
  canal: z.enum(canais),
  pedido: z.string().trim().min(3, "Informe o número do pedido").max(60).regex(/^[\w\-./ ]+$/, "Número do pedido inválido"),
  tipo: z.enum(tipos),
  descricao: z.string().trim().min(10, "Descreva o problema com mais detalhes").max(3000),
  nome: z.string().trim().min(2, "Informe seu nome").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido").max(160),
  telefone: z.string().trim().max(30).regex(/^[\d\s()+\-]*$/, "Telefone inválido").optional().or(z.literal("")),
  consentimento: z.literal("true", { errorMap: () => ({ message: "É necessário aceitar o uso dos dados" }) }),
});

// ---------- Rate limit ----------
const limiteEnvio = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Tente novamente mais tarde." },
});
const limiteConsulta = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas consultas. Aguarde alguns minutos." },
});

// ---------- Rotas ----------
app.use("/api/admin", admin);

// Retorno do OAuth do Mercado Livre. A segurança vem do `state` de uso único (o cookie de sessão
// SameSite=Strict não acompanha o redirecionamento vindo de outro site).
app.get("/api/ml/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code || !state) return res.redirect("/painel?ml=erro");
  try {
    await concluirAutorizacao(code, state);
    void sincronizar();
    res.redirect("/painel?ml=ok");
  } catch (e: any) {
    console.error("[ml] falha ao concluir a autorização:", e instanceof MlErro ? e.message : e);
    res.redirect("/painel?ml=erro");
  }
});
app.get("/api/config", (_req, res) => {
  res.json({
    versao: config.version,
    marca: config.brandName,
    emailSuporte: config.supportEmail,
    whatsapp: config.supportWhatsapp,
    privacidadeUrl: config.privacyUrl,
    controlador: config.privacyControlador || config.brandName,
    cnpj: config.privacyCnpj,
    contatoPrivacidade: config.privacyContato || config.supportEmail,
    retencaoMeses: config.retencaoMeses,
    canais: CANAIS,
    tipos: TIPOS,
  });
});

app.get("/healthz", (_req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true, versao: config.version });
});

app.post("/api/ocorrencias", limiteEnvio, upload.array("fotos", 5), async (req, res) => {
  const arquivos = (req.files as Express.Multer.File[] | undefined) ?? [];
  const limpar = () => arquivos.forEach((f) => fs.rmSync(f.path, { force: true }));

  // Honeypot preenchido: finge sucesso e descarta (antes de validar, para não revelar a armadilha)
  if (req.body?.website) {
    limpar();
    return res.status(201).json({ protocolo: gerarProtocolo() });
  }

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    limpar();
    const campos: Record<string, string> = {};
    for (const i of parsed.error.issues) campos[String(i.path[0])] = i.message;
    return res.status(400).json({ erro: "Confira os campos destacados.", campos });
  }
  const d = parsed.data;

  if (!arquivos.every((f) => assinaturaValida(f.path, f.mimetype))) {
    limpar();
    return res.status(400).json({ erro: "Uma das fotos não é uma imagem válida (JPG, PNG ou WebP)." });
  }

  const tiny = await buscarPedido(d.pedido);

  const inserirOc = db.prepare(`
    INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, telefone, tiny_status, tiny_json, ip_hash)
    VALUES (@protocolo, @canal, @pedido, @tipo, @descricao, @nome, @email, @telefone, @tiny_status, @tiny_json, @ip_hash)`);
  const inserirAnexo = db.prepare(
    "INSERT INTO anexos (ocorrencia_id, arquivo, original, mime, tamanho) VALUES (?,?,?,?,?)",
  );
  const inserirEvento = db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico) VALUES (?,?,?)");

  let protocolo = "";
  let ocorrenciaId = 0;
  try {
    db.transaction(() => {
      for (let tentativa = 0; ; tentativa++) {
        protocolo = gerarProtocolo();
        try {
          const r = inserirOc.run({
            protocolo,
            canal: d.canal,
            pedido: d.pedido,
            tipo: d.tipo,
            descricao: d.descricao,
            nome: d.nome,
            email: d.email,
            telefone: d.telefone || null,
            tiny_status: tiny.status,
            tiny_json: tiny.status === "encontrado" ? JSON.stringify(tiny.pedido) : null,
            ip_hash: hashIp(req.ip ?? ""),
          });
          const id = Number(r.lastInsertRowid);
          ocorrenciaId = id;
          for (const f of arquivos) inserirAnexo.run(id, f.filename, f.originalname.slice(0, 200), f.mimetype, f.size);
          inserirEvento.run(id, "Ocorrência recebida.", 1);
          break;
        } catch (e: any) {
          if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" && tentativa < 5) continue;
          throw e;
        }
      }
    })();
  } catch (e) {
    limpar();
    console.error("[db] falha ao salvar ocorrência:", e);
    return res.status(500).json({ erro: "Não foi possível registrar agora. Tente novamente em instantes." });
  }

  const resumo: OcorrenciaResumo = {
    protocolo,
    canal: d.canal,
    tipo: d.tipo,
    pedido: d.pedido,
    nome: d.nome,
    email: d.email,
    telefone: d.telefone || null,
    descricao: d.descricao,
    qtdFotos: arquivos.length,
    tiny,
  };
  // Notificações não bloqueiam nem derrubam o envio
  avisarTelegram(resumo).catch((e) => console.error("[telegram]", e.message));
  void avisarEquipeEmail(`Nova ocorrência ${resumo.protocolo}`, [`Canal: ${CANAIS[resumo.canal]} · Pedido: ${resumo.pedido}`, `Assunto: ${TIPOS[resumo.tipo]} · Cliente: ${resumo.nome}`], resumo.protocolo);
  enviarConfirmacao(resumo).catch((e) => console.error(`[mail] FALHA ao enviar ${protocolo} para ${d.email}: ${descreverErroMail(e)}`));

  res.status(201).json({ protocolo });
  // Produto e foto do pedido, depois de responder (o cliente não espera pelas consultas ao Tiny)
  if (tiny.status === "encontrado")
    completarProdutosTiny(ocorrenciaId).catch((e) => console.error(`[tiny] produtos de ${protocolo}: ${e?.message}`));
});

type OcConsulta = { id: number; protocolo: string; canal: Canal; tipo: Tipo; status: Status; nome: string; anonimizada: number; criado_em: string; atualizado_em: string };

/** Ocorrência do formulário que bate com protocolo + e-mail (a consulta nunca revela outras). */
function ocDoCliente(protocolo: unknown, email: unknown): OcConsulta | undefined {
  const p = String(protocolo ?? "").trim().toUpperCase().slice(0, 40);
  const e = String(email ?? "").trim().toLowerCase().slice(0, 160);
  if (!p || !e) return undefined;
  return db
    .prepare(
      `SELECT id, protocolo, canal, tipo, status, nome, anonimizada, criado_em, atualizado_em FROM ocorrencias
       WHERE protocolo = ? AND email = ? AND origem = 'formulario'`,
    )
    .get(p, e) as OcConsulta | undefined;
}
const NAO_ENCONTRADO = { erro: "Não encontramos um atendimento com esse protocolo e e-mail." };

app.get("/api/consulta", limiteConsulta, (req, res) => {
  const oc = ocDoCliente(req.query.protocolo, req.query.email);
  if (!oc) return res.status(404).json(NAO_ENCONTRADO);

  const eventos = db
    .prepare("SELECT texto, criado_em, do_cliente FROM eventos WHERE ocorrencia_id = ? AND publico = 1 ORDER BY id")
    .all(oc.id) as { texto: string; criado_em: string; do_cliente: number }[];
  res.json({
    protocolo: oc.protocolo,
    canal: CANAIS[oc.canal],
    tipo: TIPOS[oc.tipo],
    status: oc.status,
    statusTexto: STATUS[oc.status],
    criadoEm: oc.criado_em,
    atualizadoEm: oc.atualizado_em,
    podeResponder: !oc.anonimizada,
    historico: eventos.map((e) => ({ texto: e.texto, criado_em: e.criado_em, cliente: Boolean(e.do_cliente) })),
  });
});

// ---------- Mensagem do cliente pela página de consulta (v1.6.0) ----------
const MAX_FOTOS_POR_OCORRENCIA = 15;
const limiteMensagem = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas mensagens em pouco tempo. Tente novamente mais tarde." },
});
const mensagemSchema = z.object({
  texto: z.string().trim().min(2, "Escreva a sua mensagem.").max(3000, "A mensagem pode ter até 3000 caracteres."),
});

app.post("/api/consulta/mensagem", limiteMensagem, upload.array("fotos", 5), async (req, res) => {
  const arquivos = (req.files as Express.Multer.File[] | undefined) ?? [];
  const limpar = () => arquivos.forEach((f) => fs.rmSync(f.path, { force: true }));

  const oc = ocDoCliente(req.body?.protocolo, req.body?.email);
  if (!oc) { limpar(); return res.status(404).json(NAO_ENCONTRADO); }
  if (oc.anonimizada) { limpar(); return res.status(400).json({ erro: "Este atendimento foi encerrado e os dados removidos. Abra uma nova ocorrência." }); }
  const p = mensagemSchema.safeParse(req.body);
  if (!p.success) { limpar(); return res.status(400).json({ erro: p.error.issues[0]?.message ?? "Mensagem inválida." }); }
  if (!arquivos.every((f) => assinaturaValida(f.path, f.mimetype))) {
    limpar();
    return res.status(400).json({ erro: "Uma das fotos não é uma imagem válida (JPG, PNG ou WebP)." });
  }
  const jaTem = (db.prepare("SELECT COUNT(*) n FROM anexos WHERE ocorrencia_id = ?").get(oc.id) as { n: number }).n;
  if (jaTem + arquivos.length > MAX_FOTOS_POR_OCORRENCIA) {
    limpar();
    return res.status(400).json({ erro: `Cada atendimento aceita até ${MAX_FOTOS_POR_OCORRENCIA} fotos. Você ainda pode enviar ${Math.max(0, MAX_FOTOS_POR_OCORRENCIA - jaTem)}.` });
  }

  const texto = p.data.texto + (arquivos.length ? `\n[${arquivos.length} foto${arquivos.length > 1 ? "s" : ""} anexada${arquivos.length > 1 ? "s" : ""}]` : "");
  // Resposta do cliente reabre o atendimento que estava esperando por ele (ou já resolvido)
  const reabrir = oc.status === "aguardando_cliente" || oc.status === "resolvida";
  try {
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO anexos (ocorrencia_id, arquivo, original, mime, tamanho) VALUES (?,?,?,?,?)");
      for (const f of arquivos) ins.run(oc.id, f.filename, f.originalname.slice(0, 200), f.mimetype, f.size);
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, do_cliente) VALUES (?,?,1,1)").run(oc.id, texto);
      if (reabrir) {
        db.prepare("UPDATE ocorrencias SET status = 'em_analise', resolvida_em = NULL WHERE id = ?").run(oc.id);
        db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico) VALUES (?,?,1)").run(oc.id, `Status atualizado: ${STATUS.em_analise}.`);
      }
      db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(oc.id);
    })();
  } catch (e) {
    limpar();
    console.error("[db] falha ao salvar mensagem do cliente:", e);
    return res.status(500).json({ erro: "Não foi possível enviar agora. Tente novamente em instantes." });
  }

  const resumo = p.data.texto.length > 400 ? p.data.texto.slice(0, 400) + "…" : p.data.texto;
  void enviarTelegram(
    `💬 <b>Cliente respondeu</b> <code>${esc(oc.protocolo)}</code>${reabrir ? " (reaberta)" : ""}\n` +
      `${esc(oc.nome)}${arquivos.length ? ` · ${arquivos.length} foto(s)` : ""}\n\n${esc(resumo)}\n\n` +
      `<a href="${esc(config.publicUrl)}/painel#${encodeURIComponent(oc.protocolo)}">Abrir no painel</a>`,
  );
  void avisarEquipeEmail(`Cliente respondeu ${oc.protocolo}`, [`${oc.nome}${arquivos.length ? ` · ${arquivos.length} foto(s)` : ""}`, resumo], oc.protocolo);
  res.status(201).json({ ok: true });
});

// ---------- Pesquisa de satisfação (v1.6.0) ----------
const limiteAvaliacao = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos." },
});
const PESQUISA_INVALIDA = { erro: "Este link de avaliação não é válido ou já venceu." };

app.get("/api/avaliacao", limiteAvaliacao, (req, res) => {
  const d = dadosDaPesquisa(String(req.query.t ?? ""));
  if (!d) return res.status(404).json(PESQUISA_INVALIDA);
  res.json(d);
});

app.post("/api/avaliacao", limiteAvaliacao, (req, res) => {
  const p = z
    .object({
      t: z.string(),
      nota: z.coerce.number().int().min(1, "Escolha uma nota de 1 a 5.").max(5, "Escolha uma nota de 1 a 5."),
      comentario: z.string().trim().max(1000, "O comentário pode ter até 1000 caracteres.").optional(),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ erro: p.error.issues[0]?.message ?? "Dados inválidos." });
  const r = responderPesquisa(p.data.t, p.data.nota, p.data.comentario);
  if (!r) return res.status(404).json(PESQUISA_INVALIDA);
  res.json(r);
});

// Erros do multer (arquivo grande, muitos arquivos, tipo inválido)
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.message === "TIPO_INVALIDO") {
    return res.status(400).json({ erro: "Envie apenas fotos nos formatos JPG, PNG ou WebP." });
  }
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? "Cada foto pode ter no máximo 5 MB."
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
          ? "Envie no máximo 5 fotos."
          : "Erro no envio dos arquivos.";
    return res.status(400).json({ erro: msg });
  }
  next(err);
});

// ---------- Front estático ----------
app.use(express.static(publicDir, { extensions: ["html"], maxAge: "5m" }));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[erro]", err);
  res.status(500).json({ erro: "Erro interno." });
});
