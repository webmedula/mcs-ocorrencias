import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { db } from "./db.js";

export type Papel = "gerente" | "atendimento";

/** Quem está agindo: uma pessoa logada ou o Gerente (IA) com chave de API. */
export type Ator =
  | { tipo: "usuario"; id: number; nome: string; email: string; papel: Papel }
  | { tipo: "ia"; id: number; nome: string };

declare module "express-serve-static-core" {
  interface Request {
    ator?: Ator;
  }
}

// ---------- Senhas (scrypt, sem dependências extras) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashSenha(senha: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function conferirSenha(senha: string, guardado: string): boolean {
  const [alg, saltB64, hashB64] = guardado.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, "base64");
  const h = crypto.scryptSync(senha, Buffer.from(saltB64, "base64"), esperado.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(h, esperado);
}
// Hash descartável: gasta o mesmo tempo quando o e-mail não existe (evita descobrir contas pelo tempo de resposta)
const HASH_FALSO = hashSenha(crypto.randomBytes(8).toString("hex"));
export const gastarTempo = (senha: string) => conferirSenha(senha, HASH_FALSO);

export const senhaForte = (s: string) => typeof s === "string" && s.length >= 10 && s.length <= 200;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- Sessões (cookie) ----------
const COOKIE = "mcs_sessao";
const cookieSeguro = config.publicUrl.startsWith("https://");

function lerCookie(req: Request, nome: string): string | null {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

export function criarSessao(res: Response, usuarioId: number): void {
  const token = crypto.randomBytes(32).toString("hex");
  const horas = config.sessionHours > 0 ? config.sessionHours : 12;
  db.prepare("INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?,?, datetime('now', ?))").run(
    sha256(token), usuarioId, `+${Math.round(horas * 60)} minutes`,
  );
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: "strict", secure: cookieSeguro, path: "/", maxAge: horas * 3600 * 1000,
  });
}

export function encerrarSessao(req: Request, res: Response): void {
  const t = lerCookie(req, COOKIE);
  if (t) db.prepare("DELETE FROM sessoes WHERE token_hash = ?").run(sha256(t));
  res.clearCookie(COOKIE, { path: "/" });
}

export function limparSessoesVencidas(): void {
  db.prepare("DELETE FROM sessoes WHERE expira_em < datetime('now')").run();
}

// ---------- Chaves de API (Gerente IA) ----------
export function gerarChave(): { token: string; prefixo: string; hash: string } {
  const token = "mcsia_" + crypto.randomBytes(32).toString("hex");
  return { token, prefixo: token.slice(0, 12), hash: sha256(token) };
}

// ---------- Middleware ----------
/** Identifica o ator: chave de API (Authorization: Bearer) ou cookie de sessão. */
export function identificar(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const c = db
      .prepare("SELECT id, nome FROM chaves_api WHERE token_hash = ? AND ativa = 1")
      .get(sha256(token)) as { id: number; nome: string } | undefined;
    if (c) {
      db.prepare("UPDATE chaves_api SET ultimo_uso = datetime('now') WHERE id = ?").run(c.id);
      req.ator = { tipo: "ia", id: c.id, nome: "Gerente IA" };
    }
    return next();
  }
  const t = lerCookie(req, COOKIE);
  if (t) {
    const u = db
      .prepare(
        `SELECT u.id, u.nome, u.email, u.papel FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = ? AND s.expira_em > datetime('now') AND u.ativo = 1`,
      )
      .get(sha256(t)) as { id: number; nome: string; email: string; papel: Papel } | undefined;
    if (u) req.ator = { tipo: "usuario", ...u };
  }
  next();
}

export function exigirLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.ator) {
    res.status(401).json({ erro: "Não autenticado." });
    return;
  }
  // Defesa extra contra CSRF para quem usa cookie: exige um cabeçalho que outro site não consegue enviar.
  if (req.ator.tipo === "usuario" && !["GET", "HEAD"].includes(req.method) && req.headers["x-requested-with"] !== "painel") {
    res.status(403).json({ erro: "Requisição inválida." });
    return;
  }
  next();
}

export const soPessoas = (req: Request, res: Response, next: NextFunction): void => {
  if (req.ator?.tipo !== "usuario") {
    res.status(403).json({ erro: "Esta ação é só para usuários do painel." });
    return;
  }
  next();
};

export const soGerente = (req: Request, res: Response, next: NextFunction): void => {
  if (req.ator?.tipo !== "usuario" || req.ator.papel !== "gerente") {
    res.status(403).json({ erro: "Apenas o gerente pode fazer isso." });
    return;
  }
  next();
};

/** Nome que fica no histórico ("Maria (atendimento)" / "Gerente IA"). */
export function nomeDoAtor(a: Ator): string {
  return a.tipo === "ia" ? "Gerente IA" : a.nome;
}

/** Cria o primeiro gerente a partir de ADMIN_EMAIL/ADMIN_PASSWORD, se ainda não houver nenhum usuário. */
export function garantirPrimeiroGerente(): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM usuarios").get() as { n: number };
  if (n > 0) return;
  if (!config.adminEmail || !config.adminPassword) {
    console.log("[painel] Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro gerente.");
    return;
  }
  if (!senhaForte(config.adminPassword)) {
    console.error("[painel] ADMIN_PASSWORD precisa ter pelo menos 10 caracteres. Primeiro gerente NÃO criado.");
    return;
  }
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?,?,?, 'gerente')").run(
    config.adminName, config.adminEmail, hashSenha(config.adminPassword),
  );
  console.log(`[painel] Primeiro gerente criado: ${config.adminEmail}. Já pode remover ADMIN_PASSWORD das variáveis.`);
}
