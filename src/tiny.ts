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

async function pesquisar(param: "numeroEcommerce" | "numero", valor: string) {
  const url = new URL(`${config.tinyBaseUrl}/pedidos.pesquisa.php`);
  url.searchParams.set("token", config.tinyToken);
  url.searchParams.set("formato", "json");
  url.searchParams.set(param, valor);

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
    const lista: any[] = retorno.pedidos ?? [];
    return lista.length ? lista[0].pedido : null;
  } finally {
    clearTimeout(timer);
  }
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
