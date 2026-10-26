import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Sem SMTP de verdade: finge que o e-mail está ligado e guarda os links enviados
const enviados: { protocolo: string; link: string }[] = [];
const avisos: string[] = [];
vi.mock("../src/notify.js", async (original) => ({
  ...(await original<typeof import("../src/notify.js")>()),
  smtpLigado: () => true,
  enviarPesquisa: async (o: { protocolo: string }, link: string) => { enviados.push({ protocolo: o.protocolo, link }); },
  enviarTelegram: async (t: string) => { avisos.push(t); },
}));

const { db } = await import("../src/db.js");
const { enviarPesquisasPendentes } = await import("../src/pesquisa.js");
const { novaOcorrencia, subir } = await import("./ajuda.js");
type Servidor = Awaited<ReturnType<typeof subir>>;

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

const resolvidaHa = (protocolo: string, modificador: string) =>
  db.prepare("UPDATE ocorrencias SET resolvida_em = datetime('now', ?) WHERE protocolo = ?").run(modificador, protocolo);

describe("pesquisa de satisfação", () => {
  it("envia uma vez só, depois do prazo, e só para resolvidas recentes do formulário", async () => {
    const pronta = await novaOcorrencia(s.url);
    const cedo = await novaOcorrencia(s.url);
    const antiga = await novaOcorrencia(s.url);
    const aberta = await novaOcorrencia(s.url);
    for (const p of [pronta, cedo, antiga]) await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "resolvida" });
    resolvidaHa(pronta, "-3 hours");
    resolvidaHa(antiga, "-10 days");

    expect(await enviarPesquisasPendentes()).toBe(1);
    expect(enviados.map((e) => e.protocolo)).toEqual([pronta]);
    expect(await enviarPesquisasPendentes()).toBe(0);
    expect(enviados.map((e) => e.protocolo)).not.toContain(aberta);
  });

  it("registra a nota pelo link, aceita comentário e avisa nota baixa", async () => {
    const p = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "resolvida" });
    resolvidaHa(p, "-3 hours");
    await enviarPesquisasPendentes();
    const t = new URL(enviados.find((e) => e.protocolo === p)!.link).searchParams.get("t")!;

    const g = await (await fetch(`${s.url}/api/avaliacao?t=${t}`)).json();
    expect(g).toMatchObject({ protocolo: p, respondida: false });

    const post = (corpo: object) => fetch(s.url + "/api/avaliacao", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t, ...corpo }) });
    expect((await post({ nota: 7 })).status).toBe(400);
    expect((await post({ nota: 2 })).status).toBe(200);
    expect(avisos.some((a) => a.includes("Avaliação baixa: 2/5") && a.includes(p))).toBe(true);
    expect((await post({ nota: 5, comentario: "Resolveram rápido!" })).status).toBe(200);

    const d = await (await s.painel("GET", `/ocorrencias/${p}`)).json();
    expect(d.pesquisa).toMatchObject({ nota: 5, comentario: "Resolveram rápido!" });
    const n = await (await s.painel("GET", "/estatisticas?dias=30")).json();
    expect(n.satisfacao.respostas).toBeGreaterThanOrEqual(1);
    expect(n.porNota).toContainEqual({ k: 5, n: 1 });

    expect((await fetch(`${s.url}/api/avaliacao?t=${"0".repeat(48)}`)).status).toBe(404);
  });
});
