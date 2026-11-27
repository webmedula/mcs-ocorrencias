import { describe, expect, it, vi, type Mock } from "vitest";

// v1.21.1: reclamação de "produto não recebido" aponta para o envio (shipment), não para o pedido
vi.mock("../src/ml-api.js", async (orig) => ({
  ...(await orig<typeof import("../src/ml-api.js")>()),
  ml: vi.fn(),
  conexao: () => ({ user_id: "99" }),
}));

import { ml } from "../src/ml-api.js";
import { db } from "../src/db.js";
import { sincronizar } from "../src/ml.js";

const mlMock = ml as unknown as Mock;
const reclamacao = (id: number, envio: number, ultima = "2026-11-25T09:29:00.000-03:00") => ({
  id, type: "mediations", status: "opened", stage: "claim", resource: "shipment", resource_id: envio, reason_id: "PNR3430",
  last_updated: ultima, players: [{ role: "respondent", user_id: 99, available_actions: [] }],
});
function simular(claims: unknown[]) {
  mlMock.mockImplementation(async (caminho: string) => {
    if (caminho.startsWith("/post-purchase/v1/claims/search")) return { data: claims };
    if (caminho === "/shipments/48461260905") return { id: 48461260905, order_id: 2000019000000001 };
    if (caminho === "/shipments/48461260999") return { id: 48461260999 };
    if (caminho === "/shipments/48461260999/items") return [{ item_id: "MLB1", order_id: 2000019000000002 }];
    if (caminho.startsWith("/orders/2000019000000001")) return { id: 2000019000000001, buyer: { id: 7, nickname: "COMPRADOR1" }, order_items: [{ item: { title: "Lanterna" } }] };
    if (caminho.startsWith("/orders/2000019000000002")) return { id: 2000019000000002, buyer: { id: 8, nickname: "COMPRADOR2" }, order_items: [] };
    return {};
  });
}

describe("reclamação pelo envio do Mercado Livre", () => {
  it("importa com o número do pedido (achado pelo envio) e não com o do envio", async () => {
    simular([reclamacao(901, 48461260905)]);
    expect((await sincronizar()).novas).toBe(1);
    const o = db.prepare("SELECT pedido, nome FROM ocorrencias WHERE ml_claim_id = '901'").get() as any;
    expect(o).toEqual({ pedido: "2000019000000001", nome: "COMPRADOR1" });
  });

  it("corrige o caso já importado com o número do envio (pedido pelos itens do envio)", async () => {
    db.prepare(
      `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id, tiny_status, ml_json)
       VALUES ('MCS-ENVIO-1', 'mercado_livre', '48461260999', 'nao_recebido', 'x', 'Comprador do Mercado Livre', '', 'ml', '902', 'nao_encontrado', ?)`,
    ).run(JSON.stringify({ id: "902", status: "opened", last_updated: "2026-11-25T09:29:00.000-03:00" }));
    simular([reclamacao(902, 48461260999)]);
    await sincronizar();
    const o = db.prepare("SELECT id, pedido, nome FROM ocorrencias WHERE ml_claim_id = '902'").get() as any;
    expect(o).toMatchObject({ pedido: "2000019000000002", nome: "COMPRADOR2" });
    const ev = db.prepare("SELECT texto FROM eventos WHERE ocorrencia_id = ?").all(o.id) as { texto: string }[];
    expect(ev.some((e) => e.texto.includes("48461260999 era o número do envio"))).toBe(true);
    // Rodada seguinte: já corrigido, nada muda
    await sincronizar();
    expect((db.prepare("SELECT COUNT(*) n FROM eventos WHERE ocorrencia_id = ? AND texto LIKE 'Pedido corrigido%'").get(o.id) as any).n).toBe(1);
  });
});
