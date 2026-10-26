import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { anonimizar } from "../src/lgpd.js";
import { novaOcorrencia, pngFalso, subir, type Servidor } from "./ajuda.js";

let s: Servidor;
beforeAll(async () => { s = await subir(); });
afterAll(async () => { await s.fechar(); });

const consultar = (protocolo: string, email: string) =>
  fetch(`${s.url}/api/consulta?` + new URLSearchParams({ protocolo, email }));

function mensagem(protocolo: string, email: string, texto: string, fotos = 0) {
  const f = new FormData();
  f.append("protocolo", protocolo); f.append("email", email); f.append("texto", texto);
  for (let i = 0; i < fotos; i++) f.append("fotos", pngFalso(), `foto${i}.png`);
  return fetch(s.url + "/api/consulta/mensagem", { method: "POST", body: f });
}

describe("mensagem do cliente pela consulta", () => {
  it("só aceita protocolo + e-mail corretos", async () => {
    const p = await novaOcorrencia(s.url);
    expect((await mensagem(p, "outro@teste.local", "Olá, alguma novidade?")).status).toBe(404);
    expect((await consultar(p, "outro@teste.local")).status).toBe(404);
  });

  it("grava a mensagem com fotos, reabre o atendimento e aparece na consulta e no painel", async () => {
    const p = await novaOcorrencia(s.url);
    await s.painel("PATCH", `/ocorrencias/${p}/status`, { status: "aguardando_cliente" });

    const r = await mensagem(p, "CLIENTE@teste.local ", "Segue a foto da caixa amassada.", 2);
    expect(r.status).toBe(201);

    const c = await (await consultar(p, "cliente@teste.local")).json();
    expect(c.status).toBe("em_analise");
    expect(c.podeResponder).toBe(true);
    const doCliente = c.historico.filter((h: any) => h.cliente);
    expect(doCliente).toHaveLength(1);
    expect(doCliente[0].texto).toContain("Segue a foto");
    expect(doCliente[0].texto).toContain("2 fotos anexadas");

    const d = await (await s.painel("GET", `/ocorrencias/${p}`)).json();
    expect(d.anexos).toHaveLength(2);
    expect(d.eventos.some((e: any) => e.do_cliente === 1 && e.texto.startsWith("Segue a foto"))).toBe(true);
  });

  it("recusa mensagem vazia e arquivo que não é foto", async () => {
    const p = await novaOcorrencia(s.url);
    expect((await mensagem(p, "cliente@teste.local", " ")).status).toBe(400);
    const f = new FormData();
    f.append("protocolo", p); f.append("email", "cliente@teste.local"); f.append("texto", "Foto falsa");
    f.append("fotos", new Blob(["não sou png"], { type: "image/png" }), "x.png");
    expect((await fetch(s.url + "/api/consulta/mensagem", { method: "POST", body: f })).status).toBe(400);
  });

  it("anonimizar apaga o texto das mensagens do cliente e bloqueia novas", async () => {
    const p = await novaOcorrencia(s.url);
    await mensagem(p, "cliente@teste.local", "Meu endereço é Rua Secreta, 123.");
    const { id } = db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(p) as { id: number };
    anonimizar(id);
    const textos = (db.prepare("SELECT texto FROM eventos WHERE ocorrencia_id = ? AND do_cliente = 1").all(id) as { texto: string }[]).map((e) => e.texto);
    expect(textos).toEqual(["[conteúdo removido]"]);
    // E-mail apagado: a consulta já não encontra
    expect((await mensagem(p, "cliente@teste.local", "Ainda aí?")).status).toBe(404);
  });
});
