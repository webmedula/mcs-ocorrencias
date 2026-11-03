import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Tiny ligado, respondido aqui mesmo
process.env.TINY_TOKEN = "token-de-teste";
const fetchReal = globalThis.fetch;
const json = (retorno: unknown) => new Response(JSON.stringify({ retorno }), { headers: { "content-type": "application/json" } });
const PRODUTOS: Record<string, any> = {
  // Produto simples com preço de custo e custo médio
  "21": { id: "21", classe_produto: "S", preco_custo: "26.60", preco_custo_medio: "25.00" },
  // Variação sem custo: usa o do pai (30)
  "31": { id: "31", classe_produto: "V", idProdutoPai: "30", preco_custo: "0" },
  "30": { id: "30", classe_produto: "V", preco_custo: "12.18" },
  // Kit: 2 × produto 21 + 1 × produto 30
  "40": { id: "40", classe_produto: "K", preco_custo: "0", kit: [{ item: { id_produto: "21", quantidade: "2" } }, { item: { id_produto: "30", quantidade: "1" } }] },
  // Sem custo nenhum
  "50": { id: "50", classe_produto: "S", preco_custo: "0", preco_custo_medio: "0" },
};
const PEDIDOS: Record<string, any[]> = {
  "7001": [{ id_produto: "21", codigo: "MCS1199", descricao: "Tomada USB", quantidade: "2" }, { id_produto: "31", codigo: "CAB-P", descricao: "Cabo preto", quantidade: "1" }],
  "7002": [{ id_produto: "40", codigo: "KIT", descricao: "Kit", quantidade: "1" }],
  "7003": [{ id_produto: "21", codigo: "MCS1199", descricao: "Tomada USB", quantidade: "1" }, { id_produto: "50", codigo: "SEMCUSTO", descricao: "Sem custo", quantidade: "1" }],
};
vi.stubGlobal("fetch", async (entrada: any, init?: any) => {
  const url = new URL(String(entrada instanceof URL ? entrada.href : entrada?.url ?? entrada));
  if (url.hostname === "api.tiny.com.br") {
    const ep = url.pathname.split("/").pop()!;
    const id = url.searchParams.get("id") ?? "";
    if (ep === "pedidos.pesquisa.php" && url.searchParams.get("numeroEcommerce") === "2000555")
      return json({ status: "OK", pedidos: [{ pedido: { id: "7001", numero: "1", numero_ecommerce: "2000555" } }] });
    if (ep === "pedido.obter.php" && PEDIDOS[id]) return json({ status: "OK", pedido: { itens: PEDIDOS[id].map((item) => ({ item })) } });
    if (ep === "produto.obter.php" && PRODUTOS[id]) return json({ status: "OK", produto: PRODUTOS[id] });
    return json({ status: "Erro", erros: [{ erro: "A consulta não retornou registros" }] });
  }
  if (url.hostname !== "127.0.0.1") throw new Error("fetch inesperado: " + url.href);
  return fetchReal(entrada, init);
});

const { db } = await import("../src/db.js");
const { atualizarCustoTiny, completarCustosTiny } = await import("../src/custo.js");
const { contaDa, editarConta } = await import("../src/conta.js");
const { custoDoCadastro } = await import("../src/tiny.js");
const { subir } = await import("./ajuda.js");
type Servidor = Awaited<ReturnType<typeof subir>>;

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); vi.unstubAllGlobals(); });

let n = 0;
function ocMl(pedido: string, idTiny: string | null) {
  const p = `MCS-CUSTO-${++n}`;
  const r = db.prepare(
    `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id, tiny_status, tiny_json)
     VALUES (?, 'mercado_livre', ?, 'defeito', 'x', 'Comprador', '', 'ml', ?, ?, ?)`,
  ).run(p, pedido, `CU${n}`, idTiny ? "encontrado" : "nao_encontrado", idTiny ? JSON.stringify({ id: idTiny }) : null);
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO conta_venda (ocorrencia_id, preco_centavos, tarifa_centavos) VALUES (?, 10000, 1000)").run(id);
  return { id, protocolo: p };
}

describe("custo do produto pelo Tiny", () => {
  it("escolhe preço de custo ou custo médio", () => {
    expect(custoDoCadastro({ preco_custo: "26.60", preco_custo_medio: "25" })).toBe(26.6);
    expect(custoDoCadastro({ preco_custo: "26.60", preco_custo_medio: "25" }, "medio")).toBe(25);
    expect(custoDoCadastro({ preco_custo: "0", preco_custo_medio: "25" })).toBe(25);
    expect(custoDoCadastro({ preco_custo: "0" })).toBeNull();
  });

  it("soma custo × quantidade (variação usa o custo do pai) e entra no resultado", async () => {
    const o = ocMl("2000111", "7001");
    expect(await atualizarCustoTiny(o.id)).toBe(true);
    const c = contaDa(o.id);
    expect(c.custoProduto).toBe(65.38); // 2 × 26,60 + 12,18
    expect(c.custoOrigem).toBe("tiny");
    expect(c.custoTinyItens).toEqual([
      { sku: "MCS1199", titulo: "Tomada USB", qtd: 2, unitario: 26.6, total: 53.2 },
      { sku: "CAB-P", titulo: "Cabo preto", qtd: 1, unitario: 12.18, total: 12.18 },
    ]);
    expect(c.resultado).toBe(24.62);
  });

  it("kit soma os componentes", async () => {
    const o = ocMl("2000222", "7002");
    await atualizarCustoTiny(o.id);
    expect(contaDa(o.id).custoProduto).toBe(65.38);
  });

  it("produto sem custo no cadastro deixa a conta sem custo e avisa", async () => {
    const o = ocMl("2000333", "7003");
    expect(await atualizarCustoTiny(o.id)).toBe(false);
    const c = contaDa(o.id);
    expect(c.custoProduto).toBeNull();
    expect(c.custoTinyErro).toMatch(/SEMCUSTO/);
  });

  it("valor digitado pela equipe vale mais que o do Tiny; apagar volta ao Tiny", async () => {
    const o = ocMl("2000444", "7001");
    await atualizarCustoTiny(o.id);
    editarConta(o.id, { custoProduto: 10 }, "Teste");
    await atualizarCustoTiny(o.id);
    expect(contaDa(o.id)).toMatchObject({ custoProduto: 10, custoOrigem: "manual", custoTiny: 65.38 });
    editarConta(o.id, { custoProduto: null }, "Teste");
    expect(contaDa(o.id)).toMatchObject({ custoProduto: 65.38, custoOrigem: "tiny" });
  });

  it("a rotina busca o pedido no Tiny quando a importação não achou, e o botão do painel funciona", async () => {
    const o = ocMl("2000555", null);
    expect(await completarCustosTiny(50)).toBeGreaterThanOrEqual(1);
    expect(contaDa(o.id).custoProduto).toBe(65.38);
    const r = await s.painel("POST", `/ocorrencias/${o.protocolo}/custo-tiny`);
    expect(r.status).toBe(200);
    expect((await r.json()).custoTiny).toBe(65.38);
  });
});
