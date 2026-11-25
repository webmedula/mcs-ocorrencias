import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Sem SMTP de verdade: guarda os avisos de "resolvida" enviados
const enviados: { protocolo: string; solucao: string | null }[] = [];
vi.mock("../src/notify.js", async (original) => ({
  ...(await original<typeof import("../src/notify.js")>()),
  smtpLigado: () => true,
  enviarResolvida: async (o: { protocolo: string }, solucao: string | null) => { enviados.push({ protocolo: o.protocolo, solucao }); return true; },
}));

const { db } = await import("../src/db.js");
const { novaOcorrencia, subir } = await import("./ajuda.js");
type Servidor = Awaited<ReturnType<typeof subir>>;

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

const espera = () => new Promise((r) => setTimeout(r, 50));
const status = async (p: string, st: string) => { await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: st }); await espera(); };
const doCaso = (p: string) => enviados.filter((e) => e.protocolo === p);
// Recua o último aviso no tempo, para os eventos novos ficarem claramente depois dele
const avisoHa = (p: string) => db.prepare("UPDATE ocorrencias SET aviso_resolvida_em = datetime('now','-1 hour') WHERE protocolo = ?").run(p);

describe("e-mail de ocorrência resolvida (v1.16.0)", () => {
  it("avisa uma vez ao resolver, com o desfecho como solução", async () => {
    const p = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "reenvio" });
    await status(p, "em_analise");
    expect(doCaso(p)).toHaveLength(0);
    await status(p, "resolvida");
    expect(doCaso(p)).toEqual([{ protocolo: p, solucao: "Reenvio do produto" }]);
  });

  it("não reenvia se for reaberto e resolvido de novo sem novidade", async () => {
    const p = await novaOcorrencia(s.url);
    await status(p, "resolvida");
    avisoHa(p);
    await status(p, "em_analise");
    await status(p, "resolvida");
    expect(doCaso(p)).toHaveLength(1);
  });

  it("reenvia se o cliente escreveu depois do aviso", async () => {
    const p = await novaOcorrencia(s.url);
    await status(p, "resolvida");
    avisoHa(p);
    const f = new FormData();
    f.append("protocolo", p); f.append("email", "cliente@teste.local"); f.append("texto", "Ainda não chegou o reenvio.");
    expect((await fetch(s.url + "/api/consulta/mensagem", { method: "POST", body: f })).status).toBeLessThan(300);
    await status(p, "resolvida");
    expect(doCaso(p)).toHaveLength(2);
  });

  it("não avisa improcedente com solução nem reclamação do Mercado Livre", async () => {
    const p = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${p}/desfecho`, { desfecho: "sem_acao" });
    await status(p, "resolvida");
    expect(doCaso(p)).toEqual([{ protocolo: p, solucao: null }]);

    const ml = await novaOcorrencia(s.url);
    db.prepare("UPDATE ocorrencias SET origem = 'ml' WHERE protocolo = ?").run(ml);
    await status(ml, "resolvida");
    expect(doCaso(ml)).toHaveLength(0);
  });
});
