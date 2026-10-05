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
  await t.sendMail({
    from: config.mailFrom,
    to: o.email,
    subject: `Protocolo ${o.protocolo} — recebemos sua ocorrência`,
    html,
    text: `Recebemos sua ocorrência. Protocolo: ${o.protocolo}. Acompanhe em: ${link}`,
  });
}
