import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { avisarEquipeEmail, enviarTelegram, esc } from "./notify.js";
import { aplicarRetencao } from "./lgpd.js";
import { enviarPesquisasPendentes } from "./pesquisa.js";

/** Rotinas automáticas (v1.3.0): alerta de prazo do Mercado Livre, resumo diário e backup do banco.
 *  v1.6.0: pesquisa de satisfação das ocorrências resolvidas. */

export const pastaBackups = path.join(config.dataDir, "backups");

function agoraLocal(): { data: string; hora: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t: string) => f.find((x) => x.type === t)?.value ?? "";
  return { data: `${g("year")}-${g("month")}-${g("day")}`, hora: Number(g("hour")) };
}

const estado = (chave: string) =>
  (db.prepare("SELECT valor FROM rotinas_estado WHERE chave = ?").get(chave) as { valor: string } | undefined)?.valor;
const gravarEstado = (chave: string, valor: string) =>
  db.prepare("INSERT INTO rotinas_estado (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(chave, valor);

const link = (protocolo: string) => `${config.publicUrl}/painel#${protocolo}`;

// ---------- Alerta de prazo (Mercado Livre) ----------
const LIMIARES = [24, 6]; // horas restantes

export async function alertarPrazos(): Promise<number> {
  const linhas = db
    .prepare(
      `SELECT id, protocolo, nome, pedido, prazo_em, (julianday(prazo_em) - julianday('now')) * 24 AS horas
       FROM ocorrencias
       WHERE origem = 'ml' AND prazo_em IS NOT NULL AND status != 'resolvida'
         AND julianday(prazo_em) > julianday('now') AND (julianday(prazo_em) - julianday('now')) * 24 <= ?`,
    )
    .all(Math.max(...LIMIARES)) as { id: number; protocolo: string; nome: string; pedido: string; prazo_em: string; horas: number }[];
  let enviados = 0;
  for (const o of linhas) {
    // Só o limiar mais apertado que já foi atingido (evita dois avisos de uma vez)
    const limiar = [...LIMIARES].sort((a, b) => a - b).find((l) => o.horas <= l)!;
    const ja = db.prepare("SELECT 1 FROM alertas_prazo WHERE ocorrencia_id = ? AND limiar <= ? AND prazo_em = ?").get(o.id, limiar, o.prazo_em);
    if (ja) continue;
    db.prepare("INSERT OR IGNORE INTO alertas_prazo (ocorrencia_id, limiar, prazo_em) VALUES (?,?,?)").run(o.id, limiar, o.prazo_em);
    const h = Math.max(1, Math.round(o.horas));
    await enviarTelegram(
      `⏰ <b>Prazo no Mercado Livre: faltam ~${h} h</b>\n` +
        `Reclamação ${esc(o.protocolo)} · pedido ${esc(o.pedido)} · ${esc(o.nome)}\n` +
        `<a href="${esc(link(o.protocolo))}">Abrir no painel</a>`,
    );
    void avisarEquipeEmail(`Prazo no Mercado Livre: faltam ~${h} h`, [`Reclamação ${o.protocolo} · pedido ${o.pedido} · ${o.nome}`], o.protocolo);
    enviados++;
  }
  return enviados;
}

// ---------- Resumo diário ----------
export function montarResumo() {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    novas: n("SELECT COUNT(*) n FROM ocorrencias WHERE status = 'nova'"),
    emAnalise: n("SELECT COUNT(*) n FROM ocorrencias WHERE status = 'em_analise'"),
    aguardando: n("SELECT COUNT(*) n FROM ocorrencias WHERE status = 'aguardando_cliente'"),
    chegaramOntem: n("SELECT COUNT(*) n FROM ocorrencias WHERE criado_em >= datetime('now','-1 day')"),
    vencendo: n(
      `SELECT COUNT(*) n FROM ocorrencias WHERE origem = 'ml' AND status != 'resolvida' AND prazo_em IS NOT NULL
       AND julianday(prazo_em) > julianday('now') AND (julianday(prazo_em) - julianday('now')) * 24 <= 24`,
    ),
    vencidas: n("SELECT COUNT(*) n FROM ocorrencias WHERE origem = 'ml' AND status != 'resolvida' AND prazo_em IS NOT NULL AND julianday(prazo_em) <= julianday('now')"),
    paradas: n("SELECT COUNT(*) n FROM ocorrencias WHERE status IN ('nova','em_analise') AND atualizado_em < datetime('now','-2 days')"),
  };
}

export async function enviarResumo(): Promise<void> {
  const r = montarResumo();
  const abertas = r.novas + r.emAnalise + r.aguardando;
  const linhas = [
    `📋 <b>Resumo do dia — ${esc(config.brandName)}</b>`,
    `Abertas: <b>${abertas}</b> (novas ${r.novas} · em análise ${r.emAnalise} · aguardando cliente ${r.aguardando})`,
    `Chegaram nas últimas 24 h: ${r.chegaramOntem}`,
  ];
  if (r.vencendo) linhas.push(`⏰ Mercado Livre com prazo em menos de 24 h: <b>${r.vencendo}</b>`);
  if (r.vencidas) linhas.push(`🚨 Mercado Livre com prazo vencido: <b>${r.vencidas}</b>`);
  if (r.paradas) linhas.push(`🐢 Paradas há mais de 2 dias (novas/em análise): ${r.paradas}`);
  linhas.push(`<a href="${esc(config.publicUrl + "/painel")}">Abrir o painel</a>`);
  await enviarTelegram(linhas.join("\n"));
}

async function resumoSeChegouAHora(): Promise<void> {
  if (!(config.resumoHora >= 0 && config.resumoHora <= 23)) return;
  const { data, hora } = agoraLocal();
  if (hora < config.resumoHora || estado("resumo_data") === data) return;
  gravarEstado("resumo_data", data); // grava antes: se falhar, não repete em loop
  const { novas, emAnalise, aguardando } = montarResumo();
  if (novas + emAnalise + aguardando === 0) return; // nada em aberto: não incomoda
  await enviarResumo();
}

// ---------- Backup diário ----------
export function listarBackups(): { nome: string; bytes: number; criado: string }[] {
  if (!fs.existsSync(pastaBackups)) return [];
  return fs
    .readdirSync(pastaBackups)
    .filter((f) => /^ocorrencias-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map((nome) => {
      const st = fs.statSync(path.join(pastaBackups, nome));
      return { nome, bytes: st.size, criado: st.mtime.toISOString() };
    })
    .sort((a, b) => b.nome.localeCompare(a.nome));
}

export async function fazerBackup(): Promise<string> {
  fs.mkdirSync(pastaBackups, { recursive: true });
  const nome = `ocorrencias-${agoraLocal().data}.db`;
  const destino = path.join(pastaBackups, nome);
  const tmp = destino + ".parcial";
  await db.backup(tmp); // cópia consistente, mesmo com o banco em uso
  fs.renameSync(tmp, destino);
  for (const b of listarBackups().slice(config.backupManter)) fs.rmSync(path.join(pastaBackups, b.nome), { force: true });
  console.log(`[backup] ${nome} (${fs.statSync(destino).size} bytes)`);
  return nome;
}

async function backupSeFaltar(): Promise<void> {
  const nome = `ocorrencias-${agoraLocal().data}.db`;
  if (fs.existsSync(path.join(pastaBackups, nome))) return;
  try { await fazerBackup(); } catch (e: any) { console.error("[backup] falhou:", e?.message); }
}

// ---------- Agendador ----------
let rodando = false;
async function ciclo(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    await alertarPrazos();
    await resumoSeChegouAHora();
    await backupSeFaltar();
    await enviarPesquisasPendentes();
    aplicarRetencao();
  } catch (e: any) {
    console.error("[rotinas]", e?.message);
  } finally {
    rodando = false;
  }
}

export function iniciarRotinas(): void {
  setTimeout(ciclo, 30_000).unref();
  setInterval(ciclo, 10 * 60 * 1000).unref();
  console.log(`[rotinas] alerta de prazo, resumo diário (${config.resumoHora >= 0 && config.resumoHora <= 23 ? config.resumoHora + " h" : "desligado"}) e backup diário ativos.`);
}
