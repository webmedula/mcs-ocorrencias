import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

// v1.12.0: a chave do Gerente IA passa a LER o que antes era só do gerente humano (ML, equipe, backups, registro).
// As ações continuam fechadas para a chave.
let s: Servidor;
let chave = "";
let chaveId = 0;
beforeAll(async () => {
  s = await subir();
  const r = await s.painel("POST", "/chaves", { nome: "Gerente IA de teste" });
  const j = await r.json();
  chave = j.token;
  chaveId = j.id;
});
afterAll(async () => { await s.fechar(); });

const comoIA = (metodo: string, caminho: string, corpo?: unknown) =>
  fetch(s.url + "/api/admin" + caminho, {
    method: metodo,
    headers: { authorization: "Bearer " + chave, "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

describe("chave do Gerente IA: leitura completa", () => {
  it("lê status e faturamento do ML, equipe, lista de backups e registro", async () => {
    const ml = await comoIA("GET", "/ml/status");
    expect(ml.status).toBe(200);
    expect(await ml.json()).toMatchObject({ configurado: false, conectado: false });

    const fat = await comoIA("GET", "/ml/faturamento");
    expect(fat.status).toBe(200);
    expect(await fat.json()).toHaveProperty("lancamentos");

    const equipe = await comoIA("GET", "/usuarios");
    expect(equipe.status).toBe(200);
    const pessoas = await equipe.json();
    expect(pessoas.map((u: any) => u.papel)).toContain("gerente");

    const backups = await comoIA("GET", "/backups");
    expect(backups.status).toBe(200);
    expect(Array.isArray(await backups.json())).toBe(true);

    const registro = await comoIA("GET", "/registro");
    expect(registro.status).toBe(200);
    const linhas = await registro.json();
    expect(linhas.some((l: any) => l.tipo === "chave_criada")).toBe(true);
    expect((await comoIA("GET", "/registro?so=acessos")).status).toBe(200);
  });

  it("lê os lançamentos brutos do ML de uma ocorrência (vazio sem ML, mas sem 403)", async () => {
    const p = await novaOcorrencia(s.url, { pedido: "IA-LEITURA-1" });
    const r = await comoIA("GET", `/ocorrencias/${p}/ml/financeiro-bruto`);
    expect(r.status).not.toBe(403);
  });

  it("continua sem poder agir, baixar arquivo nem mexer em equipe e chaves", async () => {
    expect((await comoIA("POST", "/ml/sincronizar")).status).toBe(403);
    expect((await comoIA("POST", "/ml/faturamento/sincronizar")).status).toBe(403);
    expect((await comoIA("POST", "/backups")).status).toBe(403);
    expect((await comoIA("GET", "/backups/ocorrencias-2026-01-01.db")).status).toBe(403);
    expect((await comoIA("GET", "/backups/fotos.tar.gz")).status).toBe(403);
    expect((await comoIA("GET", "/ocorrencias.csv")).status).toBe(403);
    expect((await comoIA("GET", "/chaves")).status).toBe(403);
    expect((await comoIA("POST", "/usuarios", { nome: "X", email: "x@x.local", senha: "senha-forte-xyz-1", papel: "atendimento" })).status).toBe(403);
    expect((await comoIA("DELETE", `/chaves/${chaveId}`)).status).toBe(403);
  });

  it("o perfil Atendimento segue sem ver essas telas", async () => {
    await s.painel("POST", "/usuarios", { nome: "Caio Equipe", email: "caio@equipe.local", senha: "senha-forte-do-caio", papel: "atendimento" });
    const login = await fetch(s.url + "/api/admin/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "caio@equipe.local", senha: "senha-forte-do-caio" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    for (const c of ["/ml/status", "/usuarios", "/backups", "/registro"]) {
      const r = await fetch(s.url + "/api/admin" + c, { headers: { cookie, "x-requested-with": "painel" } });
      expect(r.status, c).toBe(403);
    }
  });
});
