import nodemailer from "nodemailer";
import { config, CANAIS, TIPOS, type Canal, type Tipo } from "./config.js";
import type { TinyResultado } from "./tiny.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface OcorrenciaResumo {
  protocolo: string;
  canal: Canal;
  tipo: Tipo;
  pedido: string;
  nome: string;
  email: string;
  telefone?: string | null;
  descricao: string;
  qtdFotos: number;
  tiny: TinyResultado;
}

// ---------- Telegram ----------
export async function avisarTelegram(o: OcorrenciaResumo): Promise<void> {
  if (!config.telegramToken || !config.telegramChatId) return;

  let tinyLinha = "Tiny: integração desligada";
  if (o.tiny.status === "encontrado") {
    const p = o.tiny.pedido;
    tinyLinha = `Tiny: pedido #${esc(p.numero)} · ${esc(p.situacao)} · R$ ${esc(p.valor)}`;
  } else if (o.tiny.status === "nao_encontrado") {
    tinyLinha = "Tiny: ⚠️ pedido não encontrado";
  } else if (o.tiny.status === "erro") {
    tinyLinha = "Tiny: ⚠️ falha na consulta";
  }

  const desc = o.descricao.length > 500 ? o.descricao.slice(0, 500) + "…" : o.descricao;
  const texto = [
    `🆕 <b>Nova ocorrência</b> <code>${esc(o.protocolo)}</code>`,
    `Canal: <b>${esc(CANAIS[o.canal])}</b> · Pedido: <code>${esc(o.pedido)}</code>`,
    `Tipo: ${esc(TIPOS[o.tipo])}`,
    `Cliente: ${esc(o.nome)} · ${esc(o.email)}${o.telefone ? " · " + esc(o.telefone) : ""}`,
    tinyLinha,
    `Fotos: ${o.qtdFotos}`,
    "",
    esc(desc),
  ].join("\n");

  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: texto,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
}

// ---------- E-mail ----------
let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!config.smtpHost) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    tls: config.smtpTlsServername ? { servername: config.smtpTlsServername } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  return transporter;
}

/** Extrai o endereço de "Nome <a@b.c>" ou "a@b.c". */
export function enderecoDe(valor: string): string {
  const m = valor.match(/<([^>]+)>/);
  return (m ? m[1] : valor).trim().toLowerCase();
}
const dominioDe = (email: string) => email.split("@")[1] ?? "";

/** Descreve um erro de SMTP de forma útil para o log (código + comando + mensagem). */
export function descreverErroMail(e: any): string {
  const partes = [e?.code, e?.command ? `comando=${e.command}` : "", e?.responseCode ? `resposta=${e.responseCode}` : "", e?.message]
    .filter(Boolean);
  return partes.join(" · ");
}

/** Testa conexão, TLS e login no SMTP ao iniciar. Nunca lança. */
export async function verificarSmtp(): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log("[mail] SMTP desligado (SMTP_HOST vazio): confirmações por e-mail não serão enviadas.");
    return;
  }
  const alvo = `${config.smtpHost}:${config.smtpPort} (${config.smtpSecure ? "TLS direto" : "STARTTLS"})`;
  const remetente = enderecoDe(config.mailFrom);
  console.log(`[mail] Remetente (From): ${config.mailFrom}${config.mailFromDefinido ? "" : "  (MAIL_FROM não definido; usando o usuário do SMTP)"}`);
  if (/example\.(com|org|net)$/i.test(remetente)) {
    console.error("[mail] ATENÇÃO: o remetente é um endereço de exemplo. Defina MAIL_FROM com um endereço real do seu domínio, senão os destinos recusam a mensagem.");
  } else if (config.smtpUser.includes("@") && dominioDe(remetente) !== dominioDe(config.smtpUser.toLowerCase())) {
    console.error(`[mail] ATENÇÃO: o domínio do remetente (${dominioDe(remetente)}) é diferente do domínio do login SMTP (${dominioDe(config.smtpUser.toLowerCase())}). Isso costuma causar rejeição ou spam.`);
  }
  try {
    await t.verify();
    console.log(`[mail] SMTP verificado: conexão, TLS e login OK em ${alvo}`);
  } catch (e: any) {
    console.error(`[mail] FALHA ao verificar SMTP em ${alvo}: ${descreverErroMail(e)}`);
    if (/altnames|certificate/i.test(String(e?.message))) {
      console.error("[mail] Dica: defina SMTP_TLS_SERVERNAME com o nome que aparece no erro de certificado.");
    } else if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|ENETUNREACH/i.test(String(e?.code))) {
      console.error("[mail] Dica: a porta pode estar bloqueada no VPS. Teste SMTP_PORT=587 e SMTP_SECURE=false.");
    } else if (/EAUTH/i.test(String(e?.code))) {
      console.error("[mail] Dica: confira SMTP_USER e SMTP_PASS (a senha da conta de e-mail).");
    }
  }
}

export async function enviarConfirmacao(o: OcorrenciaResumo): Promise<void> {
  const link = `${config.publicUrl}/consulta.html?protocolo=${encodeURIComponent(o.protocolo)}`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1b1f23">
    <h2 style="margin-bottom:4px">${esc(config.brandName)}</h2>
    <p>Olá, ${esc(o.nome)}. Recebemos a sua ocorrência.</p>
    <p style="font-size:13px;color:#555;margin:0">Seu protocolo</p>
    <p style="font-size:24px;font-weight:bold;letter-spacing:1px;margin:4px 0 16px">${esc(o.protocolo)}</p>
    <p><b>Canal:</b> ${esc(CANAIS[o.canal])}<br>
       <b>Pedido:</b> ${esc(o.pedido)}<br>
       <b>Assunto:</b> ${esc(TIPOS[o.tipo])}</p>
    <p>Vamos analisar e responder neste e-mail${o.telefone ? " ou pelo telefone informado" : ""}.
       Guarde o protocolo: ele identifica o seu atendimento.</p>
    <p><a href="${esc(link)}" style="background:#1b5e8f;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Acompanhar atendimento</a></p>
    <p style="font-size:12px;color:#777">Se a compra foi feita em um marketplace, mantenha também a reclamação aberta na plataforma, se existir.</p>
  </div>`;

  const t = getTransporter();
  if (!t) {
    console.log(`[mail] SMTP não configurado; confirmação de ${o.protocolo} para ${o.email} NÃO enviada.`);
    return;
  }
  // Remetente do envelope (Return-Path) = conta autenticada: as devoluções voltam para uma caixa real.
  const envelopeFrom = config.smtpUser.includes("@") ? config.smtpUser : enderecoDe(config.mailFrom);
  const info = await t.sendMail({
    from: config.mailFrom,
    // Respostas do cliente vão para a caixa de atendimento (o remetente pode ser de outro domínio, ex.: Resend)
    ...(config.supportEmail.includes("@") ? { replyTo: config.supportEmail } : {}),
    envelope: { from: envelopeFrom, to: o.email },
    to: o.email,
    subject: `Protocolo ${o.protocolo} — recebemos sua ocorrência`,
    html,
    text: `Recebemos sua ocorrência. Protocolo: ${o.protocolo}. Acompanhe em: ${link}`,
  });
  console.log(
    `[mail] enviado ${o.protocolo} para ${o.email} · aceitos=${JSON.stringify(info.accepted)} recusados=${JSON.stringify(info.rejected)} · resposta="${info.response}" · from="${config.mailFrom}" envelope=${envelopeFrom}`,
  );
}
