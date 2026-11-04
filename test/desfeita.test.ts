import { describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { contaDa, gravarLancamentos, situacaoDaVenda } from "../src/conta.js";

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

const pedidoDe = (id: number) => (db.prepare("SELECT pedido FROM ocorrencias WHERE id = ?").get(id) as { pedido: string }).pedido;
const item = (pedido: string, detail: number, tipo: string, descricao: string, valor: number) => ({
  charge_info: { detail_id: detail, transaction_detail: descricao, detail_amount: valor, detail_type: tipo, creation_date_time: "2026-11-04T10:00:00" },
  sales_info: [{ order_id: Number(pedido) }], shipping_info: {}, marketplace_info: { marketplace: "ML" },
});
// MCS-20261026-7HCSAD: preço 40,56, tarifa 4,66, frete 7,45, reembolso 40,56
const CASO = { preco_centavos: 4056, tarifa_centavos: 466, frete_ida_centavos: 745, reembolso_centavos: 4056, pagamento_status: "refunded" };

describe("conta da venda igual ao Recebimento do ML (só dados reais)", () => {
  it("sem cancelamento de tarifa e envio nos dados do ML, eles não entram (preço − tarifa − envio − produto)", () => {
    const id = caso(CASO, { status: "encerrada" });
    const c = contaDa(id);
    expect(c).toMatchObject({ cancelamentos: -40.56, tarifaCancelada: null, envioCancelado: null, totalMl: -12.11 });
  });

  it("com o líquido do pagamento (28,45), o ML só tirou o líquido: tarifa e envio cancelados, total R$ 0,00", () => {
    const id = caso({ ...CASO, liquido_centavos: 2845 }, { status: "encerrada" });
    expect(contaDa(id)).toMatchObject({ cancelamentos: -28.45, tarifaCancelada: 4.66, envioCancelado: 7.45, tarifaCanceladaOrigem: "pagamento", tarifasCanceladas: null, totalMl: 0, resultado: 0 });
  });

  it("se a diferença não bate com tarifa + envio, mostra numa linha só", () => {
    const id = caso({ ...CASO, liquido_centavos: 3311 }, { status: "encerrada" });
    expect(contaDa(id)).toMatchObject({ cancelamentos: -33.11, tarifaCancelada: null, envioCancelado: null, tarifasCanceladas: 7.45, totalMl: -4.66 });
  });

  it("reembolso parcial não usa o líquido (só o que o ML informar no faturamento)", () => {
    const id = caso({ ...CASO, reembolso_centavos: 2000, pagamento_status: "partially_refunded", liquido_centavos: 2845 });
    expect(contaDa(id)).toMatchObject({ cancelamentos: -20, tarifaCancelada: null, envioCancelado: null, tarifasCanceladas: null });
  });

  it("os cancelamentos também podem vir do faturamento (bonificação/cancelamento de tarifa), sem contar duas vezes", () => {
    const id = caso(CASO, { status: "encerrada" });
    gravarLancamentos([
      item(pedidoDe(id), 9100 + id, "BONUS", "Cancelamento de tarifa de venda", 4.66),
      item(pedidoDe(id), 9200 + id, "CHARGE", "Cancelamento de tarifa do Mercado Envios", 7.45),
    ], "2026-11");
    expect(contaDa(id)).toMatchObject({ tarifaCancelada: 4.66, tarifaCanceladaOrigem: "faturamento", envioCancelado: 7.45, totalMl: 0, outrosCreditos: 0 });
  });

  it("venda normal continua como antes", () => {
    const id = caso({ preco_centavos: 10000, tarifa_centavos: 1000, frete_ida_centavos: 500, custo_produto_centavos: 3000, custo_origem: "tiny" });
    const c = contaDa(id);
    expect(c.totalMl).toBe(85);
    expect(c.resultado).toBe(55);
  });

  it("custo do produto só entra quando o produto não volta ou volta com problema", () => {
    const base = { preco: 10000, reembolso: 10000, pagamentoStatus: "refunded", custo: 3000, custoOrigem: "tiny" };
    expect(situacaoDaVenda({ ...base, devolucao: { status: "em_transito", conferencia: null } }).custoConta).toBeNull();
    expect(situacaoDaVenda({ ...base, devolucao: { status: "conferida", conferencia: "ok" } }).custoConta).toBeNull();
    expect(situacaoDaVenda({ ...base, devolucao: { status: "conferida", conferencia: "danificado" } }).custoConta).toBe(3000);
    expect(situacaoDaVenda({ ...base, devolucao: { status: "nao_entregue", conferencia: null } }).custoConta).toBe(3000);
    expect(situacaoDaVenda({ ...base, devolucao: null }).custoConta).toBe(3000);
    expect(situacaoDaVenda({ ...base, custoOrigem: "manual", devolucao: { status: "conferida", conferencia: "ok" } }).custoConta).toBe(3000);
  });

  it("custos lançados na devolução entram na conta", () => {
    const id = caso({ ...CASO, liquido_centavos: 2845, custo_produto_centavos: 3000, custo_origem: "tiny" },
      { status: "conferida", conferencia: "ok" });
    db.prepare("UPDATE devolucoes SET frete_centavos = 2490, frete_origem = 'ml', perda_centavos = 1500, outros_centavos = 200, recuperado_centavos = 1000 WHERE ocorrencia_id = ?").run(id);
    const c = contaDa(id);
    expect(c).toMatchObject({ etiqueta: 24.9, etiquetaOrigem: "devolucao", custoConta: 15, outrosDevolucao: 2, outrosCreditos: 10, totalMl: -24.9 });
    expect(c.resultado).toBe(Math.round((-24.9 + 10 - 15 - 2) * 100) / 100);
  });
});

describe("v1.10.6: faturamento descontado do pagamento ou cobrado à parte", () => {
  const envioItem = (pedido: string | null, envio: string, detail: number, descricao: string, valor: number, debitado: "YES" | "NO") => ({
    charge_info: { detail_id: detail, transaction_detail: descricao, detail_amount: valor, detail_type: "CHARGE", creation_date_time: "2026-11-04T10:00:00", debited_from_operation: debitado },
    sales_info: pedido ? [{ order_id: Number(pedido) }] : null, shipping_info: { shipping_id: envio }, marketplace_info: { marketplace: "SHIPPING" },
  });

  it("envio cobrado à parte entra nos envios; o já descontado do pagamento não conta duas vezes", () => {
    const id = caso({ preco_centavos: 39892, tarifa_centavos: 3192, frete_ida_centavos: 2705, envio_ida_id: `IDA${id0()}` });
    const ida = (db.prepare("SELECT envio_ida_id FROM conta_venda WHERE ocorrencia_id = ?").get(id) as any).envio_ida_id;
    gravarLancamentos([
      envioItem(pedidoDe(id), ida, 9300 + id, "Tarifa de envio", 27.05, "YES"),
      envioItem(null, ida, 9400 + id, "Tarifa de envio extra", 54.1, "NO"), // sem o pedido na linha: acha pelo envio
    ], "2026-11");
    const c = contaDa(id);
    expect(c).toMatchObject({ freteIda: 27.05, freteCobrado: 54.1, envios: 81.15 });
    expect(c.lancamentos.map((l: any) => l.debitado)).toEqual([true, false]);
  });
});

let k = 0;
function id0() { return ++k; }
