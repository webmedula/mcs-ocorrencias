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

// ---------- v1.1.0: painel interno ----------
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

