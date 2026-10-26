import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../src/app.js";
import { garantirPrimeiroGerente } from "../src/auth.js";

export interface Servidor {
  url: string;
  cookie: string;
  fechar: () => Promise<void>;
  /** Chamada ao painel já logado como gerente. */
  painel: (metodo: string, caminho: string, corpo?: unknown) => Promise<Response>;
}

export async function subir(): Promise<Servidor> {
  garantirPrimeiroGerente();
  const srv: Server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const login = await fetch(url + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, senha: process.env.ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error("login de teste falhou: " + (await login.text()));
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    url,
    cookie,
    fechar: () => new Promise((ok) => srv.close(() => ok())),
    painel: (metodo, caminho, corpo) =>
      fetch(url + "/api/admin" + caminho, {
        method: metodo,
        headers: { cookie, "content-type": "application/json", "x-requested-with": "painel" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      }),
  };
}

// Menor arquivo que passa na conferência de assinatura PNG
export const pngFalso = () => new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])], { type: "image/png" });

export async function novaOcorrencia(url: string, extra: Record<string, string> = {}): Promise<string> {
  const f = new FormData();
  const campos = {
    canal: "shopee", pedido: "PED-123", tipo: "defeito", descricao: "O produto chegou quebrado na caixa.",
    nome: "Cliente Teste", email: "cliente@teste.local", telefone: "", consentimento: "true", ...extra,
  };
  for (const [k, v] of Object.entries(campos)) f.append(k, v);
  const r = await fetch(url + "/api/ocorrencias", { method: "POST", body: f });
  if (r.status !== 201) throw new Error("falha ao criar ocorrência: " + (await r.text()));
  return ((await r.json()) as { protocolo: string }).protocolo;
}
