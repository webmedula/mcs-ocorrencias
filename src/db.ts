import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.join(config.dataDir, "uploads"), { recursive: true });

export const db = new Database(path.join(config.dataDir, "ocorrencias.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS ocorrencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocolo TEXT NOT NULL UNIQUE,
  canal TEXT NOT NULL,
  pedido TEXT NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT,
  status TEXT NOT NULL DEFAULT 'nova',
  tiny_status TEXT NOT NULL DEFAULT 'desligado',
  tiny_json TEXT,
  ip_hash TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oc_email ON ocorrencias(email);
CREATE INDEX IF NOT EXISTS idx_oc_status ON ocorrencias(status);

CREATE TABLE IF NOT EXISTS anexos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  arquivo TEXT NOT NULL,
  original TEXT NOT NULL,
  mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  publico INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- v1.2.0: painel interno ----------
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('gerente','atendimento')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_login TEXT
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chaves_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ativa INTEGER NOT NULL DEFAULT 1,
  criado_por TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_uso TEXT
);
`);

// Quem fez cada evento do histórico (nulo = o próprio cliente / sistema)
const colunasEventos = (db.prepare("PRAGMA table_info(eventos)").all() as { name: string }[]).map((c) => c.name);
if (!colunasEventos.includes("autor")) db.exec("ALTER TABLE eventos ADD COLUMN autor TEXT");

// ---------- v1.2.0: reclamações do Mercado Livre ----------
const colunasOc = (db.prepare("PRAGMA table_info(ocorrencias)").all() as { name: string }[]).map((c) => c.name);
if (!colunasOc.includes("origem")) db.exec("ALTER TABLE ocorrencias ADD COLUMN origem TEXT NOT NULL DEFAULT 'formulario'");
if (!colunasOc.includes("ml_claim_id")) db.exec("ALTER TABLE ocorrencias ADD COLUMN ml_claim_id TEXT");
if (!colunasOc.includes("ml_json")) db.exec("ALTER TABLE ocorrencias ADD COLUMN ml_json TEXT");
if (!colunasOc.includes("anonimizada")) db.exec("ALTER TABLE ocorrencias ADD COLUMN anonimizada INTEGER NOT NULL DEFAULT 0");
if (!colunasOc.includes("produto_json")) db.exec("ALTER TABLE ocorrencias ADD COLUMN produto_json TEXT");
if (!colunasOc.includes("prazo_em")) db.exec("ALTER TABLE ocorrencias ADD COLUMN prazo_em TEXT");
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_oc_claim ON ocorrencias(ml_claim_id) WHERE ml_claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oc_origem ON ocorrencias(origem);

CREATE TABLE IF NOT EXISTS ml_conexao (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  nickname TEXT,
  access_enc TEXT NOT NULL,
  refresh_enc TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  scope TEXT,
  conectado_em TEXT NOT NULL DEFAULT (datetime('now')),
  ultima_sync TEXT,
  ultimo_erro TEXT
);

CREATE TABLE IF NOT EXISTS ml_estados (
  state TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ml_mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  chave TEXT NOT NULL UNIQUE,
  remetente TEXT NOT NULL,
  destinatario TEXT,
  texto TEXT NOT NULL,
  anexos INTEGER NOT NULL DEFAULT 0,
  autor TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlmsg_oc ON ml_mensagens(ocorrencia_id);

CREATE TABLE IF NOT EXISTS ml_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  texto_hash TEXT NOT NULL,
  autor TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v1.3.0
CREATE TABLE IF NOT EXISTS redefinicoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  usado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modelos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alertas_prazo (
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  limiar INTEGER NOT NULL,
  prazo_em TEXT NOT NULL,
  enviado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ocorrencia_id, limiar, prazo_em)
);

CREATE TABLE IF NOT EXISTS rotinas_estado (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`);

// Modelos de resposta iniciais (só na primeira vez)
if ((db.prepare("SELECT COUNT(*) AS n FROM modelos").get() as { n: number }).n === 0) {
  const ins = db.prepare("INSERT INTO modelos (titulo, texto) VALUES (?, ?)");
  ins.run("Recebemos e estamos analisando", "Olá, {nome}! Recebemos a sua ocorrência {protocolo} e já estamos analisando o pedido {pedido}. Retornamos em breve com uma solução.");
  ins.run("Pedir fotos do produto", "Olá, {nome}! Para avançar com o pedido {pedido}, pode nos enviar fotos do produto e da embalagem, mostrando o problema? Agradecemos a ajuda.");
  ins.run("Novo envio / troca autorizada", "Olá, {nome}! Vamos resolver: enviaremos um novo produto referente ao pedido {pedido}. Assim que for despachado, enviaremos o rastreio. Obrigado pela paciência.");
  ins.run("Encerramento", "Olá, {nome}! Consideramos a ocorrência {protocolo} resolvida. Se ainda houver algo pendente, é só responder por aqui. Obrigado!");
}

// v1.4.0
const colunasUsr = (db.prepare("PRAGMA table_info(usuarios)").all() as { name: string }[]).map((c) => c.name);
if (!colunasUsr.includes("avisar_email")) db.exec("ALTER TABLE usuarios ADD COLUMN avisar_email INTEGER NOT NULL DEFAULT 0");
db.exec(`
CREATE TABLE IF NOT EXISTS registro (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  usuario_id INTEGER,
  email TEXT,
  detalhe TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_registro_tipo ON registro(tipo, criado_em);
-- Reclamações do ML que foram apagadas/anonimizadas a pedido do titular: não voltam na sincronização
CREATE TABLE IF NOT EXISTS ml_ignorados (claim_id TEXT PRIMARY KEY, criado_em TEXT NOT NULL DEFAULT (datetime('now')));
`);

// ---------- v1.6.0: mensagens do cliente, desfecho e pesquisa de satisfação ----------
const colunasOc16 = (db.prepare("PRAGMA table_info(ocorrencias)").all() as { name: string }[]).map((c) => c.name);
if (!colunasOc16.includes("desfecho")) db.exec("ALTER TABLE ocorrencias ADD COLUMN desfecho TEXT");
if (!colunasOc16.includes("custo_centavos")) db.exec("ALTER TABLE ocorrencias ADD COLUMN custo_centavos INTEGER");
if (!colunasOc16.includes("resolvida_em")) db.exec("ALTER TABLE ocorrencias ADD COLUMN resolvida_em TEXT");
const colunasEv16 = (db.prepare("PRAGMA table_info(eventos)").all() as { name: string }[]).map((c) => c.name);
// Mensagem escrita pelo próprio cliente na página de consulta
if (!colunasEv16.includes("do_cliente")) db.exec("ALTER TABLE eventos ADD COLUMN do_cliente INTEGER NOT NULL DEFAULT 0");
db.exec(`
CREATE TABLE IF NOT EXISTS pesquisas (
  ocorrencia_id INTEGER PRIMARY KEY REFERENCES ocorrencias(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  enviada_em TEXT NOT NULL DEFAULT (datetime('now')),
  nota INTEGER CHECK (nota BETWEEN 1 AND 5),
  comentario TEXT,
  respondida_em TEXT
);
`);
