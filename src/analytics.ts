import { config } from "./config.js";

/** Ficha de lucro do ml-analytics (v1.13.0).
 *  O analytics guarda, por SKU, o custo unitário do produto (Tiny) que as promoções e o Gerente IA usam.
 *  A Central pega o mesmo número para a conta da venda; se o analytics não responder, ela segue pelo Tiny. */

export const chaveSku = (s: string | null | undefined): string => String(s ?? "").trim().toUpperCase();

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { em: number; custo: number | null }>();
export const limparCacheFichas = () => cache.clear();

/** Custo unitário de cada SKU na ficha de lucro (só os que têm custo). Nunca lança: falha vira mapa vazio. */
export async function custosDaFicha(skus: Array<string | null | undefined>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!config.analyticsBaseUrl || !config.analyticsApiKey) return out;
  const chaves = [...new Set(skus.map(chaveSku).filter(Boolean))];
  const faltam: string[] = [];
  for (const k of chaves) {
    const c = cache.get(k);
    if (c && Date.now() - c.em < CACHE_MS) { if (c.custo != null) out.set(k, c.custo); }
    else faltam.push(k);
  }
  if (!faltam.length) return out;
  try {
    const url = `${config.analyticsBaseUrl}/api/custos/fichas?skus=${encodeURIComponent(faltam.join(","))}`;
    const r = await fetch(url, { headers: { "x-api-key": config.analyticsApiKey }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const porSku: Record<string, any> = j?.porSku ?? {};
    for (const k of faltam) {
      const v = Number(porSku[k]?.custoUnitario);
      const custo = Number.isFinite(v) && v > 0 ? v : null;
      cache.set(k, { em: Date.now(), custo });
      if (custo != null) out.set(k, custo);
    }
  } catch (e: any) {
    console.error(`[analytics] ficha de lucro indisponível, usando o Tiny: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  return out;
}
