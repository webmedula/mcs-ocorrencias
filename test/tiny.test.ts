import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Tiny ligado, mas respondido aqui mesmo: nada sai para a internet
process.env.TINY_TOKEN = "token-de-teste";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60)]);
let falharItens = false;
const chamadas: string[] = [];
const fetchReal = globalThis.fetch;
const json = (retorno: unknown) => new Response(JSON.stringify({ retorno }), { headers: { "content-type": "application/json" } });
vi.stubGlobal("fetch", async (entrada: any, init?: any) => {
  const url = new URL(String(entrada instanceof URL ? entrada.href : entrada?.url ?? entrada));
  if (url.hostname === "api.tiny.com.br") {
    const ep = url.pathname.split("/").pop()!;
    chamadas.push(ep + (url.searchParams.get("id") ? ":" + url.searchParams.get("id") : ""));
    if (ep === "pedidos.pesquisa.php")
      return json({ status: "OK", pedidos: [{ pedido: { id: "900", numero: "15", numero_ecommerce: url.searchParams.get("numeroEcommerce"), data_pedido: "20/10/2026", nome: "Cliente", valor: "99.90", situacao: "Enviado" } }] });
    if (ep === "pedido.obter.php") {
      if (falharItens) return new Response("erro", { status: 503 });
      return json({ status: "OK", pedido: { itens: [
        { item: { id_produto: "11", codigo: "CAM-P", descricao: "Camiseta Preta P", quantidade: "2.00", valor_unitario: "49.90" } },
        { item: { id_produto: "12", codigo: "BON", descricao: "Boné", quantidade: "1", valor_unitario: "30" } },
      ] } });
    }
    if (ep === "produto.obter.php") {
      const id = url.searchParams.get("id");
      // 11 é variação sem foto: a imagem vem do produto pai (10)
      if (id === "11") return json({ status: "OK", produto: { id: "11", idProdutoPai: "10", grade: { Cor: "Preta", Tamanho: "P" }, anexos: [] } });
      if (id === "10") return json({ status: "OK", produto: { id: "10", anexos: [{ anexo: "https://cdn.exemplo.com/camiseta.png" }] } });
      if (id === "12") return json({ status: "OK", produto: { id: "12", anexos: [], imagens_externas: [{ imagem_externa: { url: "http://127.0.0.1/interno.png" } }] } });
    }
    return json({ status: "Erro", erros: [{ erro: "A consulta não retornou registros" }] });
  }
  if (url.hostname === "cdn.exemplo.com") return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (url.hostname !== "127.0.0.1") throw new Error("fetch inesperado: " + url.href);
  return fetchReal(entrada, init);
});

const { db } = await import("../src/db.js");
const { completarPendentesTiny } = await import("../src/produtos.js");
const { novaOcorrencia, subir } = await import("./ajuda.js");
type Servidor = Awaited<ReturnType<typeof subir>>;

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); vi.unstubAllGlobals(); });

const produtoJson = (p: string) => (db.prepare("SELECT produto_json FROM ocorrencias WHERE protocolo = ?").get(p) as { produto_json: string | null }).produto_json;
async function esperarProdutos(p: string) {
  for (let i = 0; i < 50 && !produtoJson(p); i++) await new Promise((ok) => setTimeout(ok, 20));
}

describe("produtos do pedido pelo Tiny", () => {
  it("grava itens, SKU, variação e a foto (do produto pai) logo depois do registro", async () => {
    const p = await novaOcorrencia(s.url, { pedido: "SHP-777" });
    await esperarProdutos(p);
    const d = await (await s.painel("GET", `/ocorrencias/${p}`)).json();
    expect(d.tiny_status).toBe("encontrado");
    expect(d.produtos).toHaveLength(2);
    expect(d.produtos[0]).toMatchObject({ titulo: "Camiseta Preta P", sku: "CAM-P", qtd: 2, preco: 49.9, variacao: "Preta / P", permalink: null });
    expect(d.produtos[0].foto).toMatch(/^[a-f0-9]{16}\.png$/);
    // Imagem em endereço interno não é baixada
    expect(d.produtos[1]).toMatchObject({ titulo: "Boné", foto: null });

    const img = await fetch(`${s.url}/api/admin/produto-img/${d.produtos[0].foto}`, { headers: { cookie: s.cookie } });
    expect(img.status).toBe(200);
    const lista = (await (await s.painel("GET", "/ocorrencias")).json()).itens.find((i: any) => i.protocolo === p);
    expect(lista.produto).toEqual({ foto: d.produtos[0].foto, titulo: "Camiseta Preta P" });
  });

  it("se o Tiny falhar, a rotina completa depois", async () => {
    falharItens = true;
    const p = await novaOcorrencia(s.url, { pedido: "SHP-888" });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(produtoJson(p)).toBeNull();

    falharItens = false;
    expect(await completarPendentesTiny()).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(produtoJson(p)!)).toHaveLength(2);
    expect(chamadas).toContain("pedido.obter.php:900");
  });
});
