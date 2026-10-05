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
import { avisarTelegram, enviarConfirmacao, verificarSmtp, descreverErroMail, type OcorrenciaResumo } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const uploadsDir = path.join(config.dataDir, "uploads");

const app = express();
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
app.get("/api/config", (_req, res) => {
  res.json({
    versao: config.version,
    marca: config.brandName,
    emailSuporte: config.supportEmail,
    whatsapp: config.supportWhatsapp,
    privacidadeUrl: config.privacyUrl,
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
  enviarConfirmacao(resumo).catch((e) => console.error(`[mail] FALHA ao enviar ${protocolo} para ${d.email}: ${descreverErroMail(e)}`));

  res.status(201).json({ protocolo });
});

app.get("/api/consulta", limiteConsulta, (req, res) => {
  const protocolo = String(req.query.protocolo ?? "").trim().toUpperCase();
  const email = String(req.query.email ?? "").trim().toLowerCase();
  const naoEncontrado = () =>
    res.status(404).json({ erro: "Não encontramos um atendimento com esse protocolo e e-mail." });
  if (!protocolo || !email) return naoEncontrado();

  const oc = db
    .prepare("SELECT id, protocolo, canal, tipo, status, criado_em, atualizado_em FROM ocorrencias WHERE protocolo = ? AND email = ?")
    .get(protocolo, email) as
    | { id: number; protocolo: string; canal: Canal; tipo: Tipo; status: Status; criado_em: string; atualizado_em: string }
    | undefined;
  if (!oc) return naoEncontrado();

  const eventos = db
    .prepare("SELECT texto, criado_em FROM eventos WHERE ocorrencia_id = ? AND publico = 1 ORDER BY id")
    .all(oc.id);
  res.json({
    protocolo: oc.protocolo,
    canal: CANAIS[oc.canal],
    tipo: TIPOS[oc.tipo],
    status: oc.status,
    statusTexto: STATUS[oc.status],
    criadoEm: oc.criado_em,
    atualizadoEm: oc.atualizado_em,
    historico: eventos,
  });
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

app.listen(config.port, () => {
  verificarSmtp();
  console.log(`Central de Ocorrências v${config.version} em http://localhost:${config.port}`);
  console.log(
    `Tiny: ${config.tinyToken ? "on" : "off"} · Telegram: ${config.telegramToken ? "on" : "off"} · SMTP: ${config.smtpHost ? "on" : "off"}`,
  );
});
