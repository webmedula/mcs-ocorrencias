import { afterAll, describe, expect, it, vi } from "vitest";

// Tiny e ml-analytics ligados, respondidos aqui mesmo
process.env.TINY_TOKEN = "token-de-teste";
process.env.ANALYTICS_BASE_URL = "http://analytics.teste/";
process.env.ANALYTICS_API_KEY = "chave-analytics";
const json = (retorno: unknown) => new Response(JSON.stringify({ retorno }), { headers: { "content-type": "application/json" } });
const PRODUTOS: Record<string, any> = {
  "21": { id: "21", classe_produto: "S", preco_custo: "26.60" },
  "30": { id: "30", classe_produto: "S", preco_custo: "12.18" },
};
const PEDIDOS: Record<string, any[]> = {
  "8001": [{ id_produto: "21", codigo: "mcs1199", descricao: "Tomada USB", quantidade: "2" }, { id_produto: "30", codigo: "CAB-P", descricao: "Cabo", quantidade: "1" }],
};
let analyticsFora = false;
const pedidosAnalytics: string[] = [];
vi.stubGlobal("fetch", async (entrada: any, init?: any) => {
  const url = new URL(String(entrada instanceof URL ? entrada.href : entrada?.url ?? entrada));
  if (url.hostname === "analytics.teste") {
    pedidosAnalytics.push(url.searchParams.get("skus") ?? "");
    if (analyticsFora) return new Response("fora", { status: 502 });
    if (init?.headers?.["x-api-key"] !== "chave-analytics") return new Response("{}", { status: 401 });
    // Só o MCS1199 tem custo na ficha (diferente do Tiny, para provar de onde veio); CAB-P está sem custo lá
    return new Response(JSON.stringify({ porSku: { MCS1199: { sku: "MCS1199", custoUnitario: 25, impostoPct: 10 }, "CAB-P": { sku: "CAB-P", custoUnitario: null } } }));
  }
  if (url.hostname === "api.tiny.com.br") {
    const ep = url.pathname.split("/").pop()!;
    const id = url.searchParams.get("id") ?? "";
    if (ep === "pedido.obter.php" && PEDIDOS[id]) return json({ status: "OK", pedido: { itens: PEDIDOS[id].map((item) => ({ item })) } });
    if (ep === "produto.obter.php" && PRODUTOS[id]) return json({ status: "OK", produto: PRODUTOS[id] });
    return json({ status: "Erro", erros: [{ erro: "A consulta não retornou registros" }] });
  }
  throw new Error("fetch inesperado: " + url.href);
});
afterAll(() => vi.unstubAllGlobals());

const { custosDoPedido, limparCacheCusto } = await import("../src/tiny.js");
const { limparCacheFichas } = await import("../src/analytics.js");

describe("custo do produto pela ficha de lucro do ml-analytics", () => {
  it("usa o custo da ficha e cai no Tiny para o SKU sem custo lá", async () => {
    const c = await custosDoPedido("8001");
    expect(c.itens).toEqual([
      { sku: "mcs1199", titulo: "Tomada USB", qtd: 2, unitario: 25, total: 50, origem: "ficha" },
      { sku: "CAB-P", titulo: "Cabo", qtd: 1, unitario: 12.18, total: 12.18 },
    ]);
    expect(c.total).toBe(62.18);
    expect(pedidosAnalytics.at(-1)).toBe("MCS1199,CAB-P");
  });

  it("guarda a ficha por 30 minutos", async () => {
    const antes = pedidosAnalytics.length;
    await custosDoPedido("8001");
    expect(pedidosAnalytics.length).toBe(antes);
  });

  it("analytics fora do ar: segue só pelo Tiny, sem quebrar", async () => {
    limparCacheFichas(); limparCacheCusto(); analyticsFora = true;
    const c = await custosDoPedido("8001");
    expect(c.itens.map((i) => i.unitario)).toEqual([26.6, 12.18]);
    expect(c.itens.some((i) => i.origem)).toBe(false);
    expect(c.total).toBe(65.38);
  });
});
