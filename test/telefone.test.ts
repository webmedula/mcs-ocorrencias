import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subir, type Servidor } from "./ajuda.js";
import { telefoneValido } from "../src/app.js";

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

function enviar(telefone?: string) {
  const f = new FormData();
  const campos: Record<string, string> = {
    canal: "shopee", pedido: "PED-123", tipo: "defeito", descricao: "Produto chegou quebrado na caixa.",
    nome: "Cliente Teste", email: "cliente@teste.local", consentimento: "true",
  };
  if (telefone !== undefined) campos.telefone = telefone;
  for (const [k, v] of Object.entries(campos)) f.append(k, v);
  return fetch(s.url + "/api/ocorrencias", { method: "POST", body: f });
}

describe("telefone obrigatório no formulário (v1.15.0)", () => {
  it("aceita celular, fixo e +55 em vários formatos", () => {
    for (const t of ["(11) 98765-4321", "11987654321", "+55 11 98765-4321", "5511987654321", "(31) 3333-4444", "011 98765-4321"])
      expect(telefoneValido(t), t).toBe(true);
  });
  it("recusa sem DDD, curto, celular sem 9 e letras", () => {
    for (const t of ["98765-4321", "1234", "(11) 8765-43210", "(11) 88765-4321", "abc", ""])
      expect(telefoneValido(t), t).toBe(false);
  });
  it("o servidor recusa ocorrência sem telefone ou com telefone inválido, com mensagem clara", async () => {
    for (const t of [undefined, "", "98765-4321"]) {
      const r = await enviar(t);
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.campos.telefone).toMatch(/DDD/);
    }
    expect((await enviar("(11) 98765-4321")).status).toBeLessThan(300);
  });
});
