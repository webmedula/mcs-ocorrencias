import { CONFERENCIAS, TIPOS, type Conferencia, type Tipo } from "./config.js";
import { contaDa } from "./conta.js";
import { db } from "./db.js";

/**
 * SAÚDE DO PRODUTO (v1.13.0): as reclamações de um período, uma linha por ocorrência, com o produto
 * e o que se sabe do motivo. Quem junta isso com as perguntas do ML (mcs-bot) e a nota do anúncio
 * (ml-analytics) é o Gerente IA, que monta o relatório mensal por produto.
 *
 * Sem dado pessoal: nada de nome, e-mail, telefone, pedido ou texto do cliente. Vai o motivo que o
 * Mercado Livre informa, o tipo da ocorrência e o que a equipe registrou na conferência da devolução.
 */

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodoSaude { desde: string; ate: string }

/** Período pedido em ?desde=AAAA-MM-DD&ate=AAAA-MM-DD (o "até" entra inteiro). Padrão: últimos 30 dias. */
export function periodoDe(q: { desde?: unknown; ate?: unknown }, hoje = new Date()): PeriodoSaude | null {
  const ate = typeof q.ate === "string" && q.ate ? q.ate : hoje.toISOString().slice(0, 10);
  const desde = typeof q.desde === "string" && q.desde ? q.desde : new Date(hoje.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  if (!DATA.test(desde) || !DATA.test(ate) || desde > ate) return null;
  return { desde, ate };
}

interface Linha {
  id: number; protocolo: string; criado_em: string; origem: string; canal: string; tipo: string; status: string;
  desfecho: string | null; custo_centavos: number | null; ml_json: string | null; produto_json: string | null;
  anonimizada: number; conferencia: string | null; conferencia_obs: string | null; motivo_real: string | null;
  reputacao_afetada: number | null; tem_conta: number | null;
}

const json = (s: string | null): any => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function reclamacoesDoPeriodo(p: PeriodoSaude) {
  const linhas = db.prepare(
    `SELECT o.id, o.protocolo, o.criado_em, o.origem, o.canal, o.tipo, o.status, o.desfecho, o.custo_centavos, o.ml_json,
            o.produto_json, o.anonimizada, d.conferencia, d.conferencia_obs, d.motivo_real, c.reputacao_afetada,
            (c.ocorrencia_id IS NOT NULL) AS tem_conta
       FROM ocorrencias o
       LEFT JOIN devolucoes d ON d.ocorrencia_id = o.id
       LEFT JOIN conta_venda c ON c.ocorrencia_id = o.id
      WHERE o.criado_em >= ? AND o.criado_em < date(?, '+1 day')
      ORDER BY o.criado_em`,
  ).all(p.desde, p.ate) as Linha[];

  const ocorrencias = linhas.map((o) => {
    const produtos = (Array.isArray(json(o.produto_json)) ? json(o.produto_json) : []) as any[];
    // Custo para a MCS: o resultado da conta da venda (negativo = prejuízo); sem conta, o custo lançado à mão.
    let custo: number | null = null;
    if (o.tem_conta) {
      const r = contaDa(o.id)?.resultado;
      if (typeof r === "number") custo = Math.round(-r * 100) / 100;
    }
    if (custo == null && o.custo_centavos != null) custo = o.custo_centavos / 100;
    return {
      protocolo: o.protocolo,
      criadoEm: o.criado_em,
      origem: o.origem,
      canal: o.canal,
      tipo: o.tipo,
      tipoNome: TIPOS[o.tipo as Tipo] ?? o.tipo,
      motivoMl: json(o.ml_json)?.motivo ?? null,
      status: o.status,
      desfecho: o.desfecho,
      produtos: produtos.map((x) => ({
        // No formulário o produto vem do Tiny e item_id é o id do Tiny: só vale como anúncio se for MLB.
        itemId: typeof x?.item_id === "string" && /^MLB\d+$/i.test(x.item_id) ? x.item_id.toUpperCase() : null,
        sku: x?.sku ?? null,
        titulo: x?.titulo ?? null,
        variacao: x?.variacao ?? null,
      })),
      conferencia: o.conferencia,
      conferenciaNome: o.conferencia ? CONFERENCIAS[o.conferencia as Conferencia] ?? o.conferencia : null,
      // Texto escrito pela equipe na conferência. Anonimizada (LGPD) não leva texto livre nenhum.
      conferenciaObs: o.anonimizada ? null : o.conferencia_obs,
      motivoReal: o.anonimizada ? null : o.motivo_real,
      reputacaoAfetada: o.reputacao_afetada == null ? null : o.reputacao_afetada === 1,
      custo,
    };
  });

  return { periodo: p, total: ocorrencias.length, semProduto: ocorrencias.filter((o) => o.produtos.length === 0).length, ocorrencias };
}
