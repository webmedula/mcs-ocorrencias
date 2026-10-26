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
