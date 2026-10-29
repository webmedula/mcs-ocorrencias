import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

/** Acesso à API do Mercado Livre: erros, tokens cifrados, renovação e a chamada autenticada ml().
 *  Fica separado de ml.ts (reclamações) para que devoluções.ts use a API sem importação circular. */

export class MlErro extends Error {
  constructor(public status: number, msg: string, public corpo?: unknown) {
    super(msg);
  }
}

export const mlConfigurado = () => Boolean(config.mlClientId && config.mlClientSecret);

// ---------- Tokens guardados cifrados (AES-256-GCM, chave derivada do ML_CLIENT_SECRET) ----------
const chave = () => crypto.createHash("sha256").update("mcs-ml-token:" + config.mlClientSecret).digest();
function cifrar(txt: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  const ct = Buffer.concat([c.update(txt, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
function decifrar(enc: string): string {
  const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", chave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export interface Conexao {
  user_id: string;
  nickname: string | null;
  access_enc: string;
  refresh_enc: string;
  expira_em: string;
  scope: string | null;
  conectado_em: string;
  ultima_sync: string | null;
  ultimo_erro: string | null;
}
export const conexao = () => db.prepare("SELECT * FROM ml_conexao WHERE id = 1").get() as Conexao | undefined;
export const sqlData = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
export const daSql = (s: string) => new Date(s.replace(" ", "T") + "Z");


// ---------- OAuth (troca e guarda de tokens) ----------
export async function pedirToken(params: Record<string, string>) {
  const res = await fetch(new URL("/oauth/token", config.mlApiBase), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.mlClientId, client_secret: config.mlClientSecret, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new MlErro(res.status, j.message || j.error_description || j.error || `HTTP ${res.status}`, j);
  }
  return j as { access_token: string; refresh_token: string; expires_in: number; user_id: number | string; scope?: string };
}

export function guardarTokens(t: Awaited<ReturnType<typeof pedirToken>>, nickname?: string | null) {
  const atual = conexao();
  const expira = sqlData(new Date(Date.now() + (t.expires_in || 21600) * 1000));
  db.prepare(
    `INSERT INTO ml_conexao (id, user_id, nickname, access_enc, refresh_enc, expira_em, scope, ultimo_erro)
     VALUES (1,?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, nickname=COALESCE(excluded.nickname, ml_conexao.nickname),
       access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expira_em=excluded.expira_em,
       scope=COALESCE(excluded.scope, ml_conexao.scope), ultimo_erro=NULL`,
  ).run(String(t.user_id ?? atual?.user_id), nickname ?? null, cifrar(t.access_token), cifrar(t.refresh_token), expira, t.scope ?? null);
}

let renovando: Promise<string> | null = null;
async function tokenValido(forcar = false): Promise<string> {
  const c = conexao();
  if (!c) throw new MlErro(409, "Mercado Livre não conectado.");
  if (!forcar && daSql(c.expira_em).getTime() - Date.now() > 5 * 60 * 1000) return decifrar(c.access_enc);
  // Um refresh por vez: o refresh_token do ML é de uso único.
  renovando ??= (async () => {
    try {
      const atual = conexao()!;
      const t = await pedirToken({ grant_type: "refresh_token", refresh_token: decifrar(atual.refresh_enc) });
      guardarTokens(t);
      return t.access_token;
    } catch (e: any) {
      const msg = "A autorização com o Mercado Livre expirou ou foi revogada. Reconecte na aba Equipe.";
      db.prepare("UPDATE ml_conexao SET ultimo_erro = ? WHERE id = 1").run(msg);
      throw new MlErro(401, msg, e?.corpo);
    } finally {
      renovando = null;
    }
  })();
  return renovando;
}

/** Id do vendedor no Mercado Livre (null se não conectado). */
export const vendedorMl = (): string | null => conexao()?.user_id ?? null;

/** Chamada autenticada à API do ML. `form` envia multipart (upload de evidências). */
export async function ml(caminho: string, init: { metodo?: string; corpo?: unknown; form?: FormData } = {}, tentouRenovar = false): Promise<any> {
  const token = await tokenValido();
  const res = await fetch(new URL(caminho, config.mlApiBase), {
    method: init.metodo ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.corpo && !init.form ? { "content-type": "application/json" } : {}),
    },
    body: init.form ?? (init.corpo ? JSON.stringify(init.corpo) : undefined),
    signal: AbortSignal.timeout(init.form ? 60000 : 20000),
  });
  if (res.status === 401 && !tentouRenovar) {
    await tokenValido(true);
    return ml(caminho, init, true);
  }
  const txt = await res.text();
  let j: any = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }
  if (!res.ok) throw new MlErro(res.status, j?.message || j?.error || `HTTP ${res.status}`, j);
  return j;
}

