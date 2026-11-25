import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { novaOcorrencia, subir, type Servidor } from "./ajuda.js";

// v1.11.0: perfil Atendimento vê a própria fila; as outras ocorrências só pela busca
let s: Servidor;
let bia = 0;
let cookieBia = "";
beforeAll(async () => {
  s = await subir();
  const r = await s.painel("POST", "/usuarios", { nome: "Bia Fila", email: "bia@equipe.local", senha: "senha-forte-da-bia", papel: "atendimento" });
  bia = (await r.json()).id;
  const login = await fetch(s.url + "/api/admin/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bia@equipe.local", senha: "senha-forte-da-bia" }),
  });
  cookieBia = (login.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => { await s.fechar(); });

const comoBia = (caminho: string) =>
  fetch(s.url + "/api/admin" + caminho, { headers: { cookie: cookieBia, "x-requested-with": "painel" } });
const protocolos = async (r: Response) => (await r.json()).itens.map((i: any) => i.protocolo);

describe("fila do perfil Atendimento", () => {
  it("sem busca, vê só os casos da própria fila", async () => {
    const daBia = await novaOcorrencia(s.url, { pedido: "FILA-111" });
    const outra = await novaOcorrencia(s.url, { pedido: "FILA-222" });
    await s.painel("PATCH", `/ocorrencias/${daBia}/responsavel`, { usuarioId: bia });
    const r = await comoBia("/ocorrencias");
    const lista = await protocolos(r);
    expect(lista).toContain(daBia);
    expect(lista).not.toContain(outra);
    // mesmo pedindo "todas as filas", continua só na dela
    expect(await protocolos(await comoBia("/ocorrencias?responsavel="))).not.toContain(outra);
    // o gerente continua vendo tudo
    expect(await protocolos(await s.painel("GET", "/ocorrencias"))).toContain(outra);
  });

  it("pela busca acha qualquer caso: protocolo, pedido, comprador ou rastreio", async () => {
    const p = await novaOcorrencia(s.url, { pedido: "BUSCA-987", nome: "Comprador Achado" });
    expect(await protocolos(await comoBia("/ocorrencias?q=" + p))).toEqual([p]);
    expect(await protocolos(await comoBia("/ocorrencias?q=BUSCA-987"))).toEqual([p]);
    expect(await protocolos(await comoBia("/ocorrencias?q=Comprador%20Achado"))).toEqual([p]);
    const id = (db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(p) as { id: number }).id;
    db.prepare("INSERT INTO devolucoes (ocorrencia_id, status, rastreio) VALUES (?, 'em_transito', 'RASTRO123XYZ')").run(id);
    expect(await protocolos(await comoBia("/ocorrencias?q=RASTRO123"))).toEqual([p]);
    // v1.17.0: pelos códigos do ML que vêm na etiqueta do pacote de devolução
    const p2 = await novaOcorrencia(s.url, { pedido: "BUSCA-555" });
    const id2 = (db.prepare("SELECT id FROM ocorrencias WHERE protocolo = ?").get(p2) as { id: number }).id;
    db.prepare("UPDATE ocorrencias SET ml_claim_id = '5300000001' WHERE id = ?").run(id2);
    db.prepare("INSERT INTO devolucoes (ocorrencia_id, status, envio_id, return_id) VALUES (?, 'em_transito', '44100000001', '22000000001')").run(id2);
    for (const cod of ["44100000001", "22000000001", "5300000001"]) {
      expect(await protocolos(await comoBia("/ocorrencias?q=" + cod)), cod).toEqual([p2]);
      const dev = await (await comoBia("/devolucoes?q=" + cod)).json();
      expect(dev.itens.map((i: any) => i.protocolo), "devolucoes " + cod).toEqual([p2]);
    }
    // e abre o caso para tratar
    expect((await comoBia(`/ocorrencias/${p}`)).status).toBe(200);
  });

  it("não vê números nem a conta da venda", async () => {
    expect((await comoBia("/estatisticas")).status).toBe(403);
    expect((await s.painel("GET", "/estatisticas")).status).toBe(200);
  });
});
