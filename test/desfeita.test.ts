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
