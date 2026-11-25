import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subir, type Servidor } from "./ajuda.js";

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

describe("política de privacidade", () => {
  it("traz o CNPJ da MCS sem precisar de variável", async () => {
    const cfg = await (await fetch(s.url + "/api/config")).json();
    expect(cfg.cnpj).toBe("39.501.387/0001-03");
  });
});
