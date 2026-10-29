import { CONFERENCIAS, STATUS_DEVOLUCAO, config, type Conferencia, type StatusDevolucao } from "./config.js";
import { db } from "./db.js";
import { MlErro, ml } from "./ml-api.js";
import { enviarTelegram, esc } from "./notify.js";

/** Devoluções do Mercado Livre (v1.8.0): importa da API, calcula o status, guarda conferência e custos e contesta. */

const sqlData = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const dataSql = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : sqlData(d);
};
const centavosDe = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null);
const reais = (c: number | null | undefined) => (c == null ? null : c / 100);

// ---------- Leitura da resposta do ML (funções puras, testadas) ----------
export interface RetornoMl {
  returnId: string | null;
  mlStatus: string | null;
  subtype: string | null;
  tipo: string | null;
  dinheiro: string | null;
  envioId: string | null;
  envioStatus: string | null;
  rastreio: string | null;
  previsaoEm: string | null;
  abertaEm: string | null;
  enviadaEm: string | null;
  recebidaEm: string | null;
  fechadaEm: string | null;
  reembolsoEm: string | null;
}

/** Aceita objeto único ou lista (a doc do ML varia) e devolve a devolução mais recente, já normalizada. */
export function extrairRetorno(resp: any): RetornoMl | null {
  const lista: any[] = Array.isArray(resp) ? resp
    : Array.isArray(resp?.results) ? resp.results
    : Array.isArray(resp?.data) ? resp.data
    : Array.isArray(resp?.returns) ? resp.returns
    : [resp];
  const validos = lista.filter((x) => x && typeof x === "object");
  if (!validos.length) return null;
  const chave = (x: any) => String(x.last_updated ?? x.date_created ?? "");
  const r = [...validos].sort((a, b) => chave(b).localeCompare(chave(a)))[0];
  if (!r.status && !r.shipping && !r.shipments && !r.subtype) return null;
  const env = r.shipping ?? (Array.isArray(r.shipments) ? r.shipments[0] : null) ?? {};
  const hist: any[] = Array.isArray(env.status_history) ? env.status_history : [];
  const quando = (st: string) => {
    const h = hist.find((x) => x?.status === st);
    return dataSql(h?.date ?? h?.date_created ?? h?.timestamp);
  };
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  return {
    returnId: str(r.id ?? r.return_id ?? r.resource_id),
    mlStatus: str(r.status),
    subtype: str(r.subtype),
    tipo: str(r.type),
    dinheiro: str(r.status_money),
    envioId: str(env.id ?? env.shipment_id),
    envioStatus: str(env.status),
    rastreio: str(env.tracking_number),
    previsaoEm: dataSql(env.lead_time?.estimated_delivery_time?.date),
    abertaEm: dataSql(r.date_created),
    enviadaEm: quando("shipped"),
    recebidaEm: quando("delivered") ?? (env.status === "delivered" || r.status === "delivered" ? dataSql(r.last_updated) : null),
    fechadaEm: dataSql(r.date_closed),
    reembolsoEm: dataSql(r.refund_at),
  };
}

export interface EntradaStatus {
  mlStatus: string | null;
  envioStatus: string | null;
  acoes: string[];
  conferencia: string | null;
  contestacao: string | null;
}

/** Status que a equipe vê, a partir do que o ML informa e do que a equipe já registrou. */
export function calcularStatus(i: EntradaStatus): StatusDevolucao {
  const s = i.mlStatus, e = i.envioStatus;
  if (s === "cancelled" || s === "failed" || s === "expired") return "cancelada";
  if (s === "closed") return "encerrada";
  if (i.contestacao === "enviada") return "em_contestacao";
  if (i.contestacao === "ganha" || i.contestacao === "perdida") return "encerrada";
  if (e === "cancelled") return "cancelada";
  if (s === "delivered" || e === "delivered") return i.conferencia ? "conferida" : "recebida";
  if (s === "not_delivered" || e === "not_delivered") return "nao_entregue";
  if (s === "shipped" || e === "shipped") return "em_transito";
  return i.acoes.includes("allow_return_label") ? "aguardando_liberacao" : "liberada";
}

/** Custo do frete da devolução que fica com o vendedor. A resposta do ML não é bem documentada: lê o que reconhece. */
export function custoDoEnvio(resp: any, vendedor?: string | null): number | null {
  if (!resp || typeof resp !== "object") return null;
  const senders: any[] = Array.isArray(resp.senders) ? resp.senders : [];
  if (senders.length) {
    const meus = vendedor ? senders.filter((x) => String(x?.user_id) === String(vendedor)) : [];
    const alvo = meus.length ? meus : senders;
    const soma = alvo.reduce((t, x) => t + (typeof x?.cost === "number" ? x.cost : 0), 0);
    if (alvo.some((x) => typeof x?.cost === "number")) return Math.round(soma * 100);
  }
  return centavosDe(resp.cost) ?? centavosDe(resp.gross_amount);
}

export function acoesDoVendedor(claim: any, vendedor: string): string[] {
  const eu = (claim?.players ?? []).find((p: any) => p.role === "respondent" && String(p.user_id) === String(vendedor));
  return (eu?.available_actions ?? []).map((a: any) => String(a.action)).filter(Boolean);
}

// ---------- Banco ----------
const FINAIS: StatusDevolucao[] = ["encerrada", "cancelada"];

/** A devolução ainda anda (ou a ocorrência ainda não tem registro): vale reconsultar o ML no próximo ciclo. */
export function precisaVerDevolucao(ocorrenciaId: number): boolean {
  const d = db.prepare("SELECT status FROM devolucoes WHERE ocorrencia_id = ?").get(ocorrenciaId) as { status: StatusDevolucao } | undefined;
  if (!d) return semDevolucaoAte.get(ocorrenciaId) ? Date.now() > (semDevolucaoAte.get(ocorrenciaId) ?? 0) : true;
  return !FINAIS.includes(d.status);
}

// Reclamações que o ML disse não ter devolução: não perguntar de novo por 1 hora
const semDevolucaoAte = new Map<number, number>();

function produtosDe(json: string | null | undefined): any[] {
  try { const j = json ? JSON.parse(json) : []; return Array.isArray(j) ? j : []; } catch { return []; }
}


/** Importa/atualiza a devolução da reclamação. Nunca lança: falha vai para o log. */
export async function sincronizarDevolucao(ocId: number, claim: any, vendedor: string, forcar = false): Promise<void> {
  try {
    const entidades: unknown = claim?.related_entities;
    if (Array.isArray(entidades) && !entidades.includes("return") && !forcar) return;
    const claimId = String(claim.id);
    let resp: any;
    try {
      resp = await ml(`/post-purchase/v2/claims/${encodeURIComponent(claimId)}/returns`);
    } catch (e: any) {
      if (e instanceof MlErro && (e.status === 404 || e.status === 400)) {
        if (!db.prepare("SELECT 1 FROM devolucoes WHERE ocorrencia_id = ?").get(ocId)) semDevolucaoAte.set(ocId, Date.now() + 3600_000);
        return;
      }
      throw e;
    }
    const r = extrairRetorno(resp);
    if (!r) return;
    semDevolucaoAte.delete(ocId);

    const acoes = acoesDoVendedor(claim, vendedor);
    const existente = db.prepare("SELECT * FROM devolucoes WHERE ocorrencia_id = ?").get(ocId) as any | undefined;
    const oc = db.prepare("SELECT protocolo, pedido, nome, produto_json FROM ocorrencias WHERE id = ?").get(ocId) as
      { protocolo: string; pedido: string; nome: string; produto_json: string | null } | undefined;
    if (!oc) return;

    // Frete da devolução (a menos que a equipe já tenha digitado)
    let frete: number | null = existente?.frete_centavos ?? null;
    let freteOrigem: string | null = existente?.frete_origem ?? null;
    if (freteOrigem !== "manual" && r.envioId) {
      try {
        const c = custoDoEnvio(await ml(`/shipments/${encodeURIComponent(r.envioId)}/costs`), vendedor);
        if (c != null) { frete = c; freteOrigem = "ml"; }
      } catch (e: any) {
        console.error(`[devolucao] custo do envio ${r.envioId}: ${e?.message}`);
      }
    }
    // Reembolso: devolução total = valor dos produtos (estimativa). A equipe pode corrigir.
    let reembolso: number | null = existente?.reembolso_centavos ?? null;
    let reembolsoOrigem: string | null = existente?.reembolso_origem ?? null;
    if (reembolsoOrigem !== "manual" && r.subtype === "return_total") {
      const total = produtosDe(oc.produto_json).reduce((t, p) => t + (typeof p.preco === "number" ? p.preco * (p.qtd ?? 1) : 0), 0);
      if (total > 0) { reembolso = Math.round(total * 100); reembolsoOrigem = "estimado"; }
    }

    const status = calcularStatus({
      mlStatus: r.mlStatus, envioStatus: r.envioStatus, acoes,
      conferencia: existente?.conferencia ?? null, contestacao: existente?.contestacao_status ?? null,
    });
    const resumo = JSON.stringify({ id: r.returnId, status: r.mlStatus, subtype: r.subtype, tipo: r.tipo, dinheiro: r.dinheiro, envio: r.envioStatus });

    if (!existente) {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO devolucoes (ocorrencia_id, claim_id, return_id, status, ml_status, ml_subtype, ml_tipo, dinheiro, envio_id, envio_status,
             rastreio, previsao_em, aberta_em, enviada_em, recebida_em, fechada_em, reembolso_em, acoes_json,
             frete_centavos, frete_origem, reembolso_centavos, reembolso_origem, ml_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(ocId, claimId, r.returnId, status, r.mlStatus, r.subtype, r.tipo, r.dinheiro, r.envioId, r.envioStatus,
          r.rastreio, r.previsaoEm, r.abertaEm, r.enviadaEm, r.recebidaEm, r.fechadaEm, r.reembolsoEm, JSON.stringify(acoes),
          frete, freteOrigem, reembolso, reembolsoOrigem, resumo);
        db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)")
          .run(ocId, `Devolução importada do Mercado Livre: ${STATUS_DEVOLUCAO[status]}.`, "Sistema");
      })();
      void avisar(oc, status, true);
      return;
    }

    db.prepare(
      `UPDATE devolucoes SET status = ?, ml_status = ?, ml_subtype = ?, ml_tipo = ?, dinheiro = ?, envio_id = ?, envio_status = ?, rastreio = ?,
         previsao_em = ?, aberta_em = ?, enviada_em = ?, recebida_em = ?, fechada_em = ?, reembolso_em = ?, acoes_json = ?, return_id = ?,
         frete_centavos = ?, frete_origem = ?, reembolso_centavos = ?, reembolso_origem = ?, ml_json = ?, atualizado_em = datetime('now')
       WHERE id = ?`,
    ).run(status, r.mlStatus, r.subtype, r.tipo, r.dinheiro, r.envioId, r.envioStatus, r.rastreio,
      r.previsaoEm, r.abertaEm, r.enviadaEm, r.recebidaEm, r.fechadaEm, r.reembolsoEm, JSON.stringify(acoes), r.returnId,
      frete, freteOrigem, reembolso, reembolsoOrigem, resumo, existente.id);
    if (existente.status !== status) {
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)")
        .run(ocId, `Devolução: ${STATUS_DEVOLUCAO[status]}.`, "Sistema");
      void avisar(oc, status, false);
    }
  } catch (e: any) {
    console.error(`[devolucao] reclamação ${claim?.id}: ${e?.message}`);
  }
}

async function avisar(oc: { protocolo: string; pedido: string; nome: string }, status: StatusDevolucao, nova: boolean): Promise<void> {
  const titulo = nova ? "↩️ <b>Nova devolução no Mercado Livre</b>"
    : status === "aguardando_liberacao" ? "↩️ <b>Devolução aguardando liberação</b>"
    : status === "recebida" ? "📦 <b>Devolução recebida: conferir o produto</b>"
    : status === "nao_entregue" ? "⚠️ <b>Devolução não chegou ao destino</b>"
    : null;
  if (!titulo) return;
  const extra = nova && status === "aguardando_liberacao" ? "\nPrecisa liberar a devolução." : "";
  await enviarTelegram(
    `${titulo} <code>${esc(oc.protocolo)}</code>\nPedido: <code>${esc(oc.pedido)}</code> · ${esc(oc.nome)}\nSituação: ${esc(STATUS_DEVOLUCAO[status])}${extra}\n` +
      `<a href="${esc(config.publicUrl)}/painel#${encodeURIComponent(oc.protocolo)}">Abrir no painel</a>`,
  );
}

// ---------- Apresentação ----------
export function devolucaoDa(ocId: number): any | null {
  const d = db.prepare("SELECT * FROM devolucoes WHERE ocorrencia_id = ?").get(ocId) as any | undefined;
  if (!d) return null;
  const oc = db.prepare("SELECT pedido FROM ocorrencias WHERE id = ?").get(ocId) as { pedido: string } | undefined;
  let acoes: string[] = [];
  try { acoes = JSON.parse(d.acoes_json ?? "[]"); } catch { /* ignora */ }
  const parts = [d.frete_centavos, d.perda_centavos, d.outros_centavos].map((x: number | null) => x ?? 0);
  const total = parts.reduce((a: number, b: number) => a + b, 0) - (d.recuperado_centavos ?? 0);
  const temCusto = [d.frete_centavos, d.perda_centavos, d.outros_centavos, d.recuperado_centavos].some((x) => x != null);
  return {
    status: d.status,
    statusRotulo: STATUS_DEVOLUCAO[d.status as StatusDevolucao] ?? d.status,
    tipo: d.ml_subtype === "return_total" ? "Total" : d.ml_subtype === "return_partial" ? "Parcial" : d.ml_subtype === "low_cost" ? "Baixo valor" : null,
    mlStatus: d.ml_status,
    dinheiro: d.dinheiro,
    envio: { id: d.envio_id, status: d.envio_status, rastreio: d.rastreio, previsaoEm: d.previsao_em },
    datas: { aberta: d.aberta_em, enviada: d.enviada_em, recebida: d.recebida_em, fechada: d.fechada_em, reembolso: d.reembolso_em },
    motivoReal: d.motivo_real,
    conferencia: d.conferencia,
    conferenciaRotulo: d.conferencia ? CONFERENCIAS[d.conferencia as Conferencia] ?? d.conferencia : null,
    conferenciaObs: d.conferencia_obs,
    conferidaPor: d.conferida_por,
    conferidaEm: d.conferida_em,
    custos: {
      frete: reais(d.frete_centavos), freteOrigem: d.frete_origem,
      perda: reais(d.perda_centavos), outros: reais(d.outros_centavos),
      reembolso: reais(d.reembolso_centavos), reembolsoOrigem: d.reembolso_origem,
      recuperado: reais(d.recuperado_centavos),
      total: temCusto ? total / 100 : null,
    },
    contestacao: {
      status: d.contestacao_status, motivo: d.contestacao_motivo, mensagem: d.contestacao_mensagem,
      em: d.contestacao_em, por: d.contestacao_por,
    },
    acoes,
    podeLiberar: acoes.includes("allow_return_label"),
    podeContestar: acoes.includes("return_review_fail") && !d.contestacao_status,
    linkMl: oc ? `https://www.mercadolivre.com.br/vendas/${encodeURIComponent(oc.pedido)}/detalhe` : null,
  };
}

// ---------- Conferência e custos (feitos pela equipe) ----------
export interface EdicaoDevolucao {
  conferencia?: Conferencia | null;
  conferenciaObs?: string | null;
  motivoReal?: string | null;
  frete?: number | null;
  perda?: number | null;
  outros?: number | null;
  reembolso?: number | null;
  recuperado?: number | null;
  contestacaoResultado?: "ganha" | "perdida" | null;
}

export function atualizarDevolucao(ocId: number, e: EdicaoDevolucao, autor: string): any {
  const d = db.prepare("SELECT * FROM devolucoes WHERE ocorrencia_id = ?").get(ocId) as any | undefined;
  if (!d) throw new MlErro(404, "Esta ocorrência não tem devolução.");
  const sets: string[] = [];
  const args: unknown[] = [];
  const notas: string[] = [];
  const cent = (v: number | null) => (v == null ? null : Math.round(v * 100));
  const mudou = (k: keyof EdicaoDevolucao) => e[k] !== undefined;

  let conferencia = d.conferencia as string | null;
  if (mudou("conferencia")) {
    conferencia = e.conferencia ?? null;
    sets.push("conferencia = ?", "conferida_por = ?", "conferida_em = ?");
    args.push(conferencia, conferencia ? autor : null, conferencia ? new Date().toISOString().slice(0, 19).replace("T", " ") : null);
    notas.push(conferencia ? `Conferência: ${CONFERENCIAS[conferencia as Conferencia]}.` : "Conferência removida.");
  }
  if (mudou("conferenciaObs")) { sets.push("conferencia_obs = ?"); args.push(e.conferenciaObs?.trim() || null); }
  if (mudou("motivoReal")) { sets.push("motivo_real = ?"); args.push(e.motivoReal?.trim() || null); notas.push(e.motivoReal?.trim() ? `Motivo real da devolução: ${e.motivoReal.trim()}.` : "Motivo real removido."); }
  if (mudou("frete")) { sets.push("frete_centavos = ?", "frete_origem = ?"); args.push(cent(e.frete ?? null), e.frete == null ? null : "manual"); }
  if (mudou("perda")) { sets.push("perda_centavos = ?"); args.push(cent(e.perda ?? null)); }
  if (mudou("outros")) { sets.push("outros_centavos = ?"); args.push(cent(e.outros ?? null)); }
  if (mudou("reembolso")) { sets.push("reembolso_centavos = ?", "reembolso_origem = ?"); args.push(cent(e.reembolso ?? null), e.reembolso == null ? null : "manual"); }
  if (mudou("recuperado")) { sets.push("recuperado_centavos = ?"); args.push(cent(e.recuperado ?? null)); }
  if (["frete", "perda", "outros", "reembolso", "recuperado"].some((k) => mudou(k as keyof EdicaoDevolucao))) notas.push("Custos da devolução atualizados.");

  let contestacao = d.contestacao_status as string | null;
  if (mudou("contestacaoResultado")) {
    if (!d.contestacao_status) throw new MlErro(409, "Ainda não há contestação enviada nesta devolução.");
    contestacao = e.contestacaoResultado ?? "enviada";
    sets.push("contestacao_status = ?");
    args.push(contestacao);
    notas.push(`Contestação: ${contestacao === "ganha" ? "ganha" : contestacao === "perdida" ? "perdida" : "em andamento"}.`);
  }
  if (!sets.length) return devolucaoDa(ocId);

  const acoes: string[] = (() => { try { return JSON.parse(d.acoes_json ?? "[]"); } catch { return []; } })();
  const status = calcularStatus({ mlStatus: d.ml_status, envioStatus: d.envio_status, acoes, conferencia, contestacao });
  sets.push("status = ?", "atualizado_em = datetime('now')");
  args.push(status, d.id);
  db.transaction(() => {
    db.prepare(`UPDATE devolucoes SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    for (const t of notas) db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)").run(ocId, t, autor);
    db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(ocId);
  })();
  return devolucaoDa(ocId);
}

// ---------- Contestação (produto voltou com problema) ----------
/** Motivos de "falha na devolução" do ML (SRF2..SRF7). */
export const MOTIVOS_CONTESTACAO = [
  { id: "SRF2", nome: "O produto chegou danificado", exigeFoto: true, conferencia: "danificado" },
  { id: "SRF3", nome: "A devolução veio incompleta", exigeFoto: false, conferencia: "incompleto" },
  { id: "SRF4", nome: "O produto devolvido é diferente do enviado", exigeFoto: true, conferencia: "diferente" },
  { id: "SRF5", nome: "A embalagem veio sem o produto", exigeFoto: false, conferencia: "sem_produto" },
  { id: "SRF6", nome: "Outra falha no produto", exigeFoto: false, conferencia: "outro" },
  { id: "SRF7", nome: "A devolução não chegou", exigeFoto: false, conferencia: null },
] as const;

export interface FotoEvidencia { buffer: Buffer; mimetype: string; originalname: string }

export async function contestarDevolucao(
  oc: { id: number; protocolo: string; ml_claim_id: string },
  motivo: string, mensagem: string, fotos: FotoEvidencia[], autor: string,
): Promise<void> {
  const d = db.prepare("SELECT * FROM devolucoes WHERE ocorrencia_id = ?").get(oc.id) as any | undefined;
  if (!d) throw new MlErro(404, "Esta ocorrência não tem devolução.");
  if (d.contestacao_status) throw new MlErro(409, "Esta devolução já tem contestação enviada.");
  const m = MOTIVOS_CONTESTACAO.find((x) => x.id === motivo);
  if (!m) throw new MlErro(400, "Escolha o motivo da contestação.");
  if (m.exigeFoto && !fotos.length) throw new MlErro(400, "Este motivo exige pelo menos uma foto como prova.");
  const claimId = encodeURIComponent(oc.ml_claim_id);

  // O ML só aceita se a ação estiver liberada agora para o vendedor
  const claim = await ml(`/post-purchase/v1/claims/${claimId}`);
  const vendedor = (claim.players ?? []).find((p: any) => p.role === "respondent")?.user_id;
  if (!acoesDoVendedor(claim, String(vendedor)).includes("return_review_fail"))
    throw new MlErro(409, "O Mercado Livre não está aceitando contestação desta devolução agora (a conferência dele ainda não terminou ou o prazo acabou).");

  const arquivos: string[] = [];
  for (const f of fotos) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(f.buffer)], { type: f.mimetype }), f.originalname);
    const r = await ml(`/post-purchase/v1/claims/${claimId}/returns/attachments`, { metodo: "POST", form });
    const nome = r?.file_name ?? r?.filename ?? r?.name ?? (Array.isArray(r) ? r[0]?.file_name : null);
    if (!nome) throw new MlErro(502, "O Mercado Livre não aceitou uma das fotos. Tente com imagens JPG ou PNG menores.");
    arquivos.push(String(nome));
  }
  const item: Record<string, unknown> = { reason: m.id, message: mensagem.trim() };
  if (arquivos.length) item.attachments = arquivos;
  await ml(`/post-purchase/v1/claims/${claimId}/actions/return-review-fail`, { metodo: "POST", corpo: [item] });

  db.transaction(() => {
    db.prepare(
      `UPDATE devolucoes SET contestacao_status = 'enviada', contestacao_motivo = ?, contestacao_mensagem = ?, contestacao_em = datetime('now'),
         contestacao_por = ?, status = 'em_contestacao', atualizado_em = datetime('now') WHERE id = ?`,
    ).run(m.nome, mensagem.trim(), autor, d.id);
    db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)")
      .run(oc.id, `Contestação enviada ao Mercado Livre: ${m.nome}${arquivos.length ? ` (${arquivos.length} foto${arquivos.length > 1 ? "s" : ""})` : ""}.`, autor);
    db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(oc.id);
  })();
}

// ---------- Lista da aba Devoluções ----------
export function listarDevolucoes(filtro: { status?: string; q?: string; pagina: number; porPagina: number }) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filtro.status && filtro.status in STATUS_DEVOLUCAO) { where.push("d.status = ?"); args.push(filtro.status); }
  const q = (filtro.q ?? "").trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    where.push("(o.protocolo LIKE ? ESCAPE '\\' OR o.pedido LIKE ? ESCAPE '\\' OR o.nome LIKE ? ESCAPE '\\' OR d.rastreio LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const cond = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (db.prepare(`SELECT COUNT(*) n FROM devolucoes d JOIN ocorrencias o ON o.id = d.ocorrencia_id ${cond}`).get(...args) as { n: number }).n;
  const itens = (db.prepare(
    `SELECT o.protocolo, o.pedido, o.nome, o.prazo_em, o.produto_json, d.status, d.ml_subtype, d.rastreio, d.envio_status, d.recebida_em, d.aberta_em,
            d.conferencia, d.contestacao_status, d.dinheiro,
            COALESCE(d.frete_centavos,0) + COALESCE(d.perda_centavos,0) + COALESCE(d.outros_centavos,0) - COALESCE(d.recuperado_centavos,0) AS custo_centavos,
            (d.frete_centavos IS NOT NULL OR d.perda_centavos IS NOT NULL OR d.outros_centavos IS NOT NULL) AS tem_custo,
            (SELECT u.nome FROM usuarios u WHERE u.id = o.responsavel_id) AS responsavel
     FROM devolucoes d JOIN ocorrencias o ON o.id = d.ocorrencia_id ${cond}
     ORDER BY CASE d.status WHEN 'aguardando_liberacao' THEN 0 WHEN 'recebida' THEN 1 WHEN 'nao_entregue' THEN 2 WHEN 'em_contestacao' THEN 3
                            WHEN 'em_transito' THEN 4 WHEN 'liberada' THEN 5 WHEN 'conferida' THEN 6 ELSE 7 END, d.atualizado_em DESC
     LIMIT ? OFFSET ?`,
  ).all(...args, filtro.porPagina, (filtro.pagina - 1) * filtro.porPagina) as any[]).map((r) => {
    const { produto_json, custo_centavos, tem_custo, ...resto } = r;
    const p = produtosDe(produto_json)[0];
    return { ...resto, tipo: r.ml_subtype === "return_total" ? "Total" : r.ml_subtype === "return_partial" ? "Parcial" : null,
      custo: tem_custo ? custo_centavos / 100 : null, produto: p ? { foto: p.foto, titulo: p.titulo } : null };
  });
  const contagem: Record<string, number> = Object.fromEntries(Object.keys(STATUS_DEVOLUCAO).map((k) => [k, 0]));
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM devolucoes GROUP BY status").all() as { status: string; n: number }[]) contagem[r.status] = r.n;
  return { itens, total, pagina: filtro.pagina, porPagina: filtro.porPagina, contagem, status: STATUS_DEVOLUCAO };
}
