import crypto from "node:crypto";
import { config, type Tipo } from "./config.js";
import { db } from "./db.js";
import { esc, enviarTelegram } from "./notify.js";
import { gerarProtocolo } from "./protocol.js";
import { buscarPedido } from "./tiny.js";

// ---------- Erros ----------
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

interface Conexao {
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
const conexao = () => db.prepare("SELECT * FROM ml_conexao WHERE id = 1").get() as Conexao | undefined;
const sqlData = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const daSql = (s: string) => new Date(s.replace(" ", "T") + "Z");

export function statusConexao() {
  const c = conexao();
  return {
    configurado: mlConfigurado(),
    conectado: Boolean(c),
    nickname: c?.nickname ?? null,
    userId: c?.user_id ?? null,
    conectadoEm: c?.conectado_em ?? null,
    ultimaSync: c?.ultima_sync ?? null,
    ultimoErro: c?.ultimo_erro ?? null,
    redirectUri: config.mlRedirectUri,
    intervaloMin: config.mlPollMinutes,
  };
}

export function desconectar(): void {
  db.prepare("DELETE FROM ml_conexao WHERE id = 1").run();
}

// ---------- OAuth ----------
export function urlAutorizacao(usuarioId: number): string {
  if (!mlConfigurado()) throw new MlErro(400, "Defina ML_CLIENT_ID e ML_CLIENT_SECRET no servidor.");
  db.prepare("DELETE FROM ml_estados WHERE expira_em < datetime('now')").run();
  const state = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO ml_estados (state, usuario_id, expira_em) VALUES (?,?, datetime('now','+10 minutes'))").run(state, usuarioId);
  const u = new URL("/authorization", config.mlAuthBase);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", config.mlClientId);
  u.searchParams.set("redirect_uri", config.mlRedirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

async function pedirToken(params: Record<string, string>) {
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

function guardarTokens(t: Awaited<ReturnType<typeof pedirToken>>, nickname?: string | null) {
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

/** Termina o fluxo OAuth: valida o state (uso único), troca o código por tokens e guarda. */
export async function concluirAutorizacao(code: string, state: string): Promise<string> {
  const e = db.prepare("SELECT state FROM ml_estados WHERE state = ? AND expira_em > datetime('now')").get(state);
  if (!e) throw new MlErro(400, "Link de autorização inválido ou vencido. Tente conectar de novo.");
  db.prepare("DELETE FROM ml_estados WHERE state = ?").run(state);
  const t = await pedirToken({ grant_type: "authorization_code", code, redirect_uri: config.mlRedirectUri });
  let nick: string | null = null;
  try {
    const r = await fetch(new URL("/users/me", config.mlApiBase), {
      headers: { authorization: `Bearer ${t.access_token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    nick = ((await r.json()) as any)?.nickname ?? null;
  } catch { /* o apelido é só informativo */ }
  guardarTokens(t, nick);
  return nick ?? String(t.user_id);
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

async function ml(caminho: string, init: { metodo?: string; corpo?: unknown } = {}, tentouRenovar = false): Promise<any> {
  const token = await tokenValido();
  const res = await fetch(new URL(caminho, config.mlApiBase), {
    method: init.metodo ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.corpo ? { "content-type": "application/json" } : {}),
    },
    body: init.corpo ? JSON.stringify(init.corpo) : undefined,
    signal: AbortSignal.timeout(20000),
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

// ---------- Mapeamento ----------
const tipoDoMotivo = (reasonId: string, tipoClaim: string): Tipo => {
  if (tipoClaim === "return") return "troca_devolucao";
  const p = (reasonId || "").slice(0, 3).toUpperCase();
  if (p === "PNR") return "nao_recebido";
  if (p === "PDD") return "defeito";
  if (p === "CS" || reasonId?.toUpperCase().startsWith("CS")) return "troca_devolucao";
  return "outro";
};

const listaDe = (r: any): any[] => (Array.isArray(r) ? r : r?.data ?? r?.results ?? []);

function prazoDe(claim: any, vendedor: string): string | null {
  const eu = (claim.players ?? []).find((p: any) => p.role === "respondent" && String(p.user_id) === vendedor);
  const datas = (eu?.available_actions ?? [])
    .map((a: any) => a.due_date)
    .filter(Boolean)
    .map((d: string) => new Date(d))
    .filter((d: Date) => !Number.isNaN(d.getTime()))
    .sort((a: Date, b: Date) => a.getTime() - b.getTime());
  return datas.length ? sqlData(datas[0]) : null;
}

const resumoClaim = (claim: any, vendedor: string, motivo?: string | null) => ({
  id: String(claim.id),
  type: claim.type ?? null,
  stage: claim.stage ?? null,
  status: claim.status ?? null,
  reason_id: claim.reason_id ?? null,
  motivo: motivo ?? null,
  resource: claim.resource ?? null,
  resource_id: claim.resource_id != null ? String(claim.resource_id) : null,
  date_created: claim.date_created ?? null,
  last_updated: claim.last_updated ?? null,
  resolution: claim.resolution ?? null,
  acoes: ((claim.players ?? []).find((p: any) => p.role === "respondent" && String(p.user_id) === vendedor)?.available_actions ?? [])
    .map((a: any) => ({ action: a.action, due_date: a.due_date ?? null, mandatory: Boolean(a.mandatory) })),
});

// ---------- Sincronização ----------
const hashTxt = (t: string) => crypto.createHash("sha1").update(t.trim()).digest("hex");

interface ResultadoSync { novas: number; atualizadas: number; mensagens: number }
let sincronizando: Promise<ResultadoSync> | null = null;

export function sincronizar(): Promise<ResultadoSync> {
  sincronizando ??= sincronizarAgora().finally(() => { sincronizando = null; });
  return sincronizando;
}

async function sincronizarAgora(): Promise<ResultadoSync> {
  const res: ResultadoSync = { novas: 0, atualizadas: 0, mensagens: 0 };
  const c = conexao();
  if (!c) return res;
  try {
    const abertas = new Map<string, any>();
    for (let offset = 0; offset < 300; offset += 50) {
      const q = new URLSearchParams({
        "players.role": "respondent", "players.user_id": c.user_id, status: "opened",
        sort: "last_updated:desc", limit: "50", offset: String(offset),
      });
      const lista = listaDe(await ml(`/post-purchase/v1/claims/search?${q}`));
      for (const cl of lista) abertas.set(String(cl.id), cl);
      if (lista.length < 50) break;
    }
    // Acompanhadas que ainda não estão resolvidas e sumiram da busca de abertas: foram encerradas no ML
    const acompanhadas = db
      .prepare("SELECT ml_claim_id FROM ocorrencias WHERE origem = 'ml' AND status != 'resolvida' AND ml_claim_id IS NOT NULL")
      .all() as { ml_claim_id: string }[];
    for (const a of acompanhadas) if (!abertas.has(a.ml_claim_id)) abertas.set(a.ml_claim_id, null);

    for (const [id, base] of abertas) {
      try {
        const claim = base ?? (await ml(`/post-purchase/v1/claims/${encodeURIComponent(id)}`));
        const r = await processarClaim(claim, c.user_id);
        res.novas += r.nova ? 1 : 0;
        res.atualizadas += r.atualizada ? 1 : 0;
        res.mensagens += r.mensagens;
      } catch (e: any) {
        console.error(`[ml] falha ao processar reclamação ${id}: ${e?.message}`);
        if (e instanceof MlErro && e.status === 401) throw e;
      }
    }
    db.prepare("UPDATE ml_conexao SET ultima_sync = datetime('now'), ultimo_erro = NULL WHERE id = 1").run();
  } catch (e: any) {
    const msg = e instanceof MlErro ? e.message : `Falha ao sincronizar: ${e?.message}`;
    console.error(`[ml] ${msg}`);
    db.prepare("UPDATE ml_conexao SET ultimo_erro = ? WHERE id = 1").run(msg.slice(0, 300));
  }
  return res;
}

async function dadosDoPedido(claim: any): Promise<{ pedido: string; nome: string; titulo: string | null }> {
  const rid = claim.resource_id != null ? String(claim.resource_id) : String(claim.id);
  let nome = "Comprador do Mercado Livre";
  let titulo: string | null = null;
  if (claim.resource === "order" || claim.resource === undefined) {
    try {
      const o = await ml(`/orders/${encodeURIComponent(rid)}`);
      nome = o?.buyer?.nickname || (o?.buyer?.id ? `Comprador ${o.buyer.id}` : nome);
      titulo = o?.order_items?.[0]?.item?.title ?? null;
    } catch (e: any) {
      console.error(`[ml] não consegui ler o pedido ${rid}: ${e?.message}`);
    }
  }
  return { pedido: rid, nome, titulo };
}

async function motivoDe(reasonId: string | null): Promise<string | null> {
  if (!reasonId) return null;
  try {
    const r = await ml(`/post-purchase/v1/claims/reasons/${encodeURIComponent(reasonId)}`);
    return r?.name ?? r?.detail ?? null;
  } catch { return null; }
}

async function processarClaim(claim: any, vendedor: string): Promise<{ nova: boolean; atualizada: boolean; mensagens: number }> {
  const id = String(claim.id);
  const existente = db.prepare("SELECT * FROM ocorrencias WHERE ml_claim_id = ?").get(id) as any | undefined;
  const prazo = prazoDe(claim, vendedor);

  if (!existente) {
    if (claim.status === "closed") return { nova: false, atualizada: false, mensagens: 0 }; // não importa histórico já encerrado
    const motivo = await motivoDe(claim.reason_id ?? null);
    const { pedido, nome, titulo } = await dadosDoPedido(claim);
    const tiny = await buscarPedido(pedido);
    const msgs = await baixarMensagens(id);
    const primeira = msgs.find((m) => m.sender_role === "complainant")?.message;
    const descricao = [
      "Reclamação aberta no Mercado Livre.",
      `Motivo: ${motivo ?? "(não informado)"}${claim.reason_id ? ` [${claim.reason_id}]` : ""}`,
      titulo ? `Produto: ${titulo}` : "",
      primeira ? `\nPrimeira mensagem do comprador:\n${primeira}` : "",
    ].filter(Boolean).join("\n").slice(0, 3000);
    let protocolo = "";
    let ocId = 0;
    db.transaction(() => {
      for (let t = 0; ; t++) {
        protocolo = gerarProtocolo();
        try {
          const r = db.prepare(
            `INSERT INTO ocorrencias (protocolo, canal, pedido, tipo, descricao, nome, email, telefone, tiny_status, tiny_json,
                                      origem, ml_claim_id, ml_json, prazo_em)
             VALUES (?, 'mercado_livre', ?, ?, ?, ?, '', NULL, ?, ?, 'ml', ?, ?, ?)`,
          ).run(
            protocolo, pedido, tipoDoMotivo(claim.reason_id ?? "", claim.type ?? ""), descricao, nome,
            tiny.status, tiny.status === "encontrado" ? JSON.stringify(tiny.pedido) : null,
            id, JSON.stringify(resumoClaim(claim, vendedor, motivo)), prazo,
          );
          ocId = Number(r.lastInsertRowid);
          break;
        } catch (e: any) {
          if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" && t < 5 && !String(e.message).includes("ml_claim_id")) continue;
          throw e;
        }
      }
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)")
        .run(ocId, "Reclamação importada do Mercado Livre.", "Sistema");
    })();
    const n = gravarMensagens(ocId, msgs);
    await enviarTelegram(
      [
        "🟠 <b>Nova reclamação no Mercado Livre</b> " + `<code>${esc(protocolo)}</code>`,
        `Pedido: <code>${esc(pedido)}</code> · Comprador: ${esc(nome)}`,
        `Motivo: ${esc(motivo ?? claim.reason_id ?? "—")}`,
        prazo ? `⏰ Prazo para responder: ${esc(daSql(prazo).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))}` : "",
        `<a href="${esc(config.publicUrl)}/painel#${encodeURIComponent(protocolo)}">Abrir no painel</a>`,
      ].filter(Boolean).join("\n"),
    );
    return { nova: true, atualizada: false, mensagens: n };
  }

  // Já conhecida: atualiza resumo/prazo, confere encerramento e novas mensagens
  const anterior = existente.ml_json ? JSON.parse(existente.ml_json) : {};
  const mudou = anterior.last_updated !== (claim.last_updated ?? null) || anterior.status !== (claim.status ?? null);
  let mensagens = 0;
  if (mudou) {
    const resumo = resumoClaim(claim, vendedor, anterior.motivo ?? null);
    db.prepare("UPDATE ocorrencias SET ml_json = ?, prazo_em = ?, atualizado_em = datetime('now') WHERE id = ?")
      .run(JSON.stringify(resumo), prazo, existente.id);
    mensagens = gravarMensagens(existente.id, await baixarMensagens(id), true, existente);
  }
  if (claim.status === "closed" && existente.status !== "resolvida") {
    db.transaction(() => {
      db.prepare("UPDATE ocorrencias SET status = 'resolvida', prazo_em = NULL, atualizado_em = datetime('now') WHERE id = ?").run(existente.id);
      db.prepare("INSERT INTO eventos (ocorrencia_id, texto, publico, autor) VALUES (?,?,0,?)")
        .run(existente.id, "Reclamação encerrada no Mercado Livre.", "Sistema");
    })();
  }
  return { nova: false, atualizada: mudou, mensagens };
}

async function baixarMensagens(claimId: string): Promise<any[]> {
  try {
    return listaDe(await ml(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/messages`));
  } catch (e: any) {
    console.error(`[ml] mensagens da reclamação ${claimId}: ${e?.message}`);
    return [];
  }
}

/** Grava mensagens ainda não vistas. Devolve quantas eram novas. Avisa o Telegram se o comprador escreveu. */
function gravarMensagens(ocId: number, msgs: any[], avisar = false, oc?: any): number {
  let novas = 0;
  const novasDoComprador: string[] = [];
  const claimId = oc?.ml_claim_id ?? (db.prepare("SELECT ml_claim_id FROM ocorrencias WHERE id = ?").get(ocId) as any)?.ml_claim_id;
  for (const m of msgs) {
    const texto = String(m.message ?? "").trim();
    const anexos = Array.isArray(m.attachments) ? m.attachments.length : 0;
    if (!texto && !anexos) continue;
    const data = String(m.date_created ?? m.message_date ?? "");
    const k = hashTxt(`${m.sender_role}|${m.receiver_role}|${data}|${texto}`);
    const dataSql = data ? sqlData(new Date(data)) : sqlData(new Date());
    // Mensagem que nós mesmos enviamos: descobre quem foi (pessoa ou Gerente IA)
    let autor: string | null = null;
    if (m.sender_role === "respondent" && claimId) {
      const env = db
        .prepare("SELECT id, autor FROM ml_envios WHERE claim_id = ? AND texto_hash = ? AND criado_em > datetime('now','-1 day') ORDER BY id LIMIT 1")
        .get(claimId, hashTxt(texto)) as { id: number; autor: string } | undefined;
      if (env) autor = env.autor;
    }
    const r = db
      .prepare("INSERT OR IGNORE INTO ml_mensagens (ocorrencia_id, chave, remetente, destinatario, texto, anexos, autor, data) VALUES (?,?,?,?,?,?,?,?)")
      .run(ocId, k, String(m.sender_role ?? ""), m.receiver_role ?? null, texto || "(anexo)", anexos, autor, dataSql);
    if (r.changes > 0) {
      novas++;
      if (autor && claimId) db.prepare("DELETE FROM ml_envios WHERE claim_id = ? AND texto_hash = ?").run(claimId, hashTxt(texto));
      if (m.sender_role === "complainant") novasDoComprador.push(texto || "(anexo)");
    }
  }
  if (avisar && novasDoComprador.length && oc) {
    // Comprador respondeu: tira de "aguardando" e avisa
    if (oc.status === "aguardando_cliente" || oc.status === "resolvida") {
      db.prepare("UPDATE ocorrencias SET status = 'em_analise' WHERE id = ?").run(ocId);
    }
    const ultimo = novasDoComprador[novasDoComprador.length - 1];
    void enviarTelegram(
      [
        `💬 <b>Comprador respondeu no Mercado Livre</b> <code>${esc(oc.protocolo)}</code>`,
        esc(ultimo.length > 400 ? ultimo.slice(0, 400) + "…" : ultimo),
        `<a href="${esc(config.publicUrl)}/painel#${encodeURIComponent(oc.protocolo)}">Abrir no painel</a>`,
      ].join("\n"),
    );
  }
  return novas;
}

// ---------- Responder o comprador ----------
const LIMITE_TEXTO = 2000;

export async function enviarMensagem(oc: any, texto: string, autor: string): Promise<{ destinatario: string }> {
  const t = texto.trim();
  if (t.length < 2) throw new MlErro(400, "Escreva a mensagem.");
  if (t.length > LIMITE_TEXTO) throw new MlErro(400, `A mensagem pode ter no máximo ${LIMITE_TEXTO} caracteres.`);
  const claimId = String(oc.ml_claim_id);
  // Detalhe atualizado: se já está em mediação, a mensagem vai ao mediador, não ao comprador
  const claim = await ml(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
  if (claim?.status === "closed") throw new MlErro(409, "Esta reclamação já foi encerrada no Mercado Livre.");
  const destinatario = claim?.stage === "dispute" ? "mediator" : "complainant";
  db.prepare("INSERT INTO ml_envios (claim_id, texto_hash, autor) VALUES (?,?,?)").run(claimId, hashTxt(t), autor);
  try {
    await ml(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}/messages`, {
      metodo: "POST",
      corpo: { receiver_role: destinatario, message: t },
    });
  } catch (e) {
    db.prepare("DELETE FROM ml_envios WHERE claim_id = ? AND texto_hash = ? AND autor = ?").run(claimId, hashTxt(t), autor);
    throw e;
  }
  const c = conexao();
  const resumo = resumoClaim(claim, c?.user_id ?? "", oc.ml_json ? JSON.parse(oc.ml_json).motivo : null);
  db.prepare("UPDATE ocorrencias SET ml_json = ?, prazo_em = ?, atualizado_em = datetime('now') WHERE id = ?")
    .run(JSON.stringify(resumo), prazoDe(claim, c?.user_id ?? ""), oc.id);
  gravarMensagens(oc.id, await baixarMensagens(claimId));
  return { destinatario };
}

// ---------- Agendamento ----------
export function iniciarSincronizacaoML(): void {
  if (!mlConfigurado()) {
    console.log("[ml] Integração com o Mercado Livre desligada (ML_CLIENT_ID/ML_CLIENT_SECRET vazios).");
    return;
  }
  console.log(`[ml] Integração ligada. ${conexao() ? `Conectado como ${conexao()!.nickname ?? conexao()!.user_id}.` : "Ainda não conectado: use a aba Equipe do painel."} Sincroniza a cada ${config.mlPollMinutes} min.`);
  const rodar = () => { if (conexao()) void sincronizar(); };
  setTimeout(rodar, 15000).unref();
  setInterval(rodar, config.mlPollMinutes * 60 * 1000).unref();
}
