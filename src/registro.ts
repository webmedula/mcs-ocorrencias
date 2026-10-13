import type { Request } from "express";
import { db } from "./db.js";
import { enviarTelegram, esc } from "./notify.js";
import { config } from "./config.js";

/** Registro de atividades sensíveis (logins, trocas de senha, exclusões…). Nunca lança. */
export function registrar(
  tipo: string,
  o: { usuarioId?: number | null; email?: string | null; detalhe?: string | null; req?: Request } = {},
): void {
  try {
    db.prepare("INSERT INTO registro (tipo, usuario_id, email, detalhe, ip) VALUES (?,?,?,?,?)").run(
      tipo, o.usuarioId ?? null, o.email ?? null, o.detalhe ?? null, o.req ? String(o.req.ip ?? "").slice(0, 64) : null,
    );
  } catch (e: any) {
    console.error("[registro]", e?.message);
  }
}

/** Depois de um login válido: avisa no Telegram se veio de um IP que essa conta não usava há 90 dias. */
export function checarLoginNovo(u: { id: number; nome: string; email: string }, req: Request): void {
  const ip = String(req.ip ?? "");
  const jaTeve = db.prepare("SELECT COUNT(*) n FROM registro WHERE tipo = 'login_ok' AND usuario_id = ?").get(u.id) as { n: number };
  const igual = db
    .prepare("SELECT 1 FROM registro WHERE tipo = 'login_ok' AND usuario_id = ? AND ip = ? AND criado_em > datetime('now','-90 days') LIMIT 1")
    .get(u.id, ip);
  if (jaTeve.n > 0 && !igual && ip) {
    registrar("login_novo_ip", { usuarioId: u.id, email: u.email, detalhe: "Acesso de um IP novo", req });
    void enviarTelegram(`🔐 <b>Acesso ao painel de um IP novo</b>\n${esc(u.nome)} (${esc(u.email)}) · IP ${esc(ip)}\nSe não foi essa pessoa, desative a conta em Equipe e troque a senha.`);
  }
}

/** Depois de uma falha: 5 erros em 15 min na mesma conta existente geram um aviso (no máx. 1 a cada 15 min). */
export function checarFalhas(email: string): void {
  const n = (db.prepare("SELECT COUNT(*) n FROM registro WHERE tipo = 'login_falha' AND email = ? AND criado_em > datetime('now','-15 minutes')").get(email) as { n: number }).n;
  if (n < 5) return;
  const ja = db.prepare("SELECT 1 FROM registro WHERE tipo = 'alerta_falhas' AND email = ? AND criado_em > datetime('now','-15 minutes')").get(email);
  if (ja) return;
  registrar("alerta_falhas", { email, detalhe: `${n} tentativas erradas em 15 min` });
  void enviarTelegram(`⚠️ <b>Várias tentativas de login erradas</b> na conta ${esc(email)} (${n} em 15 min).\n${esc(config.publicUrl)}/painel`);
}
