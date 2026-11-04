import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { contaDa, situacaoDaVenda } from "../src/conta.js";

let n = 0;
function caso(conta: Record<string, unknown>, devolucao?: { status: string; conferencia?: string | null }) {
  const p = `MCS-DESF-${++n}`;
  const id = Number(db.prepare(
    `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id)
     VALUES (?, 'mercado_livre', ?, 'defeito', 'x', 'Comprador', '', 'ml', ?)`,
  ).run(p, `3000${n}`, `DF${n}`).lastInsertRowid);
  const cols = Object.keys(conta);
  db.prepare(`INSERT INTO conta_venda (ocorrencia_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`).run(id, ...Object.values(conta));
  if (devolucao) db.prepare("INSERT INTO devolucoes (ocorrencia_id, status, conferencia) VALUES (?,?,?)").run(id, devolucao.status, devolucao.conferencia ?? null);
  return id;
}

describe("venda desfeita na conta da venda", () => {
  it("bate com o Recebimento devolvido do ML (MCS-20261026-7HCSAD): fica só a tarifa", () => {
    const id = caso({ preco_centavos: 4056, tarifa_centavos: 466, frete_ida_centavos: 745, reembolso_centavos: 4056, pagamento_status: "refunded" },
      { status: "encerrada" });
    const c = contaDa(id);
    expect(c.vendaDesfeita).toBe(true);
    expect(c.totalMl).toBe(-4.66);
    expect(c.resultado).toBe(-4.66);
  });

  it("venda normal continua como antes", () => {
    const id = caso({ preco_centavos: 10000, tarifa_centavos: 1000, frete_ida_centavos: 500, custo_produto_centavos: 3000, custo_origem: "tiny" });
    const c = contaDa(id);
    expect(c.vendaDesfeita).toBe(false);
    expect(c.totalMl).toBe(85);
    expect(c.resultado).toBe(55);
  });

  it("custo do produto só entra quando o produto não volta ou volta com problema", () => {
    const base = { preco: 10000, reembolso: 10000, pagamentoStatus: "refunded", custo: 3000, custoOrigem: "tiny" };
    expect(situacaoDaVenda({ ...base, devolucao: { status: "em_transito", conferencia: null } }).custoConta).toBeNull();
    expect(situacaoDaVenda({ ...base, devolucao: { status: "conferida", conferencia: "ok" } }).custoConta).toBeNull();
    expect(situacaoDaVenda({ ...base, devolucao: { status: "conferida", conferencia: "danificado" } }).custoConta).toBe(3000);
    expect(situacaoDaVenda({ ...base, devolucao: { status: "nao_entregue", conferencia: null } }).custoConta).toBe(3000);
    expect(situacaoDaVenda({ ...base, devolucao: null }).custoConta).toBe(3000); // reembolso sem devolução: comprador ficou com o produto
    expect(situacaoDaVenda({ ...base, custoOrigem: "manual", devolucao: { status: "conferida", conferencia: "ok" } }).custoConta).toBe(3000);
    // Devolução cancelada e sem reembolso: a venda vale
    expect(situacaoDaVenda({ ...base, reembolso: 0, pagamentoStatus: "approved", devolucao: { status: "cancelada", conferencia: null } }).desfeita).toBe(false);
  });

  it("devolução em andamento já tira o ganho da venda, mesmo antes do reembolso", () => {
    const id = caso({ preco_centavos: 10000, tarifa_centavos: 1150, frete_ida_centavos: 900, pagamento_status: "in_mediation", custo_produto_centavos: 3000, custo_origem: "tiny" },
      { status: "em_transito" });
    const c = contaDa(id);
    expect(c.resultado).toBe(-11.5);
    expect(c.custoConta).toBeNull();
  });
});

describe("estorno da tarifa de venda na venda desfeita", () => {
  const credito = (pedido: string, id: string, descricao: string, valor: number) =>
    db.prepare(`INSERT INTO ml_faturamento (detail_id, periodo, pedido, tipo, descricao, valor_centavos, categoria) VALUES (?, '2026-11', ?, 'CREDIT', ?, ?, 'credito')`)
      .run(id, pedido, descricao, valor);
  const pedidoDe = (id: number) => (db.prepare("SELECT pedido FROM ocorrencias WHERE id = ?").get(id) as { pedido: string }).pedido;

  it("sem estorno no faturamento, avisa que a tarifa está pendente", () => {
    const id = caso({ preco_centavos: 4056, tarifa_centavos: 466, frete_ida_centavos: 745, reembolso_centavos: 4056, pagamento_status: "refunded" }, { status: "encerrada" });
    expect(contaDa(id)).toMatchObject({ tarifaSituacao: "pendente", tarifaPendente: 4.66, resultado: -4.66 });
  });

  it("com o estorno no faturamento, a tarifa fica devolvida e o resultado zera", () => {
    const id = caso({ preco_centavos: 4056, tarifa_centavos: 466, frete_ida_centavos: 745, reembolso_centavos: 4056, pagamento_status: "refunded" }, { status: "encerrada" });
    credito(pedidoDe(id), `T${id}`, "Devolução de tarifa de venda", -466);
    expect(contaDa(id)).toMatchObject({ tarifaSituacao: "devolvida", tarifaPendente: 0, tarifaEstornada: 4.66, resultado: 0 });
  });

  it("estorno parcial e crédito de envio não se confundem", () => {
    const id = caso({ preco_centavos: 10000, tarifa_centavos: 1150, reembolso_centavos: 10000, pagamento_status: "refunded" });
    credito(pedidoDe(id), `P${id}`, "Tarifa de venda", -500);
    credito(pedidoDe(id), `E${id}`, "Bonificação de envio", -300);
    expect(contaDa(id)).toMatchObject({ tarifaSituacao: "parcial", tarifaPendente: 6.5, tarifaEstornada: 5, creditos: 8 });
  });
});

describe("custos da devolução entram na conta da venda", () => {
  it("frete da devolução vira etiqueta, perda vira custo do produto, outros e recuperado entram", () => {
    const id = caso({ preco_centavos: 10000, tarifa_centavos: 1150, frete_ida_centavos: 900, reembolso_centavos: 10000, pagamento_status: "refunded",
      custo_produto_centavos: 3000, custo_origem: "tiny" }, { status: "conferida", conferencia: "ok" });
    db.prepare("UPDATE devolucoes SET frete_centavos = 2490, frete_origem = 'ml', perda_centavos = 1500, outros_centavos = 200, recuperado_centavos = 1000 WHERE ocorrencia_id = ?").run(id);
    const c = contaDa(id);
    expect(c).toMatchObject({ etiqueta: 24.9, etiquetaOrigem: "devolucao", custoConta: 15, custoNota: "lançado na devolução", outrosDevolucao: 2, outrosCreditos: 10 });
    // −tarifa −etiqueta +recuperado −perda −outros
    expect(c.resultado).toBe(Math.round((-11.5 - 24.9 + 10 - 15 - 2) * 100) / 100);
  });
});

describe("cancelamento da tarifa pelo ML (MCS-20261026-7HCSAD, depois do estorno)", () => {
  it("lançamento de bonificação/cancelamento de tarifa vira crédito e zera a conta, sem contar o frete duas vezes", async () => {
    const { gravarLancamentos } = await import("../src/conta.js");
    const id = caso({ preco_centavos: 4056, tarifa_centavos: 466, frete_ida_centavos: 745, reembolso_centavos: 4056, pagamento_status: "refunded" }, { status: "encerrada" });
    const pedido = (db.prepare("SELECT pedido FROM ocorrencias WHERE id = ?").get(id) as { pedido: string }).pedido;
    const item = (detail: number, tipo: string, descricao: string, valor: number) => ({
      charge_info: { detail_id: detail, transaction_detail: descricao, detail_amount: valor, detail_type: tipo, creation_date_time: "2026-11-04T10:00:00" },
      sales_info: [{ order_id: Number(pedido) }], shipping_info: {}, marketplace_info: { marketplace: "ML" },
    });
    gravarLancamentos([
      item(9100 + id, "BONUS", "Cancelamento de tarifa de venda", 4.66),
      item(9200 + id, "CHARGE", "Cancelamento de tarifa do Mercado Envios", 7.45),
    ], "2026-11");
    const c = contaDa(id);
    expect(c).toMatchObject({ tarifaSituacao: "devolvida", tarifaPendente: 0, totalMl: -4.66, resultado: 0 });
  });
});
