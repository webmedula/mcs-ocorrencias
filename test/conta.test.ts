import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { subir, type Servidor } from "./ajuda.js";

vi.mock("../src/ml-api.js", async (orig) => ({ ...(await orig<typeof import("../src/ml-api.js")>()), ml: vi.fn() }));

import { ml } from "../src/ml-api.js";
import { db } from "../src/db.js";
import {
  atualizarContaVenda, classificarLancamento, contaDa, custoDoVendedor, editarConta, gravarLancamentos, lerLancamento,
  lerMensagemMediador, resumirPedido,
} from "../src/conta.js";

const mlMock = ml as unknown as Mock;
const VENDEDOR = "697553753";

// Estrutura real da API do ML (valores do pedido de teste da v1.8.1, dados pessoais trocados)
const pedidoMl = {
  id: 2000019228843068, total_amount: 25.21, paid_amount: 35.2,
  order_items: [{ item: { id: "MLB7149964780", title: "Tomada USB", seller_sku: "MCS1199" }, quantity: 1, unit_price: 25.21, sale_fee: 2.33 }],
  payments: [{ id: 185605782499, status: "in_mediation", transaction_amount: 25.21, transaction_amount_refunded: 0, shipping_cost: 9.99, total_paid_amount: 35.2 }],
  shipping: { id: 48376543007 }, buyer: { id: 1, nickname: "COMPRADOR" },
};
const custosIda = { receiver: { cost: 9.99, user_id: 615997320 }, gross_amount: 29.68, senders: [{ cost: 6.85, user_id: 697553753 }] };
const custosVolta = { receiver: { cost: 24.9, user_id: 697553753 }, gross_amount: 24.9, senders: [{ cost: 0, user_id: 615997320 }] };
const pagamento = { id: 185605782499, status: "in_mediation", transaction_amount_refunded: 0, net_received_amount: 16.03, released: "no", money_release_date: "2026-11-08T18:06:45.000-04:00", refunds: [] };
const MSG_MEDIADOR = "Você é responsável por essa reclamação. Sua reputação será impactada e o custo da etiqueta de devolução será de R$ 9,79.";

const lancamento = (extra: Record<string, unknown> = {}, venda: Record<string, unknown> | null = { order_id: 2000019228843068 }) => ({
  charge_info: { detail_id: 68551613282, transaction_detail: "Tarifa de envio extra ou intermunicipal", detail_amount: 6.55, detail_type: "CHARGE", detail_sub_type: "CXDE", creation_date_time: "2026-08-06T00:00:36", ...extra },
  discount_info: { charge_amount_without_discount: 9.36 },
  sales_info: venda ? [venda] : null,
  shipping_info: { shipping_id: "47666869270", pack_id: null },
  marketplace_info: { marketplace: "SHIPPING" },
});

describe("leitura do pedido e dos envios", () => {
  it("tira preço, tarifa, reembolso e pagamento do pedido", () => {
    const r = resumirPedido(pedidoMl);
    expect(r).toMatchObject({ preco: 2521, tarifa: 233, reembolso: 0, pagamentoStatus: "in_mediation", envioIdaId: "48376543007", pagamentoIds: ["185605782499"] });
    expect(r.liquido).toBeNull();
  });
  it("soma vários itens e reembolsos", () => {
    const r = resumirPedido({ order_items: [{ quantity: 2, unit_price: 10, sale_fee: 1 }, { quantity: 1, unit_price: 5.5, sale_fee: 0.5 }], payments: [{ transaction_amount_refunded: 3 }, { transaction_amount_refunded: 2.5 }] });
    expect(r).toMatchObject({ preco: 2550, tarifa: 250, reembolso: 550 });
  });
  it("custo do vendedor na ida é o do remetente e na volta é o do destinatário", () => {
    expect(custoDoVendedor(custosIda, VENDEDOR)).toBe(685);
    expect(custoDoVendedor(custosVolta, VENDEDOR)).toBe(2490);
    expect(custoDoVendedor({}, VENDEDOR)).toBeNull();
  });
  it("lê etiqueta prevista e reputação na mensagem do mediador", () => {
    expect(lerMensagemMediador([MSG_MEDIADOR])).toEqual({ etiquetaPrevista: 979, reputacaoAfetada: true });
    expect(lerMensagemMediador(["Olá, tudo bem?"])).toEqual({ etiquetaPrevista: null, reputacaoAfetada: null });
    expect(lerMensagemMediador(["o custo da etiqueta de devolução será de R$ 1.234,50"]).etiquetaPrevista).toBe(123450);
  });
});

describe("faturamento", () => {
  it("lê e classifica um lançamento", () => {
    const l = lerLancamento(lancamento(), "2026-09-01")!;
    expect(l).toMatchObject({ detailId: "68551613282", pedido: "2000019228843068", envioId: "47666869270", valor: 655, bruto: 936, categoria: "frete", data: "2026-08-06 00:00:36" });
    expect(lerLancamento(lancamento({ transaction_detail: "Tarifa de envio de devolução" }), "p")!.categoria).toBe("etiqueta_devolucao");
    expect(lerLancamento(lancamento({ detail_type: "CREDIT_NOTE", transaction_detail: "Bonificação por cobertura" }), "p")!.valor).toBe(-655);
    expect(classificarLancamento({ tipo: "CHARGE", subtipo: null, descricao: "Tarifa de venda", valor: 100, mercado: "ML" })).toBe("tarifa_venda");
    expect(lerLancamento({ charge_info: null }, "p")).toBeNull();
  });
  it("grava sem duplicar e consulta por pedido", () => {
    const n1 = gravarLancamentos([lancamento(), lancamento({ detail_id: 2, transaction_detail: "Tarifa de envio de devolução", detail_amount: 9.79 })], "2026-11-01");
    const n2 = gravarLancamentos([lancamento()], "2026-11-01");
    expect(n1).toBe(2); expect(n2).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM ml_faturamento WHERE pedido = '2000019228843068'").get() as any).n).toBe(2);
  });
});

let n = 0;
function novaOcMl(pedido = `3000${++n}`): { id: number; protocolo: string; pedido: string } {
  const p = `MCS-CONTA-${n}`;
  const r = db.prepare(
    `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id, produto_json)
     VALUES (?, 'mercado_livre', ?, 'defeito', 'x', 'Comprador', '', 'ml', ?, ?)`,
  ).run(p, pedido, `CC${n}`, JSON.stringify([{ titulo: "Tomada USB", preco: 25.21, qtd: 1 }]));
  return { id: Number(r.lastInsertRowid), protocolo: p, pedido };
}
function simularMl() {
  mlMock.mockImplementation(async (caminho: string) => {
    if (caminho.includes("/costs")) return caminho.includes("48376543007") ? custosIda : custosVolta;
    if (caminho.startsWith("/collections/")) return pagamento;
    throw new Error("chamada inesperada: " + caminho);
  });
}

describe("conta da venda", () => {
  it("monta o quadro do ML a partir do pedido, do envio e da mensagem do mediador", async () => {
    const oc = novaOcMl();
    db.prepare("INSERT INTO ml_mensagens (ocorrencia_id, chave, remetente, texto, data) VALUES (?,?,?,?,datetime('now'))").run(oc.id, "k" + oc.id, "mediator", MSG_MEDIADOR);
    simularMl();
    await atualizarContaVenda(oc.id, { ...pedidoMl, id: oc.pedido }, VENDEDOR);
    const c = contaDa(oc.id);
    expect(c).toMatchObject({ preco: 25.21, tarifa: 2.33, freteIda: 6.85, etiqueta: 9.79, etiquetaOrigem: "mediador", envios: 16.64, reembolso: 0, liquidoHoje: 16.03, liberado: false, reputacaoAfetada: true, reputacaoOrigem: "mediador", pendencia: "nenhuma" });
    // Quadro do ML: 25,21 − 2,33 − 16,64 − 0 = 6,24 (ainda sem reembolso)
    expect(c.totalMl).toBe(6.24);
    expect(c.resultado).toBe(6.24);
  });

  it("depois do reembolso e do faturamento, fecha a conta como o ML mostra", async () => {
    const oc = novaOcMl();
    simularMl();
    await atualizarContaVenda(oc.id, { ...pedidoMl, id: oc.pedido, payments: [{ ...pedidoMl.payments[0], transaction_amount_refunded: 22.88, status: "refunded" }] }, VENDEDOR);
    gravarLancamentos([
      lancamento({ detail_id: 91, transaction_detail: "Tarifa de envio de devolução", detail_amount: 9.79 }, { order_id: Number(oc.pedido) }),
      lancamento({ detail_id: 92, detail_type: "CREDIT_NOTE", transaction_detail: "Bonificação por cobertura da devolução", detail_amount: 5 }, { order_id: Number(oc.pedido) }),
    ], "2026-11-01");
    const c = contaDa(oc.id);
    expect(c).toMatchObject({ etiqueta: 9.79, etiquetaOrigem: "faturamento", reembolso: 22.88, creditos: 5 });
    // 25,21 − 2,33 − 16,64 − 22,88 = −16,64 ; com crédito de 5 → −11,64
    expect(c.totalMl).toBe(-16.64);
    expect(c.resultado).toBe(-11.64);
    expect(c.lancamentos.length).toBe(2);
  });

  it("equipe lança custo do produto, pendência e reputação; dados do ML não apagam o que foi digitado", async () => {
    const oc = novaOcMl();
    simularMl();
    await atualizarContaVenda(oc.id, { ...pedidoMl, id: oc.pedido }, VENDEDOR);
    let c = editarConta(oc.id, { custoProduto: 12, pendencia: "aguardando", pendenciaObs: "Pedi cobertura", reputacaoAfetada: false }, "Ana");
    expect(c).toMatchObject({ custoProduto: 12, pendencia: "aguardando", pendenciaObs: "Pedi cobertura", reputacaoAfetada: false, reputacaoOrigem: "manual" });
    expect(c.resultado).toBe(Number((25.21 - 2.33 - 6.85 - 12).toFixed(2))); // sem mensagem do mediador ainda: sem etiqueta
    db.prepare("INSERT INTO ml_mensagens (ocorrencia_id, chave, remetente, texto, data) VALUES (?,?,?,?,datetime('now'))").run(oc.id, "m" + oc.id, "mediator", MSG_MEDIADOR);
    await atualizarContaVenda(oc.id, { ...pedidoMl, id: oc.pedido }, VENDEDOR);
    c = contaDa(oc.id);
    expect(c.reputacaoAfetada).toBe(false); // manual vence o mediador
    expect(c.custoProduto).toBe(12);
    expect(c.etiqueta).toBe(9.79);
    const eventos = db.prepare("SELECT texto FROM eventos WHERE ocorrencia_id = ?").all(oc.id).map((e: any) => e.texto);
    expect(eventos).toContain("Pendência com o ML: Aguardando retorno do Mercado Livre.");
  });
});

describe("painel", () => {
  let s: Servidor;
  beforeAll(async () => { s = await subir(); });
  afterAll(async () => { await s.fechar(); });

  it("detalhe traz a conta, PATCH edita, filtro de pendência e CSV funcionam", async () => {
    const oc = novaOcMl();
    simularMl();
    await atualizarContaVenda(oc.id, { ...pedidoMl, id: oc.pedido }, VENDEDOR);
    const det = await (await s.painel("GET", `/ocorrencias/${oc.protocolo}`)).json();
    expect(det.conta.preco).toBe(25.21);
    expect((await s.painel("PATCH", `/ocorrencias/${oc.protocolo}/conta`, { custoProduto: -1 })).status).toBe(400);
    const r = await s.painel("PATCH", `/ocorrencias/${oc.protocolo}/conta`, { pendencia: "aguardando", custoProduto: 8.5 });
    expect(r.status).toBe(200);
    expect((await r.json()).pendencia).toBe("aguardando");
    const lista = await (await s.painel("GET", "/ocorrencias?pendencia=aguardando")).json();
    expect(lista.itens.map((i: any) => i.protocolo)).toContain(oc.protocolo);
    expect(lista.itens.find((i: any) => i.protocolo === oc.protocolo).pendencia_ml).toBe("aguardando");
    expect(lista.pendencias).toBeGreaterThan(0);
    const csv = await (await fetch(s.url + "/api/admin/ocorrencias.csv?pendencia=aguardando", { headers: { cookie: s.cookie } })).text();
    expect(csv.split("\r\n")[0]).toContain(";Resultado MCS (R$);Tarifa não devolvida pelo ML (R$);Pendência ML;Reputação afetada");
    expect(csv).toContain("Aguardando retorno do Mercado Livre");
    expect(csv).toContain(";25,21;2,33;6,85;");
    const est = await (await s.painel("GET", "/estatisticas?dias=30")).json();
    expect(est.contaMl.casos).toBeGreaterThan(0);
    expect(typeof est.contaMl.custo).toBe("number");
    expect(est.contaMl.porProduto[0].k).toBe("Tomada USB");
  });

  it("ocorrência do formulário não tem conta", async () => {
    const r = await s.painel("PATCH", `/ocorrencias/MCS-NAO-EXISTE/conta`, { pendencia: "aguardando" });
    expect(r.status).toBe(404);
  });
});
