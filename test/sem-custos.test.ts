import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

// v1.17.0: o perfil Atendimento (funcionário das devoluções) não vê nem lança custos e valores
let s: Servidor;
let cookie = "";
let caso = "";
beforeAll(async () => {
  s = await subir();
  const r = await s.painel("POST", "/usuarios", { nome: "Rui Devolucoes", email: "rui@equipe.local", senha: "senha-forte-do-rui", papel: "atendimento" });
  const id = (await r.json()).id;
  const login = await fetch(s.url + "/api/admin/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "rui@equipe.local", senha: "senha-forte-do-rui" }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  caso = await novaOcorrencia(s.url, { pedido: "CUSTO-1" });
  await s.painel("PATCH", `/ocorrencias/${caso}/responsavel`, { usuarioId: id });
  await s.painel("PATCH", `/ocorrencias/${caso}/desfecho`, { desfecho: "reenvio", custo: 49.9 });
  const oc = db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(caso) as { id: number };
  db.prepare("INSERT INTO devolucoes (ocorrencia_id, origem, status, frete_centavos, perda_centavos) VALUES (?, 'ml', 'recebida', 2345, 8000)").run(oc.id);
});
afterAll(async () => { await s.fechar(); });

const comoRui = (metodo: string, caminho: string, corpo?: unknown) =>
  fetch(s.url + "/api/admin" + caminho, {
    method: metodo,
    headers: { cookie, "x-requested-with": "painel", ...(corpo ? { "content-type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

describe("perfil Atendimento sem custos", () => {
  it("o detalhe não traz custo, conta nem quadro de custos da devolução, e o histórico esconde os valores", async () => {
    const d = await (await comoRui("GET", `/ocorrencias/${caso}`)).json();
    expect(d.custo_centavos).toBeNull();
    expect(d.conta).toBeNull();
    expect(d.devolucao.custos).toBeNull();
    expect(d.devolucao.status).toBe("recebida");
    expect(JSON.stringify(d.eventos)).not.toContain("49,90");
    expect((await (await comoRui("GET", `/ocorrencias/${caso}/devolucao`)).json()).custos).toBeNull();
    // o gerente continua vendo
    const g = await (await s.painel("GET", `/ocorrencias/${caso}`)).json();
    expect(g.custo_centavos).toBe(4990);
    expect(g.devolucao.custos.frete).toBe(23.45);
  });

  it("a lista de devoluções vem sem a coluna de custo", async () => {
    const l = await (await comoRui("GET", "/devolucoes")).json();
    const item = l.itens.find((i: any) => i.protocolo === caso);
    expect(item).toBeTruthy();
    expect(item.custo).toBeNull();
  });

  it("escolhe o desfecho sem apagar o custo do gerente, mas não lança custos", async () => {
    const r = await comoRui("PATCH", `/ocorrencias/${caso}/desfecho`, { desfecho: "troca" });
    expect(r.status).toBe(200);
    expect((await r.json()).custo).toBeNull();
    expect((db.prepare("SELECT desfecho, custo_centavos FROM ocorrencias WHERE protocolo = ?").get(caso) as any)).toEqual({ desfecho: "troca", custo_centavos: 4990 });
    expect((await comoRui("PATCH", `/ocorrencias/${caso}/desfecho`, { desfecho: "troca", custo: 1 })).status).toBe(403);
    expect((await comoRui("PATCH", `/ocorrencias/${caso}/devolucao`, { frete: 10 })).status).toBe(403);
    // conferência do produto continua liberada
    const conf = await comoRui("PATCH", `/ocorrencias/${caso}/devolucao`, { conferencia: "ok" });
    expect(conf.status).toBe(200);
    expect((await conf.json()).custos).toBeNull();
  });

  it("CSV, conta da venda, custo do Tiny e números ficam bloqueados", async () => {
    expect((await comoRui("GET", "/ocorrencias.csv")).status).toBe(403);
    expect((await comoRui("PATCH", `/ocorrencias/${caso}/conta`, { custoProduto: 10 })).status).toBe(403);
    expect((await comoRui("POST", `/ocorrencias/${caso}/conta/atualizar`)).status).toBe(403);
    expect((await comoRui("POST", `/ocorrencias/${caso}/custo-tiny`)).status).toBe(403);
    expect((await comoRui("GET", "/estatisticas")).status).toBe(403);
    expect((await comoRui("GET", `/ocorrencias/${caso}/ml/financeiro-bruto`)).status).toBe(403);
  });
});
