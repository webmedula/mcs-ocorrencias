import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { codigosDoBipe } from "../src/admin.js";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

// v1.18.0: leitor de código de barras na aba Devoluções
let s: Servidor;
let caso = "";
beforeAll(async () => {
  s = await subir();
  caso = await novaOcorrencia(s.url, { pedido: "2000012345678901" });
  const id = (db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(caso) as { id: number }).id;
  db.prepare("UPDATE ocorrencias SET origem = 'ml', ml_claim_id = '5311112222' WHERE id = ?").run(id);
  db.prepare("INSERT INTO devolucoes (ocorrencia_id, status, envio_id, return_id, rastreio) VALUES (?, 'em_transito', '44187654321', '22011112222', 'QR123456789BR')").run(id);
  await novaOcorrencia(s.url, { pedido: "OUTRO-1" });
});
afterAll(async () => { await s.fechar(); });

const bipar = async (codigo: string) => (await s.painel("GET", "/bipar?codigo=" + encodeURIComponent(codigo))).json();

describe("bipar pacote", () => {
  it("tira os códigos do que o leitor digitou, inclusive o JSON do QR do Mercado Livre", () => {
    expect(codigosDoBipe(" 44187654321 ")).toEqual(["44187654321"]);
    expect(codigosDoBipe('{"id":"44187654321","t":"lm"}')).toContain("44187654321");
    // teclado em outro layout troca as aspas e os dois-pontos
    expect(codigosDoBipe("{`id`Ç`44187654321`,`t`Ç`lm`}")).toContain("44187654321");
    expect(codigosDoBipe("qr123456789br")).toContain("QR123456789BR");
  });

  it("acha o caso pelo envio da devolução, QR, rastreio, devolução, reclamação, pedido e protocolo", async () => {
    for (const c of ["44187654321", '{"id":"44187654321","t":"lm"}', "qr123456789br", "22011112222", "5311112222", "2000012345678901", caso.toLowerCase()]) {
      const r = await bipar(c);
      expect(r.itens.map((i: any) => i.protocolo), c).toEqual([caso]);
    }
  });

  it("não acha por trecho nem código desconhecido", async () => {
    expect((await bipar("4418765")).itens).toEqual([]);
    expect((await bipar("99999999999")).itens).toEqual([]);
    expect((await s.painel("GET", "/bipar?codigo=")).status).toBe(400);
  });
});
