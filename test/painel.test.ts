import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

describe("desfecho e custo", () => {
  it("registra, valida e entra nos números", async () => {
    const p = await novaOcorrencia(s.url);
    expect((await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "inventado", custo: 1 })).status).toBe(400);
    expect((await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "reenvio", custo: -5 })).status).toBe(400);

    const r = await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "reenvio", custo: 49.9 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ desfecho: "reenvio", custo: 49.9 });
    await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "resolvida" });

    const d = await (await s.painel("GET", `/ocorrencias/${p}`)).json();
    expect(d.desfecho).toBe("reenvio");
    expect(d.custo_centavos).toBe(4990);
    expect(d.resolvida_em).toBeTruthy();
    expect(d.eventos.some((e: any) => e.texto === "Desfecho registrado: Reenvio do produto · custo R$ 49,90." && e.publico === 0)).toBe(true);

    const n = await (await s.painel("GET", "/estatisticas?dias=30")).json();
    expect(n.custoTotal).toBeCloseTo(49.9);
    expect(n.porDesfecho).toContainEqual({ k: "reenvio", n: 1, custo: 49.9 });
  });

  it("reabrir limpa a data de resolução; tirar o desfecho zera o custo", async () => {
    const p = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "resolvida" });
    await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "em_analise" });
    await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "cupom", custo: 10 });
    await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: null, custo: 10 });
    const o = db.prepare("SELECT resolvida_em, desfecho, custo_centavos FROM ocorrencias WHERE protocolo = ?").get(p);
    expect(o).toEqual({ resolvida_em: null, desfecho: null, custo_centavos: null });
  });
});

describe("exportar CSV", () => {
  it("exige login", async () => {
    expect((await fetch(s.url + "/api/admin/ocorrencias.csv")).status).toBe(401);
  });

  it("respeita os filtros e registra quem exportou", async () => {
    const shopee = await novaOcorrencia(s.url, { canal: "shopee", nome: "=Fórmula; Perigosa" });
    const loja = await novaOcorrencia(s.url, { canal: "loja_propria" });
    const r = await fetch(s.url + "/api/admin/ocorrencias.csv?canal=shopee", { headers: { cookie: s.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="ocorrencias-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: o Excel abre com acentos certos
    const csv = bytes.toString("utf8");
    expect(csv.split("\r\n")[0]).toContain("Protocolo;Aberta em;Origem;Canal");
    expect(csv).toContain(shopee);
    expect(csv).not.toContain(loja);
    expect(csv).toContain(`"'=Fórmula; Perigosa"`);
    const reg = db.prepare("SELECT detalhe FROM registro WHERE tipo = 'lista_exportada' ORDER BY id DESC").get() as { detalhe: string };
    expect(reg.detalhe).toMatch(/ocorrência\(s\)$/);
  });
});
