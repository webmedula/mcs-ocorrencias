import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";
import { db } from "../src/db.js";
import { periodoDe } from "../src/saude.js";

// v1.14.0: reclamações do período para o relatório de saúde do produto (Gerente IA), sem dado pessoal.
let s: Servidor;
let chave = "";
beforeAll(async () => {
  s = await subir();
  chave = (await (await s.painel("POST", "/chaves", { nome: "Gerente IA saude" })).json()).token;
});
afterAll(async () => { await s.fechar(); });

const comoIA = (caminho: string) => fetch(s.url + "/api/admin" + caminho, { headers: { authorization: "Bearer " + chave } });

describe("saúde do produto", () => {
  it("período padrão e validação", () => {
    expect(periodoDe({}, new Date("2026-11-15T12:00:00Z"))).toEqual({ desde: "2026-10-16", ate: "2026-11-15" });
    expect(periodoDe({ desde: "2026-10-01", ate: "2026-10-31" })).toEqual({ desde: "2026-10-01", ate: "2026-10-31" });
    expect(periodoDe({ desde: "2026-10-31", ate: "2026-10-01" })).toBeNull();
    expect(periodoDe({ desde: "ontem" })).toBeNull();
  });

  it("lista as reclamações do período com produto e motivo, sem nome, e-mail ou pedido", async () => {
    const protocolo = await novaOcorrencia(s.url, { pedido: "SAUDE-1", tipo: "defeito", nome: "Fulana Silva", email: "fulana@teste.local" });
    db.prepare("UPDATE ocorrencias SET produto_json = ?, ml_json = ?, criado_em = '2026-10-10 12:00:00' WHERE protocolo = ?").run(
      JSON.stringify([{ item_id: "MLB123", sku: "FAROL-01", titulo: "Farol de milha", qtd: 1 }]),
      JSON.stringify({ motivo: "O produto tem defeito" }),
      protocolo,
    );
    const id = (db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(protocolo) as { id: number }).id;
    db.prepare("INSERT INTO devolucoes (ocorrencia_id, conferencia, conferencia_obs) VALUES (?, 'danificado', 'lente trincada')").run(id);

    const r = await comoIA("/saude-produtos?desde=2026-10-01&ate=2026-10-31");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(1);
    const o = j.ocorrencias[0];
    expect(o).toMatchObject({
      protocolo, tipo: "defeito", motivoMl: "O produto tem defeito", conferencia: "danificado", conferenciaObs: "lente trincada",
      produtos: [{ itemId: "MLB123", sku: "FAROL-01", titulo: "Farol de milha" }],
    });
    const texto = JSON.stringify(j);
    expect(texto).not.toContain("Fulana");
    expect(texto).not.toContain("fulana@");
    expect(texto).not.toContain("SAUDE-1");

    expect((await (await comoIA("/saude-produtos?desde=2026-11-01&ate=2026-11-30")).json()).total).toBe(0);
    expect((await comoIA("/saude-produtos?desde=xx")).status).toBe(400);
  });

  it("o gerente logado também lê", async () => {
    const r = await s.painel("GET", "/saude-produtos");
    expect(r.status).toBe(200); // o gerente vê
  });
});
