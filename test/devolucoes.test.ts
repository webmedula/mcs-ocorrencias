import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { subir, pngFalso, type Servidor } from "./ajuda.js";

// O Mercado Livre é simulado: só a função ml() é trocada; o resto da integração roda de verdade.
vi.mock("../src/ml-api.js", async (orig) => ({ ...(await orig<typeof import("../src/ml-api.js")>()), ml: vi.fn() }));

import { ml } from "../src/ml-api.js";
import { db } from "../src/db.js";
import { calcularStatus, custoDoEnvio, devolucaoDa, extrairRetorno, sincronizarDevolucao } from "../src/devolucoes.js";

const mlMock = ml as unknown as Mock;
const VENDEDOR = "99";

const retorno = (extra: Record<string, unknown> = {}, envio: Record<string, unknown> = {}) => ({
  id: 777, status: "opened", subtype: "return_total", type: "claim", status_money: "retained",
  date_created: "2026-10-20T12:00:00.000-03:00", last_updated: "2026-10-21T12:00:00.000-03:00",
  shipping: { id: 5551, status: "ready_to_ship", tracking_number: "BR123", lead_time: { estimated_delivery_time: { date: "2026-10-25T00:00:00.000-03:00" } }, ...envio },
  ...extra,
});
const claim = (acoes: string[] = ["allow_return_label"]) => ({
  id: 4242, related_entities: ["return"],
  players: [{ role: "respondent", user_id: Number(VENDEDOR), available_actions: acoes.map((action) => ({ action, due_date: "2026-10-30T12:00:00.000-03:00" })) }],
});

function simular(ret: unknown, custo: unknown = { senders: [{ user_id: 99, cost: 18.5 }] }) {
  mlMock.mockImplementation(async (caminho: string) => {
    if (caminho.endsWith("/returns")) return ret;
    if (caminho.includes("/costs")) return custo;
    throw new Error("chamada inesperada: " + caminho);
  });
}

let ocId = 0;
let protocolo = "";
let n = 0;
function novaOcMl(produto = true): { id: number; protocolo: string } {
  n++;
  const p = `MCS-DEV-${n}`;
  const r = db.prepare(
    `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id, produto_json)
     VALUES (?, 'mercado_livre', ?, 'troca_devolucao', 'Devolução', 'Comprador Teste', '', 'ml', ?, ?)`,
  ).run(p, `2000${n}`, `C${n}`, produto ? JSON.stringify([{ titulo: "Produto", preco: 100, qtd: 2 }]) : null);
  return { id: Number(r.lastInsertRowid), protocolo: p };
}

describe("leitura da resposta do ML", () => {
  it("normaliza objeto único, lista e ignora lixo", () => {
    const r = extrairRetorno(retorno());
    expect(r).toMatchObject({ returnId: "777", mlStatus: "opened", subtype: "return_total", envioId: "5551", envioStatus: "ready_to_ship", rastreio: "BR123", dinheiro: "retained" });
    expect(r!.previsaoEm).toBe("2026-10-25 03:00:00");
    const mais = extrairRetorno({ results: [retorno({ id: 1, last_updated: "2026-10-01T00:00:00Z" }), retorno({ id: 2, last_updated: "2026-10-09T00:00:00Z" })] });
    expect(mais!.returnId).toBe("2");
    expect(extrairRetorno(null)).toBeNull();
    expect(extrairRetorno({ message: "nada" })).toBeNull();
  });

  it("acha a data de recebimento no histórico do envio", () => {
    const r = extrairRetorno(retorno({ status: "delivered" }, { status: "delivered", status_history: [{ status: "shipped", date: "2026-10-22T10:00:00Z" }, { status: "delivered", date: "2026-10-24T09:30:00Z" }] }));
    expect(r!.enviadaEm).toBe("2026-10-22 10:00:00");
    expect(r!.recebidaEm).toBe("2026-10-24 09:30:00");
  });

  it("lê o custo do envio do vendedor", () => {
    expect(custoDoEnvio({ senders: [{ user_id: 1, cost: 5 }, { user_id: 99, cost: 18.5 }] }, "99")).toBe(1850);
    expect(custoDoEnvio({ gross_amount: 12.3 })).toBe(1230);
    expect(custoDoEnvio({})).toBeNull();
  });
});

describe("status da devolução", () => {
  const base = { mlStatus: "opened", envioStatus: "ready_to_ship", acoes: [] as string[], conferencia: null, contestacao: null };
  it.each([
    [{ acoes: ["allow_return_label"] }, "aguardando_liberacao"],
    [{}, "liberada"],
    [{ envioStatus: "shipped" }, "em_transito"],
    [{ mlStatus: "delivered", envioStatus: "delivered" }, "recebida"],
    [{ mlStatus: "delivered", envioStatus: "delivered", conferencia: "ok" }, "conferida"],
    [{ envioStatus: "not_delivered" }, "nao_entregue"],
    [{ mlStatus: "delivered", contestacao: "enviada" }, "em_contestacao"],
    [{ mlStatus: "delivered", contestacao: "ganha" }, "encerrada"],
    [{ mlStatus: "closed" }, "encerrada"],
    [{ mlStatus: "expired" }, "cancelada"],
  ])("%j -> %s", (extra, esperado) => {
    expect(calcularStatus({ ...base, ...extra } as any)).toBe(esperado);
  });
});

describe("importação, conferência e custos", () => {
  beforeEach(() => { mlMock.mockReset(); });

  it("importa a devolução, calcula frete e estima o reembolso", async () => {
    const oc = novaOcMl();
    simular(retorno());
    await sincronizarDevolucao(oc.id, claim(), VENDEDOR);
    const d = devolucaoDa(oc.id);
    expect(d).toMatchObject({ status: "aguardando_liberacao", tipo: "Total", podeLiberar: true, podeContestar: false });
    expect(d.envio).toMatchObject({ rastreio: "BR123", status: "ready_to_ship" });
    expect(d.custos).toMatchObject({ frete: 18.5, freteOrigem: "ml", reembolso: 200, reembolsoOrigem: "estimado", total: 18.5 });
    expect(d.linkMl).toContain(`/vendas/2000${n}/detalhe`);
  });

  it("não cria devolução quando o ML diz que a reclamação não tem uma", async () => {
    const oc = novaOcMl();
    await sincronizarDevolucao(oc.id, { id: 1, related_entities: [], players: [] }, VENDEDOR);
    expect(devolucaoDa(oc.id)).toBeNull();
    expect(mlMock).not.toHaveBeenCalled();
  });

  it("segue o ML até o recebimento e a equipe confere e lança custos", async () => {
    const oc = novaOcMl();
    simular(retorno());
    await sincronizarDevolucao(oc.id, claim(), VENDEDOR);
    simular(retorno({ status: "delivered" }, { status: "delivered" }), { senders: [{ user_id: 99, cost: 30 }] });
    await sincronizarDevolucao(oc.id, claim(["return_review_fail"]), VENDEDOR);
    let d = devolucaoDa(oc.id);
    expect(d).toMatchObject({ status: "recebida", podeContestar: true });
    expect(d.custos.frete).toBe(30);
    const eventos = db.prepare("SELECT texto FROM eventos WHERE ocorrencia_id = ?").all(oc.id).map((e: any) => e.texto);
    expect(eventos).toContain("Devolução: Recebida, a conferir.");

    const { atualizarDevolucao } = await import("../src/devolucoes.js");
    d = atualizarDevolucao(oc.id, { conferencia: "danificado", conferenciaObs: "Caixa amassada", motivoReal: "Arrependimento", frete: 25, perda: 80, outros: 5 }, "Ana");
    expect(d).toMatchObject({ status: "conferida", conferencia: "danificado", conferidaPor: "Ana", motivoReal: "Arrependimento" });
    expect(d.custos).toMatchObject({ frete: 25, freteOrigem: "manual", perda: 80, outros: 5, total: 110 });

    // frete digitado pela equipe não é sobrescrito pelo ML
    simular(retorno({ status: "delivered" }, { status: "delivered" }), { senders: [{ user_id: 99, cost: 999 }] });
    await sincronizarDevolucao(oc.id, claim(["return_review_fail"]), VENDEDOR);
    expect(devolucaoDa(oc.id).custos.frete).toBe(25);

    d = atualizarDevolucao(oc.id, { recuperado: 60 }, "Ana");
    expect(d.custos.total).toBe(50);
  });
});

describe("painel", () => {
  let s: Servidor;
  beforeAll(async () => { s = await subir(); });
  afterAll(async () => { await s.fechar(); });
  beforeEach(() => { mlMock.mockReset(); });

  async function comDevolucao(acoes = ["return_review_fail"]) {
    const oc = novaOcMl();
    simular(retorno({ status: "delivered" }, { status: "delivered" }));
    await sincronizarDevolucao(oc.id, claim(acoes), VENDEDOR);
    return oc;
  }

  it("mostra a devolução no detalhe e na fila", async () => {
    const oc = await comDevolucao();
    const det = await (await s.painel("GET", `/ocorrencias/${oc.protocolo}`)).json();
    expect(det.devolucao.status).toBe("recebida");
    const fila = await (await s.painel("GET", "/devolucoes?status=recebida")).json();
    expect(fila.itens.map((i: any) => i.protocolo)).toContain(oc.protocolo);
    expect(fila.contagem.recebida).toBeGreaterThan(0);
    const lista = await (await s.painel("GET", "/ocorrencias?origem=ml")).json();
    expect(lista.itens.find((i: any) => i.protocolo === oc.protocolo).devolucao).toBe("recebida");
  });

  it("confere e lança custos pelo painel, recusando valores inválidos", async () => {
    const oc = await comDevolucao();
    const ruim = await s.painel("PATCH", `/ocorrencias/${oc.protocolo}/devolucao`, { frete: -3 });
    expect(ruim.status).toBe(400);
    const r = await s.painel("PATCH", `/ocorrencias/${oc.protocolo}/devolucao`, { conferencia: "ok", frete: 12.5 });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ status: "conferida", conferencia: "ok" });
    expect(d.custos.frete).toBe(12.5);
    expect((await s.painel("PATCH", `/ocorrencias/MCS-NAO-EXISTE/devolucao`, { conferencia: "ok" })).status).toBe(404);
  });

  function contestar(protocolo: string, campos: Record<string, string>, fotos = 0) {
    const f = new FormData();
    for (const [k, v] of Object.entries(campos)) f.append(k, v);
    for (let i = 0; i < fotos; i++) f.append("fotos", pngFalso(), `prova${i}.png`);
    return fetch(`${s.url}/api/admin/ocorrencias/${protocolo}/devolucao/contestar`, {
      method: "POST", body: f, headers: { cookie: s.cookie, "x-requested-with": "painel" },
    });
  }

  it("exige motivo, mensagem e foto quando o motivo pede", async () => {
    const oc = await comDevolucao();
    mlMock.mockClear();
    expect((await contestar(oc.protocolo, { motivo: "SRF3", mensagem: "x" })).status).toBe(400);
    const semFoto = await contestar(oc.protocolo, { motivo: "SRF2", mensagem: "A caixa veio destruída." });
    expect(semFoto.status).toBe(400);
    expect((await semFoto.json()).erro).toMatch(/foto/);
    expect((await contestar(oc.protocolo, { motivo: "XXX", mensagem: "Motivo que não existe." })).status).toBe(400);
    expect(mlMock).not.toHaveBeenCalled();
  });

  it("envia a contestação ao ML com as fotos e registra no histórico", async () => {
    const oc = await comDevolucao();
    const chamadas: string[] = [];
    let corpo: any = null;
    mlMock.mockImplementation(async (caminho: string, init?: any) => {
      chamadas.push(`${init?.metodo ?? "GET"} ${caminho}`);
      if (caminho.endsWith(`/claims/C${n}`)) return claim(["return_review_fail"]);
      if (caminho.endsWith("/returns/attachments")) return { file_name: "arquivo-1.png" };
      if (caminho.endsWith("/actions/return-review-fail")) { corpo = init.corpo; return {}; }
      throw new Error("chamada inesperada: " + caminho);
    });
    const r = await contestar(oc.protocolo, { motivo: "SRF2", mensagem: "A caixa veio destruída." }, 2);
    expect(r.status).toBe(201);
    expect(corpo).toEqual([{ reason: "SRF2", message: "A caixa veio destruída.", attachments: ["arquivo-1.png", "arquivo-1.png"] }]);
    expect(chamadas.filter((c) => c.includes("attachments")).length).toBe(2);
    const d = await r.json();
    expect(d).toMatchObject({ status: "em_contestacao", contestacao: { status: "enviada", motivo: "O produto chegou danificado" }, podeContestar: false });
    // segunda vez: recusa
    expect((await contestar(oc.protocolo, { motivo: "SRF2", mensagem: "Tentando de novo." }, 1)).status).toBe(409);
    // resultado da contestação
    const fim = await (await s.painel("PATCH", `/ocorrencias/${oc.protocolo}/devolucao`, { contestacaoResultado: "ganha", recuperado: 40 })).json();
    expect(fim).toMatchObject({ status: "encerrada" });
    expect(fim.custos.recuperado).toBe(40);
  });

  it("não contesta se o ML não liberou a ação", async () => {
    const oc = await comDevolucao(["send_message_to_complainant"]);
    mlMock.mockImplementation(async (caminho: string) => {
      if (caminho.endsWith(`/claims/C${n}`)) return claim(["send_message_to_complainant"]);
      throw new Error("não devia chamar: " + caminho);
    });
    const r = await contestar(oc.protocolo, { motivo: "SRF3", mensagem: "Faltou uma peça na caixa." });
    expect(r.status).toBe(409);
  });
});
