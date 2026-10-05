import "dotenv/config";
import path from "node:path";

const env = process.env;

export const config = {
  version: "1.0.6",
  port: Number(env.PORT ?? 3000),
  // Identidade (exibida no front via /api/config)
  brandName: env.BRAND_NAME ?? "Sua Empresa",
  supportEmail: env.SUPPORT_EMAIL ?? "",
  supportWhatsapp: env.SUPPORT_WHATSAPP ?? "",
  privacyUrl: env.PRIVACY_URL ?? "",
  protocolPrefix: env.PROTOCOL_PREFIX ?? "MCS",
  // Dados
  dataDir: path.resolve(env.DATA_DIR ?? "./data"),
  ipSalt: env.IP_SALT ?? "troque-este-salt",
  trustProxy: env.TRUST_PROXY ?? "1",
  // Tiny (API v2 por token). Vazio = integração desligada.
  tinyToken: env.TINY_TOKEN ?? "",
  tinyBaseUrl: env.TINY_BASE_URL ?? "https://api.tiny.com.br/api2",
  // Telegram. Vazio = aviso desligado.
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  // SMTP. Sem SMTP_HOST, o e-mail só é registrado no log.
  smtpHost: env.SMTP_HOST ?? "",
  smtpPort: Number(env.SMTP_PORT ?? 587),
  smtpSecure: env.SMTP_SECURE === "true",
  smtpUser: env.SMTP_USER ?? "",
  smtpPass: env.SMTP_PASS ?? "",
  // Opcional: nome que consta no certificado do servidor (ver DEPLOY-EASYPANEL.md)
  smtpTlsServername: env.SMTP_TLS_SERVERNAME ?? "",
  // Remetente: usa MAIL_FROM; se vazio, usa "<BRAND_NAME> <SMTP_USER>" (nunca um endereço de exemplo).
  mailFrom:
    env.MAIL_FROM?.trim() ||
    ((env.SMTP_USER ?? "").includes("@")
      ? `${env.BRAND_NAME ?? "Central de Ocorrências"} <${env.SMTP_USER}>`
      : "Central de Ocorrências <no-reply@example.com>"),
  mailFromDefinido: Boolean(env.MAIL_FROM?.trim()),
  publicUrl: env.PUBLIC_URL ?? "http://localhost:3000",
};

export const CANAIS = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  loja_propria: "Loja própria",
} as const;

export const TIPOS = {
  atraso: "Atraso na entrega",
  nao_recebido: "Produto não recebido",
  errado: "Produto errado",
  defeito: "Produto com defeito ou danificado",
  diferente_anuncio: "Diferente do anunciado",
  troca_devolucao: "Troca ou devolução",
  cobranca: "Cobrança ou nota fiscal",
  outro: "Outro assunto",
} as const;

export const STATUS = {
  nova: "Recebida",
  em_analise: "Em análise",
  aguardando_cliente: "Aguardando você",
  resolvida: "Resolvida",
} as const;

export type Canal = keyof typeof CANAIS;
export type Tipo = keyof typeof TIPOS;
export type Status = keyof typeof STATUS;
