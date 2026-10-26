import "dotenv/config";
import path from "node:path";

const env = process.env;

export const config = {
  version: "1.6.0",
  port: Number(env.PORT ?? 3000),
  // Identidade (exibida no front via /api/config)
  brandName: env.BRAND_NAME ?? "Sua Empresa",
  supportEmail: env.SUPPORT_EMAIL ?? "",
  supportWhatsapp: env.SUPPORT_WHATSAPP ?? "",
  // Política de privacidade: se PRIVACY_URL ficar vazio, usa a página /privacidade.html desta própria Central
  privacyUrl: env.PRIVACY_URL?.trim() || `${env.PUBLIC_URL ?? "http://localhost:3000"}/privacidade.html`,
  privacyControlador: env.PRIVACY_CONTROLADOR ?? "",
  privacyCnpj: env.PRIVACY_CNPJ ?? "",
  privacyContato: env.PRIVACY_CONTATO ?? env.SUPPORT_EMAIL ?? "",
  // 0 = não apaga sozinho. Acima de 0: anonimiza ocorrências resolvidas há mais de N meses
  retencaoMeses: Math.max(0, Number(env.RETENCAO_MESES ?? 0)),
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
  // Rotinas (v1.3.0): fuso, hora do resumo diário (0-23; vazio/-1 = desligado), cópias de backup guardadas
  timezone: env.TZ_LOCAL ?? "America/Sao_Paulo",
  resumoHora: env.RESUMO_HORA === undefined || env.RESUMO_HORA === "" ? 8 : Number(env.RESUMO_HORA),
  backupManter: Math.max(1, Number(env.BACKUP_MANTER ?? 14)),
  // Pesquisa de satisfação (v1.6.0): e-mail ao cliente N horas depois de a ocorrência ser resolvida
  pesquisaSatisfacao: (env.PESQUISA_SATISFACAO ?? "true").trim().toLowerCase() !== "false",
  pesquisaHoras: Math.max(0, Number(env.PESQUISA_HORAS ?? 2) || 0),
  publicUrl: env.PUBLIC_URL ?? "http://localhost:3000",
  // Painel interno: o primeiro gerente é criado a partir destas variáveis (só se ainda não houver usuários).
  adminEmail: (env.ADMIN_EMAIL ?? "").trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD ?? "",
  adminName: env.ADMIN_NAME ?? "Gerente",
  // Duração do login no painel, em horas
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  // Mercado Livre (reclamações). Vazio = integração desligada.
  mlClientId: (env.ML_CLIENT_ID ?? "").trim(),
  mlClientSecret: (env.ML_CLIENT_SECRET ?? "").trim(),
  mlRedirectUri: (env.ML_REDIRECT_URI ?? "").trim() || `${env.PUBLIC_URL ?? "http://localhost:3000"}/api/ml/callback`,
  mlPollMinutes: Math.max(1, Number(env.ML_POLL_MINUTES ?? 3)),
  mlAuthBase: env.ML_AUTH_BASE ?? "https://auth.mercadolivre.com.br",
  mlApiBase: env.ML_API_BASE ?? "https://api.mercadolibre.com",
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

// Como a ocorrência foi resolvida (v1.6.0)
export const DESFECHOS = {
  reembolso_total: "Reembolso total",
  reembolso_parcial: "Reembolso parcial",
  reenvio: "Reenvio do produto",
  troca: "Troca",
  devolucao: "Devolução",
  cupom: "Cupom ou desconto",
  orientacao: "Orientação ao cliente",
  sem_acao: "Sem ação (improcedente)",
} as const;

export type Canal = keyof typeof CANAIS;
export type Tipo = keyof typeof TIPOS;
export type Status = keyof typeof STATUS;
export type Desfecho = keyof typeof DESFECHOS;
