import { config } from "./config.js";

export type TinyResultado =
  | { status: "desligado" }
  | { status: "nao_encontrado" }
  | { status: "erro"; detalhe: string }
  | {
      status: "encontrado";
      pedido: {
        id: string;
        numero: string;
        numeroEcommerce: string;
        data: string;
        cliente: string;
        valor: string;
        situacao: string;
      };
    };

/** Chamada à API v2. Devolve `retorno`, ou null quando o Tiny diz que não há registros. */
async function chamar(endpoint: string, params: Record<string, string>): Promise<any | null> {
  const url = new URL(`${config.tinyBaseUrl}/${endpoint}`);
  url.searchParams.set("token", config.tinyToken);
  url.searchParams.set("formato", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    const retorno = json?.retorno;
    if (retorno?.status !== "OK") {
      // Tiny devolve erro "A consulta não retornou registros" quando não há resultado.
      const erros = JSON.stringify(retorno?.erros ?? "");
      if (/n[aã]o retornou registros/i.test(erros)) return null;
      throw new Error(erros || "resposta inesperada do Tiny");
    }
    return retorno;
  } finally {
    clearTimeout(timer);
  }
}

async function pesquisar(param: "numeroEcommerce" | "numero", valor: string) {
  const retorno = await chamar("pedidos.pesquisa.php", { [param]: valor });
  const lista: any[] = retorno?.pedidos ?? [];
  return lista.length ? lista[0].pedido : null;
}

/** Busca o pedido no Tiny. Nunca lança: qualquer falha vira status "erro". */
export async function buscarPedido(numeroPedido: string): Promise<TinyResultado> {
  if (!config.tinyToken) return { status: "desligado" };
  try {
    // Pedidos de marketplace costumam ficar em "numero_ecommerce"; tenta ele primeiro.
    const p =
      (await pesquisar("numeroEcommerce", numeroPedido)) ??
      (await pesquisar("numero", numeroPedido));
    if (!p) return { status: "nao_encontrado" };
    return {
      status: "encontrado",
      pedido: {
        id: String(p.id ?? ""),
        numero: String(p.numero ?? ""),
        numeroEcommerce: String(p.numero_ecommerce ?? ""),
        data: String(p.data_pedido ?? ""),
        cliente: String(p.nome ?? ""),
        valor: String(p.valor ?? ""),
        situacao: String(p.situacao ?? ""),
      },
    };
  } catch (e: any) {
    return { status: "erro", detalhe: String(e?.message ?? e) };
  }
}

// ---------- Produtos do pedido (v1.7.0) ----------
const MAX_ITENS = 5;
const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
};

/** Primeira imagem do cadastro do produto: anexo (guardado no próprio Tiny) ou imagem externa. */
function primeiraImagem(produto: any): string | null {
  const anexos: any[] = Array.isArray(produto?.anexos) ? produto.anexos : [];
  const externas: any[] = Array.isArray(produto?.imagens_externas) ? produto.imagens_externas : [];
  const url = anexos.map((a) => a?.anexo).find((u) => typeof u === "string" && u)
    ?? externas.map((e) => e?.imagem_externa?.url).find((u) => typeof u === "string" && u);
  return url ?? null;
}

async function obterProduto(id: string): Promise<any | null> {
  const r = await chamar("produto.obter.php", { id });
  return r?.produto ?? null;
}

export interface ItemTiny {
  id_produto: string | null; titulo: string | null; sku: string | null; qtd: number | null; preco: number | null;
  variacao: string | null; imagem: string | null;
}

/**
 * Itens do pedido com a imagem do cadastro do produto (a variação sem foto usa a do produto pai).
 * Lança em caso de falha (quem chama tenta de novo depois); pedido sem itens devolve [].
 */
export async function itensDoPedido(idPedido: string): Promise<ItemTiny[]> {
  if (!config.tinyToken || !idPedido) return [];
  const r = await chamar("pedido.obter.php", { id: idPedido });
  const itens: any[] = (r?.pedido?.itens ?? []).map((x: any) => x?.item ?? x).slice(0, MAX_ITENS);
  const out: ItemTiny[] = [];
  for (const it of itens) {
    const idProduto = it?.id_produto != null && String(it.id_produto) !== "" ? String(it.id_produto) : null;
    let imagem: string | null = null;
    let variacao: string | null = null;
    if (idProduto) {
      try {
        const p = await obterProduto(idProduto);
        imagem = primeiraImagem(p);
        const grade = p?.grade && typeof p.grade === "object" ? Object.values(p.grade).filter((v) => typeof v === "string" && v).join(" / ") : "";
        variacao = grade || null;
        const pai = p?.idProdutoPai ?? p?.id_produto_pai;
        if (!imagem && pai && String(pai) !== "0") imagem = primeiraImagem(await obterProduto(String(pai)));
      } catch (e: any) {
        console.error(`[tiny] produto ${idProduto}: ${e?.message}`);
      }
    }
    out.push({
      id_produto: idProduto,
      titulo: it?.descricao ? String(it.descricao) : null,
      sku: it?.codigo ? String(it.codigo) : null,
      qtd: num(it?.quantidade),
      preco: num(it?.valor_unitario),
      variacao,
      imagem,
    });
  }
  return out;
}

// ---------- Custo dos produtos do pedido (v1.10.0) ----------
// O mesmo "Custo produtos" do relatório de custos do e-commerce do Tiny: custo do cadastro × quantidade.
const CACHE_CUSTO_MS = 6 * 60 * 60 * 1000;
const cacheProduto = new Map<string, { em: number; p: any }>();
async function produtoComCache(id: string): Promise<any | null> {
  const c = cacheProduto.get(id);
  if (c && Date.now() - c.em < CACHE_CUSTO_MS) return c.p;
  const p = await obterProduto(id);
  cacheProduto.set(id, { em: Date.now(), p });
  return p;
}
export const limparCacheCusto = () => cacheProduto.clear();

/** Custo unitário lido do cadastro: preço de custo (ou custo médio, com TINY_CUSTO=medio), com o outro de reserva. */
export function custoDoCadastro(p: any, preferir: "custo" | "medio" = config.tinyCusto): number | null {
  const custo = num(p?.preco_custo), medio = num(p?.preco_custo_medio);
  const ordem = preferir === "medio" ? [medio, custo] : [custo, medio];
  return ordem.find((v) => v != null && v > 0) ?? null;
}

/** Custo unitário de um produto: kit soma os componentes; variação sem custo usa o do produto pai. */
async function custoUnitario(id: string, nivel = 0): Promise<number | null> {
  const p = await produtoComCache(id);
  if (!p) return null;
  const kit: any[] = Array.isArray(p.kit) ? p.kit.map((k: any) => k?.item ?? k) : [];
  if (String(p.classe_produto ?? "").toUpperCase() === "K" && kit.length && nivel < 2) {
    let total = 0;
    for (const k of kit) {
      const idc = k?.id_produto != null ? String(k.id_produto) : "";
      const qtd = num(k?.quantidade) ?? 1;
      const cu = idc ? await custoUnitario(idc, nivel + 1) : null;
      if (cu == null) return custoDoCadastro(p); // componente sem custo: tenta o custo do próprio kit
      total += cu * qtd;
    }
    return total;
  }
  const proprio = custoDoCadastro(p);
  if (proprio != null) return proprio;
  const pai = p.idProdutoPai ?? p.id_produto_pai;
  return pai && String(pai) !== "0" && nivel < 2 ? custoUnitario(String(pai), nivel + 1) : null;
}

export interface CustoItem { sku: string | null; titulo: string | null; qtd: number; unitario: number | null; total: number | null }
export interface CustoPedido { itens: CustoItem[]; total: number | null; faltando: string[] }

/** Custo dos itens do pedido no Tiny, em reais. `total` fica null se algum item não tem custo no cadastro. Lança se o Tiny falhar. */
export async function custosDoPedido(idPedido: string): Promise<CustoPedido> {
  const r = await chamar("pedido.obter.php", { id: idPedido });
  const itens: any[] = (r?.pedido?.itens ?? []).map((x: any) => x?.item ?? x).slice(0, 20);
  const out: CustoItem[] = [];
  const faltando: string[] = [];
  for (const it of itens) {
    const id = it?.id_produto != null && String(it.id_produto) !== "" && String(it.id_produto) !== "0" ? String(it.id_produto) : null;
    const qtd = num(it?.quantidade) ?? 1;
    const unitario = id ? await custoUnitario(id) : null;
    const nome = it?.codigo ? String(it.codigo) : it?.descricao ? String(it.descricao) : "item sem código";
    if (unitario == null) faltando.push(nome);
    out.push({
      sku: it?.codigo ? String(it.codigo) : null, titulo: it?.descricao ? String(it.descricao) : null, qtd,
      unitario: unitario == null ? null : Math.round(unitario * 100) / 100,
      total: unitario == null ? null : Math.round(unitario * qtd * 100) / 100,
    });
  }
  const total = out.length && !faltando.length ? Math.round(out.reduce((t, i) => t + (i.total ?? 0), 0) * 100) / 100 : null;
  return { itens: out, total, faltando };
}
