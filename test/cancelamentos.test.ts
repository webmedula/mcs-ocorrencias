import { describe, expect, it, vi, type Mock } from "vitest";

// Mercado Livre simulado: busca de reclamações com uma mediação e um pedido de cancelamento
vi.mock("../src/ml-api.js", async (orig) => ({
  ...(await orig<typeof import("../src/ml-api.js")>()),
  ml: vi.fn(),
  conexao: () => ({ user_id: "99" }),
}));

import { ml } from "../src/ml-api.js";
import { db } from "../src/db.js";
import { sincronizar } from "../src/ml.js";

const mlMock = ml as unknown as Mock;
const reclamacao = (id: number, type: string) => ({
  id, type, status: "opened", stage: "claim", resource: "order", resource_id: 5000 + id, reason_id: "PDD9939",
  last_updated: "2026-11-03T10:00:00.000-03:00", players: [{ role: "respondent", user_id: 99, available_actions: [] }],
});

describe("pedidos de cancelamento do Mercado Livre", () => {
  it("não importa cancelamentos e tira da fila os que já estavam abertos", async () => {
    // Importado por uma versão anterior, ainda aberto
    db.prepare(
      `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, origem, ml_claim_id, prazo_em)
       VALUES ('MCS-CANC-1', 'mercado_livre', '5003', 'outro', 'Cancelamento', 'Comprador', '', 'ml', '3', datetime('now','+1 day'))`,
    ).run();

    mlMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith("/post-purchase/v1/claims/search"))
        return { data: [reclamacao(1, "mediations"), reclamacao(2, "cancel_purchase"), reclamacao(3, "cancel_purchase"), reclamacao(4, "cancel_sale")] };
      return {};
    });
    const r = await sincronizar();
    expect(r.novas).toBe(1);

    const importadas = (db.prepare("SELECT ml_claim_id FROM ocorrencias WHERE origem = 'ml' ORDER BY ml_claim_id").all() as { ml_claim_id: string }[]).map((x) => x.ml_claim_id);
    expect(importadas).toEqual(["1", "3"]);

    const antiga = db.prepare("SELECT id, status, prazo_em, resolvida_em FROM ocorrencias WHERE ml_claim_id = '3'").get() as any;
    expect(antiga).toMatchObject({ status: "resolvida", prazo_em: null });
    expect(antiga.resolvida_em).toBeTruthy();
    const ev = db.prepare("SELECT texto FROM eventos WHERE ocorrencia_id = ?").all(antiga.id) as { texto: string }[];
    expect(ev.some((e) => e.texto.startsWith("Pedido de cancelamento da compra"))).toBe(true);

    // Rodada seguinte: nada muda e nada volta
    expect((await sincronizar()).novas).toBe(0);
  });
});
