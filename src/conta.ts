import { config } from "./config.js";
import { db } from "./db.js";
import { MlErro, ml } from "./ml-api.js";

/** Conta da venda (v1.9.0): o que o Mercado Livre cobrou, reteve e devolveu em cada pedido com reclamação,
 *  no formato do quadro "Recebimento" do próprio ML, mais faturamento, pendência com o ML e reputação. */

export const PENDENCIAS_ML = {
  nenhuma: "Sem pendência",
  aguardando: "Aguardando retorno do Mercado Livre",
  creditou: "Mercado Livre creditou",
  negou: "Mercado Livre negou",
} as const;
export type PendenciaMl = keyof typeof PENDENCIAS_ML;

const cent = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null);
const reais = (c: number | null | undefined) => (c == null ? null : c / 100);
const sqlData = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};

// ---------- Leitura do pedido e dos envios (funções puras, testadas) ----------
export interface ResumoPedido {
  preco: number | null;        // centavos, soma de unit_price × quantidade
  tarifa: number | null;       // centavos, soma de sale_fee × quantidade
  reembolso: number | null;    // centavos devolvidos ao comprador (pagamentos)
  liquido: number | null;      // centavos: net_received_amount (quando o ML informa)
  pagamentoStatus: string | null;
  liberado: boolean | null;
  liberacaoEm: string | null;
  envioIdaId: string | null;
  pagamentoIds: string[];
}

export function resumirPedido(pedido: any): ResumoPedido {
  const itens: any[] = Array.isArray(pedido?.order_items) ? pedido.order_items : [];
  let preco = 0, tarifa = 0, temPreco = false, temTarifa = false;
  for (const it of itens) {
    const q = typeof it?.quantity === "number" ? it.quantity : 1;
    if (typeof it?.unit_price === "number") { preco += it.unit_price * q; temPreco = true; }
    if (typeof it?.sale_fee === "number") { tarifa += it.sale_fee * q; temTarifa = true; }
  }
  const pags: any[] = Array.isArray(pedido?.payments) ? pedido.payments : [];
  let reembolso = 0, temReembolso = false, liquido: number | null = null;
  for (const p of pags) {
    const r = p?.transaction_amount_refunded ?? p?.amount_refunded;
    if (typeof r === "number") { reembolso += r; temReembolso = true; }
    if (typeof p?.net_received_amount === "number") liquido = (liquido ?? 0) + p.net_received_amount;
  }
  const principal = pags.find((p) => p?.status) ?? null;
  return {
    preco: temPreco ? Math.round(preco * 100) : cent(pedido?.total_amount),
    tarifa: temTarifa ? Math.round(tarifa * 100) : null,
    reembolso: temReembolso ? Math.round(reembolso * 100) : null,
    liquido: liquido == null ? null : Math.round(liquido * 100),
    pagamentoStatus: principal?.status ?? null,
    liberado: principal?.released == null ? null : principal.released === "yes" || principal.released === true,
    liberacaoEm: sqlData(principal?.money_release_date),
    envioIdaId: pedido?.shipping?.id != null ? String(pedido.shipping.id) : null,
    pagamentoIds: pags.map((p) => (p?.id != null ? String(p.id) : null)).filter(Boolean) as string[],
  };
}

/** Pagamento detalhado (/collections/{id}) complementa o que veio no pedido: líquido, liberação e estornos. */
export function aplicarPagamento(r: ResumoPedido, pagamento: any): ResumoPedido {
  if (!pagamento || typeof pagamento !== "object") return r;
  const out = { ...r };
  if (typeof pagamento.net_received_amount === "number") out.liquido = Math.round(pagamento.net_received_amount * 100);
  // Estornos só crescem: fica o maior valor entre o pedido e o pagamento detalhado
  const reemb = pagamento.transaction_amount_refunded ?? pagamento.amount_refunded;
  if (typeof reemb === "number") out.reembolso = Math.max(out.reembolso ?? 0, Math.round(reemb * 100));
  if (pagamento.status) out.pagamentoStatus = String(pagamento.status);
  if (pagamento.released != null) out.liberado = pagamento.released === "yes" || pagamento.released === true;
  if (pagamento.money_release_date) out.liberacaoEm = sqlData(pagamento.money_release_date) ?? out.liberacaoEm;
  return out;
}

/** Quanto o vendedor paga de um envio (ida ou volta), em centavos. */
export function custoDoVendedor(custos: any, vendedor: string): number | null {
  if (!custos || typeof custos !== "object") return null;
  let total = 0, achou = false;
  for (const s of Array.isArray(custos.senders) ? custos.senders : []) {
    if (String(s?.user_id) === String(vendedor) && typeof s?.cost === "number") { total += s.cost; achou = true; }
  }
  if (custos.receiver && String(custos.receiver.user_id) === String(vendedor) && typeof custos.receiver.cost === "number") { total += custos.receiver.cost; achou = true; }
  return achou ? Math.round(total * 100) : null;
}

/** Lê, da mensagem do mediador, a etiqueta prevista ("custo da etiqueta de devolução será de R$ 9,79") e a reputação. */
export function lerMensagemMediador(textos: string[]): { etiquetaPrevista: number | null; reputacaoAfetada: boolean | null } {
  let etiqueta: number | null = null;
  let reputacao: boolean | null = null;
  for (const t of textos) {
    const m = /etiqueta de devolu[çc][ãa]o.{0,60}?R\$\s*([\d.]+,\d{2}|\d+(?:[.,]\d+)?)/i.exec(t);
    if (m && etiqueta == null) {
      const n = Number(m[1].replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(n)) etiqueta = Math.round(n * 100);
    }
    if (/reputa[çc][ãa]o (ser[áa]|foi|será) (impactada|afetada)/i.test(t)) reputacao = true;
    else if (/reputa[çc][ãa]o n[ãa]o (ser[áa]|foi) (impactada|afetada)/i.test(t)) reputacao = reputacao ?? false;
  }
  return { etiquetaPrevista: etiqueta, reputacaoAfetada: reputacao };
}

// ---------- Faturamento do ML (lançamentos por pedido) ----------
export interface Lancamento {
  detailId: string; periodo: string; pedido: string | null; envioId: string | null;
  tipo: string; subtipo: string | null; descricao: string; valor: number; bruto: number | null;
  data: string | null; mercado: string | null; categoria: Categoria;
}
export type Categoria = "etiqueta_devolucao" | "frete" | "tarifa_venda" | "credito" | "outro";

export function classificarLancamento(l: { tipo: string; subtipo: string | null; descricao: string; valor: number; mercado: string | null }): Categoria {
  const d = (l.descricao || "").toLowerCase();
  const credito = l.valor < 0 || /credit|bonif|refund|devolu[çc][ãa]o de tarifa|estorno/i.test(l.tipo + " " + (l.subtipo ?? ""));
  if (credito && !/envio de devolu|etiqueta/.test(d)) return "credito";
  if (/devolu[çc][ãa]o|etiqueta|return/.test(d)) return "etiqueta_devolucao";
  if (l.mercado === "SHIPPING" || /envio|frete|shipping/.test(d)) return "frete";
  if (/tarifa de venda|sale fee|comiss/.test(d)) return "tarifa_venda";
  return credito ? "credito" : "outro";
}

export function lerLancamento(item: any, periodo: string): Lancamento | null {
  const ci = item?.charge_info;
  if (!ci || ci.detail_id == null) return null;
  const venda = Array.isArray(item.sales_info) ? item.sales_info[0] : null;
  const valor = typeof ci.detail_amount === "number" ? ci.detail_amount : Number(ci.detail_amount);
  if (!Number.isFinite(valor)) return null;
  const tipo = String(ci.detail_type ?? "CHARGE");
  // Nota de crédito / bonificação vêm como tipos próprios; guardamos crédito como valor negativo
  const sinal = /CREDIT|BONIF|REFUND/i.test(tipo) ? -1 : 1;
  const base = {
    tipo, subtipo: ci.detail_sub_type ?? null, descricao: String(ci.transaction_detail ?? ""), valor: Math.round(valor * 100) * sinal,
    mercado: item.marketplace_info?.marketplace ?? null,
  };
  return {
    detailId: String(ci.detail_id), periodo,
    pedido: venda?.order_id != null ? String(venda.order_id) : (item.shipping_info?.pack_id != null ? String(item.shipping_info.pack_id) : null),
    envioId: item.shipping_info?.shipping_id != null ? String(item.shipping_info.shipping_id) : null,
    ...base,
    bruto: cent(item.discount_info?.charge_amount_without_discount),
    data: sqlData(ci.creation_date_time) ?? (typeof ci.creation_date_time === "string" ? ci.creation_date_time.replace("T", " ").slice(0, 19) : null),
    categoria: classificarLancamento(base),
  };
}

const insLanc = () => db.prepare(
  `INSERT INTO ml_faturamento (detail_id, periodo, pedido, envio_id, tipo, subtipo, descricao, valor_centavos, bruto_centavos, data, mercado, categoria)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(detail_id) DO UPDATE SET pedido = excluded.pedido, valor_centavos = excluded.valor_centavos, categoria = excluded.categoria, periodo = excluded.periodo`,
);

export function gravarLancamentos(itens: any[], periodo: string): number {
  const ins = insLanc();
  let n = 0;
  db.transaction(() => {
    for (const it of itens) {
      const l = lerLancamento(it, periodo);
      if (!l) continue;
      ins.run(l.detailId, l.periodo, l.pedido, l.envioId, l.tipo, l.subtipo, l.descricao, l.valor, l.bruto, l.data, l.mercado, l.categoria);
      n++;
    }
  })();
  return n;
}

const estado = (k: string) => (db.prepare("SELECT valor FROM rotinas_estado WHERE chave = ?").get(k) as { valor: string } | undefined)?.valor;
const gravarEstado = (k: string, v: string) =>
  db.prepare("INSERT INTO rotinas_estado (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(k, v);

const INTERVALO_MS = 13_000;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ultimaChamada = 0;
/** Espaça as chamadas ao faturamento e, se o ML devolver 429, espera um minuto e tenta de novo (até 3 vezes). */
async function comLimite<T>(fn: () => Promise<T>): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    const falta = ultimaChamada + INTERVALO_MS - Date.now();
    if (falta > 0) await dormir(falta);
    ultimaChamada = Date.now();
    try {
      return await fn();
    } catch (e: any) {
      const limite = e instanceof MlErro && (e.status === 429 || /rate limit/i.test(e.message));
      if (!limite || tentativa >= 3) throw e;
      await dormir(65_000);
    }
  }
}

export interface ResultadoFat { periodos: number; paginas: number; lancamentos: number; completo: boolean; erro?: string }
let sincronizandoFat: Promise<ResultadoFat> | null = null;

/** Baixa o faturamento (período aberto + último fechado), página a página, e guarda por pedido.
 *  Períodos fechados já completos não são baixados de novo. Limita páginas por rodada para não pesar. */
export function sincronizarFaturamento(maxPaginas = config.faturamentoPaginas): Promise<ResultadoFat> {
  sincronizandoFat ??= sincronizarFaturamentoAgora(maxPaginas).finally(() => { sincronizandoFat = null; });
  return sincronizandoFat;
}

async function sincronizarFaturamentoAgora(maxPaginas: number): Promise<ResultadoFat> {
  const res: ResultadoFat = { periodos: 0, paginas: 0, lancamentos: 0, completo: true };
  const POR_PAGINA = 1000;
  try {
    const per: any = await comLimite(() => ml(`/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=2`));
    const lista: any[] = Array.isArray(per?.results) ? per.results : [];
    for (const p of lista) {
      const chave = p?.key ?? p?.period?.key;
      if (!chave) continue;
      const fechado = p?.period_status === "CLOSED";
      if (fechado && estado(`faturamento_completo:${chave}`) === "1") continue;
      res.periodos++;
      // Retoma de onde parou (período aberto cresce; recomeça do zero a cada dia para pegar alterações)
      const hoje = new Date().toISOString().slice(0, 10);
      const chaveOffset = `faturamento_offset:${chave}`;
      let offset = estado(`faturamento_dia:${chave}`) === hoje ? Number(estado(chaveOffset) ?? 0) : 0;
      let terminou = false;
      while (res.paginas < maxPaginas) {
        // O ML permite 5 chamadas por minuto nesta API: uma página a cada 13 s, e espera quando ele pedir
        const det: any = await comLimite(() => ml(`/billing/integration/periods/key/${encodeURIComponent(String(chave))}/group/ML/details?document_type=BILL&limit=${POR_PAGINA}&offset=${offset}`));
        const itens: any[] = Array.isArray(det?.results) ? det.results : [];
        res.paginas++;
        res.lancamentos += gravarLancamentos(itens, String(chave));
        offset += itens.length;
        gravarEstado(`faturamento_dia:${chave}`, hoje);
        gravarEstado(chaveOffset, String(offset));
        gravarEstado("faturamento_sync", new Date().toISOString().slice(0, 19).replace("T", " "));
        const total = typeof det?.total === "number" ? det.total : null;
        if (itens.length < POR_PAGINA || (total != null && offset >= total)) { terminou = true; break; }
      }
      if (!terminou) { res.completo = false; break; }
      if (fechado) gravarEstado(`faturamento_completo:${chave}`, "1");
    }
    gravarEstado("faturamento_sync", new Date().toISOString().slice(0, 19).replace("T", " "));
    gravarEstado("faturamento_erro", "");
  } catch (e: any) {
    res.erro = e instanceof MlErro ? e.message : `Falha no faturamento: ${e?.message}`;
    res.completo = false;
    gravarEstado("faturamento_erro", res.erro.slice(0, 300));
    console.error(`[faturamento] ${res.erro}`);
  }
  return res;
}

export function statusFaturamento() {
  const n = (db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT pedido) p FROM ml_faturamento").get() as { n: number; p: number });
  return { lancamentos: n.n, pedidos: n.p, ultimaSync: estado("faturamento_sync") || null, ultimoErro: estado("faturamento_erro") || null, emAndamento: Boolean(sincronizandoFat) };
}

export function lancamentosDoPedido(pedido: string) {
  return db.prepare("SELECT detail_id, periodo, categoria, tipo, subtipo, descricao, valor_centavos, bruto_centavos, data, envio_id FROM ml_faturamento WHERE pedido = ? ORDER BY data, detail_id").all(pedido) as any[];
}

// ---------- Conta da venda (gravada por ocorrência) ----------
export async function atualizarContaVenda(ocId: number, pedidoMl: any, vendedor: string): Promise<void> {
  try {
    let r = resumirPedido(pedidoMl);
    // Pagamento detalhado: traz líquido e liberação quando o pedido não traz
    if (r.pagamentoIds.length && (r.liquido == null || r.liberado == null)) {
      try { r = aplicarPagamento(r, await ml(`/collections/${encodeURIComponent(r.pagamentoIds[0])}`)); }
      catch (e: any) { console.error(`[conta] pagamento ${r.pagamentoIds[0]}: ${e?.message}`); }
    }
    const atual = db.prepare("SELECT * FROM conta_venda WHERE ocorrencia_id = ?").get(ocId) as any | undefined;
    // Frete de ida: consulta uma vez (não muda depois de entregue)
    let freteIda: number | null = atual?.frete_ida_centavos ?? null;
    if (freteIda == null && r.envioIdaId) {
      try { freteIda = custoDoVendedor(await ml(`/shipments/${encodeURIComponent(r.envioIdaId)}/costs`), vendedor); }
      catch (e: any) { console.error(`[conta] custo do envio ${r.envioIdaId}: ${e?.message}`); }
    }
    const textos = (db.prepare("SELECT texto FROM ml_mensagens WHERE ocorrencia_id = ? AND remetente = 'mediator'").all(ocId) as { texto: string }[]).map((x) => x.texto);
    const med = lerMensagemMediador(textos);
    const reputacao = atual?.reputacao_origem === "manual" ? atual.reputacao_afetada : (med.reputacaoAfetada == null ? atual?.reputacao_afetada ?? null : med.reputacaoAfetada ? 1 : 0);
    const reputacaoOrigem = atual?.reputacao_origem === "manual" ? "manual" : med.reputacaoAfetada == null ? atual?.reputacao_origem ?? null : "mediador";
    db.prepare(
      `INSERT INTO conta_venda (ocorrencia_id, preco_centavos, tarifa_centavos, frete_ida_centavos, etiqueta_prevista_centavos, reembolso_centavos, liquido_centavos,
         pagamento_status, liberado, liberacao_em, reputacao_afetada, reputacao_origem, ml_atualizado_em)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(ocorrencia_id) DO UPDATE SET preco_centavos = excluded.preco_centavos, tarifa_centavos = excluded.tarifa_centavos,
         frete_ida_centavos = COALESCE(excluded.frete_ida_centavos, conta_venda.frete_ida_centavos),
         etiqueta_prevista_centavos = COALESCE(excluded.etiqueta_prevista_centavos, conta_venda.etiqueta_prevista_centavos),
         reembolso_centavos = COALESCE(excluded.reembolso_centavos, conta_venda.reembolso_centavos),
         liquido_centavos = COALESCE(excluded.liquido_centavos, conta_venda.liquido_centavos),
         pagamento_status = COALESCE(excluded.pagamento_status, conta_venda.pagamento_status),
         liberado = COALESCE(excluded.liberado, conta_venda.liberado), liberacao_em = COALESCE(excluded.liberacao_em, conta_venda.liberacao_em),
         reputacao_afetada = excluded.reputacao_afetada, reputacao_origem = excluded.reputacao_origem, ml_atualizado_em = datetime('now')`,
    ).run(ocId, r.preco, r.tarifa, freteIda, med.etiquetaPrevista, r.reembolso, r.liquido, r.pagamentoStatus,
      r.liberado == null ? null : r.liberado ? 1 : 0, r.liberacaoEm, reputacao, reputacaoOrigem);
  } catch (e: any) {
    console.error(`[conta] ocorrência ${ocId}: ${e?.message}`);
  }
}

/** Ocorrências do ML que ainda não têm conta ou cujo dinheiro ainda não foi liberado: vale reconsultar. */
export function contasPendentes(limite = 20): { id: number; pedido: string }[] {
  return db.prepare(
    `SELECT o.id, o.pedido FROM ocorrencias o LEFT JOIN conta_venda c ON c.ocorrencia_id = o.id
     WHERE o.origem = 'ml' AND o.anonimizada = 0 AND (c.ocorrencia_id IS NULL OR c.liberado IS NOT 1 OR c.ml_atualizado_em < datetime('now','-1 day'))
       AND (c.ml_atualizado_em IS NULL OR c.ml_atualizado_em < datetime('now','-6 hours'))
     ORDER BY o.criado_em DESC LIMIT ?`,
  ).all(limite) as { id: number; pedido: string }[];
}

// ---------- Venda desfeita e custo do produto que entra no resultado (v1.10.1) ----------
const PAGAMENTO_DESFEITO = new Set(["refunded", "charged_back", "cancelled"]);
const CONFERENCIA_COM_PERDA = new Set(["danificado", "incompleto", "diferente", "sem_produto", "outro"]);

export interface EntradaSituacao {
  preco: number | null; reembolso: number | null; pagamentoStatus: string | null;
  devolucao: { status: string; conferencia: string | null } | null;
  custo: number | null; custoOrigem: string | null;
}

/** A venda foi desfeita (devolução ou reembolso total)? E o custo do produto entra no resultado?
 *  O custo só é prejuízo quando o produto não volta, ou volta com problema; o valor digitado pela equipe sempre entra. */
export function situacaoDaVenda(e: EntradaSituacao): { desfeita: boolean; motivo: string | null; custoConta: number | null; custoNota: string | null } {
  const dev = e.devolucao && e.devolucao.status !== "cancelada" ? e.devolucao : null;
  const reembolsoTotal = e.preco != null && e.preco > 0 && (e.reembolso ?? 0) >= e.preco;
  const motivo = dev ? "Produto em devolução" : PAGAMENTO_DESFEITO.has(String(e.pagamentoStatus)) || reembolsoTotal ? "Dinheiro devolvido ao comprador" : null;
  const desfeita = motivo != null;
  if (e.custo == null) return { desfeita, motivo, custoConta: null, custoNota: null };
  if (e.custoOrigem === "manual") return { desfeita, motivo, custoConta: e.custo, custoNota: "digitado pela equipe" };
  if (!desfeita) return { desfeita, motivo, custoConta: e.custo, custoNota: "custo do cadastro no Tiny" };
  if (!dev) return { desfeita, motivo, custoConta: e.custo, custoNota: "o comprador ficou com o produto" };
  if (dev.status === "nao_entregue") return { desfeita, motivo, custoConta: e.custo, custoNota: "a devolução não chegou" };
  if (dev.conferencia && CONFERENCIA_COM_PERDA.has(dev.conferencia)) return { desfeita, motivo, custoConta: e.custo, custoNota: "o produto voltou com problema" };
  if (dev.conferencia === "ok") return { desfeita, motivo, custoConta: null, custoNota: "não entra: o produto voltou em bom estado" };
  return { desfeita, motivo, custoConta: null, custoNota: "não entra por enquanto: só conta se o produto não voltar ou voltar com problema" };
}

export function contaDa(ocId: number): any | null {
  const c = db.prepare("SELECT c.*, o.pedido FROM conta_venda c JOIN ocorrencias o ON o.id = c.ocorrencia_id WHERE c.ocorrencia_id = ?").get(ocId) as any | undefined;
  if (!c) return null;
  const lanc = lancamentosDoPedido(c.pedido);
  const soma = (cat: Categoria) => lanc.filter((l) => l.categoria === cat).reduce((t, l) => t + l.valor_centavos, 0);
  const etiquetaConfirmada = lanc.some((l) => l.categoria === "etiqueta_devolucao") ? soma("etiqueta_devolucao") : null;
  const etiqueta = etiquetaConfirmada ?? c.etiqueta_prevista_centavos ?? null;
  const creditos = lanc.some((l) => l.categoria === "credito") ? -soma("credito") : 0; // crédito guardado negativo
  const envios = (c.frete_ida_centavos ?? 0) + (etiqueta ?? 0);
  const temBase = c.preco_centavos != null;
  const dev = db.prepare("SELECT status, conferencia FROM devolucoes WHERE ocorrencia_id = ?").get(ocId) as { status: string; conferencia: string | null } | undefined;
  const v = situacaoDaVenda({
    preco: c.preco_centavos, reembolso: c.reembolso_centavos, pagamentoStatus: c.pagamento_status,
    devolucao: dev ?? null, custo: c.custo_produto_centavos, custoOrigem: c.custo_produto_centavos == null ? null : c.custo_origem ?? "manual",
  });
  // Venda normal, como o quadro do ML: preço − tarifa − envios − reembolso.
  // Venda desfeita (v1.10.1), como o "Recebimento devolvido" do ML: o preço volta ao comprador e o frete de ida é
  // cancelado ("Cancelamento de tarifa do Mercado Envios"); fica a tarifa de venda e, se houver, a etiqueta de devolução.
  const totalMl = !temBase ? null : v.desfeita ? -(c.tarifa_centavos ?? 0) - (etiqueta ?? 0) : (c.preco_centavos ?? 0) - (c.tarifa_centavos ?? 0) - envios - (c.reembolso_centavos ?? 0);
  const resultado = totalMl == null ? null : totalMl + creditos - (v.custoConta ?? 0);
  return {
    vendaDesfeita: v.desfeita, motivoDesfeita: v.motivo,
    custoConta: reais(v.custoConta), custoNota: v.custoNota,
    preco: reais(c.preco_centavos), tarifa: reais(c.tarifa_centavos),
    freteIda: reais(c.frete_ida_centavos),
    etiqueta: reais(etiqueta), etiquetaOrigem: etiquetaConfirmada != null ? "faturamento" : c.etiqueta_prevista_centavos != null ? "mediador" : null,
    envios: reais(envios),
    reembolso: reais(c.reembolso_centavos),
    creditos: reais(creditos),
    custoProduto: reais(c.custo_produto_centavos),
    custoOrigem: c.custo_produto_centavos == null ? null : c.custo_origem ?? "manual",
    custoTiny: reais(c.custo_tiny_centavos), custoTinyEm: c.custo_tiny_em ?? null, custoTinyErro: c.custo_tiny_erro ?? null,
    custoTinyItens: (() => { try { return c.custo_tiny_json ? JSON.parse(c.custo_tiny_json) : []; } catch { return []; } })(),
    liquidoHoje: reais(c.liquido_centavos),
    totalMl: reais(totalMl), resultado: reais(resultado),
    pagamentoStatus: c.pagamento_status, liberado: c.liberado == null ? null : Boolean(c.liberado), liberacaoEm: c.liberacao_em,
    pendencia: c.pendencia_ml ?? "nenhuma", pendenciaRotulo: PENDENCIAS_ML[(c.pendencia_ml ?? "nenhuma") as PendenciaMl], pendenciaObs: c.pendencia_obs, pendenciaEm: c.pendencia_em,
    reputacaoAfetada: c.reputacao_afetada == null ? null : Boolean(c.reputacao_afetada), reputacaoOrigem: c.reputacao_origem,
    atualizadoEm: c.ml_atualizado_em,
    lancamentos: lanc.map((l) => ({ categoria: l.categoria, descricao: l.descricao, valor: l.valor_centavos / 100, data: l.data, periodo: l.periodo })),
  };
}

export interface EdicaoConta {
  custoProduto?: number | null;
  pendencia?: PendenciaMl;
  pendenciaObs?: string | null;
  reputacaoAfetada?: boolean | null;
  etiquetaPrevista?: number | null;
}

export function editarConta(ocId: number, e: EdicaoConta, autor: string): any {
  const existe = db.prepare("SELECT 1 FROM conta_venda WHERE ocorrencia_id = ?").get(ocId);
  if (!existe) db.prepare("INSERT INTO conta_venda (ocorrencia_id) VALUES (?)").run(ocId);
  const sets: string[] = []; const args: unknown[] = []; const notas: string[] = [];
  const c = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
  if (e.custoProduto !== undefined) {
    if (e.custoProduto == null) {
      // Apagar o valor digitado volta a usar o custo do Tiny (quando houver)
      sets.push("custo_produto_centavos = custo_tiny_centavos", "custo_origem = CASE WHEN custo_tiny_centavos IS NULL THEN NULL ELSE 'tiny' END");
      notas.push("Custo do produto digitado foi removido; a conta volta a usar o custo do Tiny, quando houver.");
    } else {
      sets.push("custo_produto_centavos = ?", "custo_origem = 'manual'"); args.push(c(e.custoProduto));
      notas.push(`Custo do produto na conta da venda: R$ ${e.custoProduto.toFixed(2).replace(".", ",")} (digitado pela equipe).`);
    }
  }
  if (e.etiquetaPrevista !== undefined) { sets.push("etiqueta_prevista_centavos = ?"); args.push(c(e.etiquetaPrevista)); notas.push("Etiqueta de devolução prevista ajustada."); }
  if (e.pendencia !== undefined) { sets.push("pendencia_ml = ?", "pendencia_em = datetime('now')"); args.push(e.pendencia); notas.push(`Pendência com o ML: ${PENDENCIAS_ML[e.pendencia]}.`); }
  if (e.pendenciaObs !== undefined) { sets.push("pendencia_obs = ?"); args.push(e.pendenciaObs?.trim() || null); }
  if (e.reputacaoAfetada !== undefined) { sets.push("reputacao_afetada = ?", "reputacao_origem = 'manual'"); args.push(e.reputacaoAfetada == null ? null : e.reputacaoAfetada ? 1 : 0); notas.push(e.reputacaoAfetada ? "Reputação afetada." : "Reputação não afetada."); }
  if (!sets.length) return contaDa(ocId);
  args.push(ocId);
  db.transaction(() => {
    db.prepare(`UPDATE conta_venda SET ${sets.join(", ")} WHERE ocorrencia_id = ?`).run(...args);
    for (const t of notas) db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)").run(ocId, t, autor);
    db.prepare("UPDATE ocorrencias SET atualizado_em = datetime('now') WHERE id = ?").run(ocId);
  })();
  return contaDa(ocId);
}
