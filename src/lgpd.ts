import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

const uploadsDir = path.join(config.dataDir, "uploads");

function apagarFotos(id: number): void {
  const fotos = db.prepare("SELECT arquivo FROM anexos WHERE ocorrencia_id = ?").all(id) as { arquivo: string }[];
  for (const f of fotos) fs.rmSync(path.join(uploadsDir, path.basename(f.arquivo)), { force: true });
  db.prepare("DELETE FROM anexos WHERE ocorrencia_id = ?").run(id);
}

function bloquearClaim(o: { ml_claim_id: string | null }): void {
  if (o.ml_claim_id) db.prepare("INSERT OR IGNORE INTO ml_ignorados (claim_id) VALUES (?)").run(o.ml_claim_id);
}

/** Remove os dados pessoais mas mantém a ocorrência (para estatísticas). */
export function anonimizar(id: number): void {
  const o = db.prepare("SELECT ml_claim_id FROM ocorrencias WHERE id = ?").get(id) as { ml_claim_id: string | null } | undefined;
  if (!o) return;
  db.transaction(() => {
    apagarFotos(id);
    bloquearClaim(o);
    db.prepare("DELETE FROM ml_mensagens WHERE ocorrencia_id = ?").run(id);
    db.prepare("DELETE FROM alertas_prazo WHERE ocorrencia_id = ?").run(id);
    db.prepare(
      `UPDATE ocorrencias SET nome = 'Anonimizado', email = '', telefone = NULL, ip_hash = NULL, tiny_json = NULL,
         descricao = '[Conteúdo removido a pedido do titular dos dados ou pelo prazo de retenção]', anonimizada = 1,
         atualizado_em = datetime('now') WHERE id = ?`,
    ).run(id);
    db.prepare("UPDATE eventos SET texto = '[conteúdo removido]' WHERE ocorrencia_id = ? AND autor IS NOT NULL AND autor != 'Sistema'").run(id);
    db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?, 'Dados pessoais removidos (anonimização).', 0, 'Sistema')").run(id);
  })();
}

/** Apaga tudo da ocorrência. */
export function excluir(id: number): void {
  const o = db.prepare("SELECT ml_claim_id FROM ocorrencias WHERE id = ?").get(id) as { ml_claim_id: string | null } | undefined;
  if (!o) return;
  db.transaction(() => {
    apagarFotos(id);
    bloquearClaim(o);
    db.prepare("DELETE FROM ml_mensagens WHERE ocorrencia_id = ?").run(id);
    db.prepare("DELETE FROM alertas_prazo WHERE ocorrencia_id = ?").run(id);
    db.prepare("DELETE FROM eventos WHERE ocorrencia_id = ?").run(id);
    db.prepare("DELETE FROM ocorrencias WHERE id = ?").run(id);
  })();
}

/** Cópia legível dos dados de uma ocorrência (direito de acesso do titular). */
export function exportarDados(o: any) {
  const eventos = db.prepare("SELECT texto, publico, autor, criado_em FROM eventos WHERE ocorrencia_id = ? ORDER BY id").all(o.id);
  const anexos = db.prepare("SELECT original, mime, tamanho FROM anexos WHERE ocorrencia_id = ?").all(o.id);
  const mensagens = db.prepare("SELECT remetente, destinatario, texto, data FROM ml_mensagens WHERE ocorrencia_id = ? ORDER BY data, id").all(o.id);
  return {
    gerado_em: new Date().toISOString(),
    protocolo: o.protocolo, canal: o.canal, pedido: o.pedido, tipo: o.tipo, status: o.status, origem: o.origem,
    nome: o.nome, email: o.email, telefone: o.telefone, descricao: o.descricao, criado_em: o.criado_em,
    fotos_enviadas: anexos, historico: eventos, mensagens_mercado_livre: mensagens,
  };
}

/** Rotina diária: anonimiza o que já passou do prazo de retenção (só se RETENCAO_MESES > 0). */
export function aplicarRetencao(): number {
  if (config.retencaoMeses <= 0) return 0;
  const ids = db
    .prepare("SELECT id FROM ocorrencias WHERE anonimizada = 0 AND status = 'resolvida' AND atualizado_em < datetime('now', ?)")
    .all(`-${Math.round(config.retencaoMeses * 30.4)} days`) as { id: number }[];
  for (const { id } of ids) anonimizar(id);
  if (ids.length) console.log(`[lgpd] ${ids.length} ocorrência(s) anonimizada(s) pelo prazo de retenção (${config.retencaoMeses} meses).`);
  return ids.length;
}
