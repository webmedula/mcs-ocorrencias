import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { avisarEquipeEmail, enviarPesquisa, enviarTelegram, esc, smtpLigado } from "./notify.js";

/** Pesquisa de satisfação (v1.6.0): um e-mail por ocorrência resolvida, respondido em /avaliar.html. */

const VALIDADE_DIAS = 30;
// Não manda pesquisa de algo resolvido há muito tempo (ex.: ao ligar a função ou depois de o SMTP ficar fora)
const JANELA_DIAS = 7;
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

type Pendente = { id: number; protocolo: string; nome: string; email: string };

export async function enviarPesquisasPendentes(): Promise<number> {
  if (!config.pesquisaSatisfacao || !smtpLigado()) return 0;
  const pendentes = db
    .prepare(
      `SELECT o.id, o.protocolo, o.nome, o.email FROM ocorrencias o
       WHERE o.status = 'resolvida' AND o.origem = 'formulario' AND o.anonimizada = 0 AND o.email != ''
         AND o.resolvida_em IS NOT NULL
         AND o.resolvida_em <= datetime('now', ?) AND o.resolvida_em >= datetime('now', ?)
         AND NOT EXISTS (SELECT 1 FROM pesquisas p WHERE p.ocorrencia_id = o.id)
       ORDER BY o.resolvida_em LIMIT 50`,
    )
    .all(`-${Math.round(config.pesquisaHoras * 60)} minutes`, `-${JANELA_DIAS} days`) as Pendente[];
  let enviadas = 0;
  for (const o of pendentes) {
    const token = crypto.randomBytes(24).toString("hex");
    // Grava antes de enviar: se o processo cair no meio, não manda duas vezes
    db.prepare("INSERT INTO pesquisas (ocorrencia_id, token_hash) VALUES (?,?)").run(o.id, sha(token));
    try {
      await enviarPesquisa(o, `${config.publicUrl}/avaliar.html?t=${token}`);
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?, 'Pesquisa de satisfação enviada por e-mail.', 0, 'Sistema')").run(o.id);
      enviadas++;
    } catch (e: any) {
      // Tenta de novo no próximo ciclo (dentro da janela de dias)
      db.prepare("DELETE FROM pesquisas WHERE ocorrencia_id = ?").run(o.id);
      console.error(`[pesquisa] falha ao enviar ${o.protocolo}:`, e?.message);
    }
  }
  return enviadas;
}

type Linha = { ocorrencia_id: number; protocolo: string; nota: number | null; comentario: string | null; anonimizada: number };

function buscar(token: string): Linha | undefined {
  if (!/^[a-f0-9]{48}$/.test(token)) return undefined;
  return db
    .prepare(
      `SELECT p.ocorrencia_id, o.protocolo, p.nota, p.comentario, o.anonimizada FROM pesquisas p
       JOIN ocorrencias o ON o.id = p.ocorrencia_id
       WHERE p.token_hash = ? AND p.enviada_em >= datetime('now', ?)`,
    )
    .get(sha(token), `-${VALIDADE_DIAS} days`) as Linha | undefined;
}

export function dadosDaPesquisa(token: string) {
  const p = buscar(token);
  if (!p || p.anonimizada) return null;
  return { protocolo: p.protocolo, marca: config.brandName, nota: p.nota, comentario: p.comentario ?? "", respondida: p.nota != null };
}

/** Grava (ou corrige) a nota. Nota baixa avisa a equipe na primeira vez que aparece. */
export function responderPesquisa(token: string, nota: number, comentario?: string) {
  const p = buscar(token);
  if (!p || p.anonimizada) return null;
  const novoComentario = comentario === undefined ? p.comentario : comentario || null;
  db.transaction(() => {
    db.prepare("UPDATE pesquisas SET nota = ?, comentario = ?, respondida_em = datetime('now') WHERE ocorrencia_id = ?")
      .run(nota, novoComentario, p.ocorrencia_id);
    if (p.nota !== nota)
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,'Sistema')")
        .run(p.ocorrencia_id, `Cliente avaliou o atendimento: ${nota}/5.`);
  })();
  if (nota <= 2 && (p.nota == null || p.nota > 2)) {
    const link = `${config.publicUrl}/painel#${encodeURIComponent(p.protocolo)}`;
    void enviarTelegram(
      `😟 <b>Avaliação baixa: ${nota}/5</b> · <code>${esc(p.protocolo)}</code>` +
        (novoComentario ? `\n\n${esc(novoComentario.slice(0, 400))}` : "") +
        `\n\n<a href="${esc(link)}">Abrir no painel</a>`,
    );
    void avisarEquipeEmail(`Avaliação baixa (${nota}/5) em ${p.protocolo}`, novoComentario ? [novoComentario] : ["Sem comentário."], p.protocolo);
  }
  return { ok: true, nota, comentario: novoComentario ?? "" };
}
