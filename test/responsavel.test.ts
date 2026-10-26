import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

let s: Servidor;
let ana = 0;
beforeAll(async () => {
  s = await subir();
  const r = await s.painel("POST", "/usuarios", { nome: "Ana Atendimento", email: "ana@equipe.local", senha: "outra-senha-forte", papel: "atendimento" });
  ana = (await r.json()).id;
});
afterAll(async () => { await s.fechar(); });

const lista = async (q: string) => (await (await s.painel("GET", "/ocorrencias?" + q)).json()).itens.map((i: any) => i.protocolo);

describe("responsável pela ocorrência", () => {
  it("atribui, filtra por minhas / sem responsável / pessoa e registra no histórico", async () => {
    const minha = await novaOcorrencia(s.url);
    const daAna = await novaOcorrencia(s.url);
    const livre = await novaOcorrencia(s.url);
    const eu = (await (await s.painel("GET", "/me")).json()).id;

    expect((await s.painel("PATCH", `/ocorrencias/${minha}/responsavel`, { usuarioId: eu })).status).toBe(200);
    const r = await s.painel("PATCH", `/ocorrencias/${daAna}/responsavel`, { usuarioId: ana });
    expect(await r.json()).toEqual({ responsavel: { id: ana, nome: "Ana Atendimento" } });

    expect(await lista("responsavel=eu")).toEqual([minha]);
    expect(await lista(`responsavel=${ana}`)).toEqual([daAna]);
    const semNinguem = await lista("responsavel=nenhum");
    expect(semNinguem).toContain(livre);
    expect(semNinguem).not.toContain(minha);

    const item = (await (await s.painel("GET", "/ocorrencias?responsavel=eu")).json()).itens[0];
    expect(item.responsavel).toBe("Gerente Teste");
    const d = await (await s.painel("GET", `/ocorrencias/${daAna}`)).json();
    expect(d.responsavel).toEqual({ id: ana, nome: "Ana Atendimento" });
    expect(d.eventos.some((e: any) => e.texto === "Responsável: Ana Atendimento." && e.publico === 0)).toBe(true);

    await s.painel("PATCH", `/ocorrencias/${daAna}/responsavel`, { usuarioId: null });
    expect(await lista("responsavel=nenhum")).toContain(daAna);
  });

  it("recusa pessoa inexistente ou desativada", async () => {
    const p = await novaOcorrencia(s.url);
    expect((await s.painel("PATCH", `/ocorrencias/${p}/responsavel`, { usuarioId: 9999 })).status).toBe(400);
    const r = await s.painel("POST", "/usuarios", { nome: "Ex Funcionário", email: "ex@equipe.local", senha: "mais-uma-senha-forte", papel: "atendimento" });
    const ex = (await r.json()).id;
    await s.painel("PATCH", `/usuarios/${ex}`, { ativo: false });
    expect((await s.painel("PATCH", `/ocorrencias/${p}/responsavel`, { usuarioId: ex })).status).toBe(400);
  });

  it("quem responde o cliente primeiro vira responsável, sem tirar de quem já tinha", async () => {
    const livre = await novaOcorrencia(s.url);
    await s.painel("POST", `/ocorrencias/${livre}/resposta`, { texto: "Olá! Já estamos vendo." });
    expect((await (await s.painel("GET", `/ocorrencias/${livre}`)).json()).responsavel?.nome).toBe("Gerente Teste");

    const daAna = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${daAna}/responsavel`, { usuarioId: ana });
    await s.painel("POST", `/ocorrencias/${daAna}/resposta`, { texto: "Complementando a resposta." });
    expect((await (await s.painel("GET", `/ocorrencias/${daAna}`)).json()).responsavel?.id).toBe(ana);
  });

  it("aparece no CSV", async () => {
    const csv = await (await fetch(s.url + "/api/admin/ocorrencias.csv?responsavel=" + ana, { headers: { cookie: s.cookie } })).text();
    expect(csv.split("\r\n")[0]).toContain(";Responsável;");
    expect(csv).toContain("Ana Atendimento");
  });
});
