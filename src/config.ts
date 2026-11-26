import "dotenv/config";
import path from "node:path";

const env = process.env;

export const config = {
  version: "1.20.1",
  port: Number(env.PORT ?? 3000),
  // Identidade (exibida no front via /api/config)
  brandName: env.BRAND_NAME ?? "Sua Empresa",
  supportEmail: env.SUPPORT_EMAIL ?? "",
  supportWhatsapp: env.SUPPORT_WHATSAPP ?? "",
  // Política de privacidade: se PRIVACY_URL ficar vazio, usa a página /privacidade.html desta própria Central
  privacyUrl: env.PRIVACY_URL?.trim() || `${env.PUBLIC_URL ?? "http://localhost:3000"}/privacidade.html`,
  privacyControlador: env.PRIVACY_CONTROLADOR ?? "",
  // CNPJ da MCS Brasil por padrão (v1.15.0); PRIVACY_CNPJ com valor troca, e vazio não apaga mais o CNPJ
  privacyCnpj: env.PRIVACY_CNPJ?.trim() || "39.501.387/0001-03",
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
  // Custo do produto na conta da venda (v1.10.0): "custo" = preço de custo do cadastro; "medio" = custo médio
  tinyCusto: (env.TINY_CUSTO === "medio" ? "medio" : "custo") as "custo" | "medio",
  // Ficha de lucro do ml-analytics (v1.13.0): o custo do produto vem de lá, o mesmo número das promoções e do
  // Gerente IA. Vazio = a Central calcula sozinha pelo Tiny, como antes. A chave é o SERVICE_API_KEY do analytics.
  analyticsBaseUrl: (env.ANALYTICS_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  analyticsApiKey: (env.ANALYTICS_API_KEY ?? "").trim(),
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
  // v1.16.0: e-mail ao cliente quando a ocorrência do formulário é marcada como resolvida
  avisoResolvida: (env.AVISO_RESOLVIDA ?? "true").trim().toLowerCase() !== "false",
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
  // Faturamento do ML (v1.9.0): páginas de 1000 lançamentos baixadas por rodada; 0 desliga
  faturamentoPaginas: Math.max(0, Number(env.FATURAMENTO_PAGINAS ?? 20)),
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

// Devoluções do Mercado Livre (v1.8.0)
export const STATUS_DEVOLUCAO = {
  aguardando_liberacao: "Aguardando liberação",
  liberada: "Liberada, aguardando envio",
  em_transito: "Em trânsito",
  nao_entregue: "Não chegou",
  recebida: "Recebida, a conferir",
  conferida: "Conferida",
  em_contestacao: "Em contestação",
  encerrada: "Encerrada",
  cancelada: "Cancelada",
} as const;

// Estado em que o produto voltou (conferência feita pelo colaborador)
export const CONFERENCIAS = {
  ok: "Voltou em bom estado",
  danificado: "Voltou danificado",
  incompleto: "Voltou incompleto",
  diferente: "Voltou um produto diferente",
  sem_produto: "A caixa veio sem o produto",
  outro: "Outro problema",
} as const;

// v1.20.1: como voltou cada unidade do pedido (itens do Tiny, kits abertos nos componentes)
export const ESTADOS_UNIDADE = {
  ok: "Voltou em bom estado",
  defeito: "Voltou com defeito ou danificada",
  nao_voltou: "Não voltou",
  nao_devolvida: "Não fazia parte da devolução",
} as const;
export type EstadoUnidade = keyof typeof ESTADOS_UNIDADE;
/** Unidades cujo custo entra como produto perdido. */
export const UNIDADE_COM_PERDA = new Set<string>(["defeito", "nao_voltou"]);

export type StatusDevolucao = keyof typeof STATUS_DEVOLUCAO;
export type Conferencia = keyof typeof CONFERENCIAS;
