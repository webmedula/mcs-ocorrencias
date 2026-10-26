import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { itensDoPedido } from "./tiny.js";

/** Produto do pedido mostrado na ocorrência (Mercado Livre desde a v1.5.0; Tiny desde a v1.7.0). */
export interface Produto {
  item_id: string | null; titulo: string | null; sku: string | null; qtd: number | null;
  preco: number | null; permalink: string | null; foto: string | null; variacao: string | null;
}

export const pastaProdutos = path.join(config.dataDir, "produtos");
const FOTO_MAX = 3 * 1024 * 1024;

/** Baixa a foto uma vez e guarda no volume (continua valendo se o anúncio mudar). Devolve o nome do arquivo. */
export async function guardarFoto(url: string | null | undefined, hostConfiavel: (u: URL) => boolean): Promise<string | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!hostConfiavel(u)) return null;
    const nomeBase = crypto.createHash("sha1").update(u.href).digest("hex").slice(0, 16);
    fs.mkdirSync(pastaProdutos, { recursive: true });
    for (const ext of ["jpg", "png", "webp"]) if (fs.existsSync(path.join(pastaProdutos, `${nomeBase}.${ext}`))) return `${nomeBase}.${ext}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const tipo = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = tipo === "image/png" ? "png" : tipo === "image/webp" ? "webp" : tipo === "image/jpeg" ? "jpg" : null;
    if (!ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > FOTO_MAX) return null;
    fs.writeFileSync(path.join(pastaProdutos, `${nomeBase}.${ext}`), buf);
    return `${nomeBase}.${ext}`;
  } catch (e: any) {
    console.error(`[produto] foto: ${e?.message}`);
    return null;
  }
}

// ---------- Produtos das ocorrências do formulário, pelo Tiny (v1.7.0) ----------
// As imagens vêm do cadastro do próprio Tiny (anexos ou imagens externas): aceita qualquer site em https,
// mas nunca endereço interno.
function hostPublico(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return !/^[\d.]+$/.test(h) && !h.includes(":") && h.includes(".");
}

/** Busca os itens do pedido no Tiny e grava em produto_json. Devolve quantos produtos gravou. Lança se o Tiny falhar. */
export async function completarProdutosTiny(ocorrenciaId: number): Promise<number> {
  const o = db.prepare("SELECT tiny_json, anonimizada FROM ocorrencias WHERE id = ?").get(ocorrenciaId) as
    | { tiny_json: string | null; anonimizada: number } | undefined;
  if (!o?.tiny_json || o.anonimizada || !config.tinyToken) return 0;
  let idPedido = "";
  try { idPedido = String(JSON.parse(o.tiny_json)?.id ?? ""); } catch { /* ignora */ }
  if (!idPedido) return 0;
  const itens = await itensDoPedido(idPedido);
  const produtos: Produto[] = [];
  for (const it of itens) {
    produtos.push({
      item_id: it.id_produto, titulo: it.titulo, sku: it.sku, qtd: it.qtd, preco: it.preco, permalink: null,
      variacao: it.variacao, foto: await guardarFoto(it.imagem, hostPublico),
    });
  }
  // "[]" também é gravado: o pedido não tem itens e não adianta perguntar de novo
  db.prepare("UPDATE ocorrencias SET produto_json = ? WHERE id = ? AND produto_json IS NULL").run(JSON.stringify(produtos), ocorrenciaId);
  return produtos.length;
}

// Ocorrências que falharam nesta execução: não insiste nelas (evita travar a fila numa só)
const falharam = new Set<number>();

/** Rotina: completa as ocorrências antigas que ainda não têm produto (poucas por vez, pelo limite da API do Tiny). */
export async function completarPendentesTiny(max = 3): Promise<number> {
  if (!config.tinyToken) return 0;
  const ids = (db
    .prepare(
      `SELECT id FROM ocorrencias WHERE origem = 'formulario' AND tiny_status = 'encontrado' AND produto_json IS NULL
         AND anonimizada = 0 ORDER BY id DESC LIMIT 50`,
    )
    .all() as { id: number }[]).map((r) => r.id).filter((id) => !falharam.has(id)).slice(0, max);
  let feitas = 0;
  for (const id of ids) {
    try { await completarProdutosTiny(id); feitas++; }
    catch (e: any) { falharam.add(id); console.error(`[tiny] produtos da ocorrência ${id}: ${e?.message}`); }
  }
  return feitas;
}
