import { config } from "./config.js";
import { db } from "./db.js";
import { buscarPedido, custosDoPedido } from "./tiny.js";

/** Custo do produto na conta da venda pelo Tiny (v1.10.0).
 *  Valor digitado pela equipe (custo_origem = 'manual') sempre vale mais que o do Tiny. */

const centavos = (v: number | null) => (v == null ? null : Math.round(v * 100));

/** Id do pedido no Tiny: o que veio na importação ou, se não achou na época, uma nova busca pelo número do pedido. */
async function idPedidoTiny(ocId: number): Promise<string | null> {
  const o = db.prepare("SELECT pedido, tiny_json FROM ocorrencias WHERE id = ?").get(ocId) as { pedido: string; tiny_json: string | null } | undefined;
  if (!o) return null;
  try { const id = o.tiny_json ? String(JSON.parse(o.tiny_json)?.id ?? "") : ""; if (id) return id; } catch { /* busca de novo */ }
  const t = await buscarPedido(o.pedido);
  if (t.status === "erro") throw new Error(t.detalhe);
  if (t.status !== "encontrado") return null;
  db.prepare("UPDATE ocorrencias SET tiny_status = 'encontrado', tiny_json = ? WHERE id = ?").run(JSON.stringify(t.pedido), ocId);
  return t.pedido.id || null;
}

/** Lê o custo no Tiny e grava. Devolve true quando conseguiu o custo completo. Nunca lança. */
export async function atualizarCustoTiny(ocId: number): Promise<boolean> {
  if (!config.tinyToken) return false;
  db.prepare("INSERT OR IGNORE INTO conta_venda (ocorrencia_id) VALUES (?)").run(ocId);
  let total: number | null = null, json: string | null = null, erro: string | null = null;
  try {
    const id = await idPedidoTiny(ocId);
    if (!id) erro = "Pedido não encontrado no Tiny.";
    else {
      const c = await custosDoPedido(id);
      json = JSON.stringify(c.itens);
      total = centavos(c.total);
      if (!c.itens.length) erro = "Pedido sem itens no Tiny.";
      else if (c.faltando.length) erro = `Sem custo no cadastro do Tiny: ${c.faltando.join(", ")}.`;
    }
  } catch (e: any) {
    erro = `Falha ao consultar o Tiny: ${String(e?.message ?? e).slice(0, 200)}`;
    console.error(`[custo] ocorrência ${ocId}: ${erro}`);
  }
  db.prepare(
    `UPDATE conta_venda SET custo_tiny_centavos = ?, custo_tiny_json = COALESCE(?, custo_tiny_json), custo_tiny_erro = ?, custo_tiny_em = datetime('now'),
       custo_produto_centavos = CASE WHEN custo_origem = 'manual' THEN custo_produto_centavos ELSE ? END,
       custo_origem = CASE WHEN custo_origem = 'manual' THEN 'manual' WHEN ? IS NULL THEN NULL ELSE 'tiny' END
     WHERE ocorrencia_id = ?`,
  ).run(total, json, erro, total, total, ocId);
  return total != null;
}

/** Rotina: preenche o custo das ocorrências do ML que ainda não têm (poucas por vez, pelo limite da API do Tiny).
 *  Quem ficou sem custo (produto sem custo no cadastro, pedido não achado) é tentado de novo uma vez por dia. */
export async function completarCustosTiny(max = 5): Promise<number> {
  if (!config.tinyToken) return 0;
  const ids = (db.prepare(
    `SELECT o.id FROM ocorrencias o LEFT JOIN conta_venda c ON c.ocorrencia_id = o.id
     WHERE o.origem = 'ml' AND o.anonimizada = 0
       AND (c.custo_tiny_em IS NULL OR (c.custo_tiny_centavos IS NULL AND c.custo_tiny_em < datetime('now','-1 day')))
     ORDER BY c.custo_tiny_em IS NOT NULL, o.criado_em DESC LIMIT ?`,
  ).all(max) as { id: number }[]).map((r) => r.id);
  let n = 0;
  for (const id of ids) if (await atualizarCustoTiny(id)) n++;
  return n;
}
