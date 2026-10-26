import { config } from "./config.js";

/** CSV no formato que o Excel em português abre direto: separador ";", BOM UTF-8 e quebra CRLF. */

export function celula(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Evita que o Excel interprete o texto como fórmula (injeção de CSV)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function gerarCsv(cabecalho: string[], linhas: unknown[][]): string {
  return "﻿" + [cabecalho, ...linhas].map((l) => l.map(celula).join(";")).join("\r\n") + "\r\n";
}

/** "2026-10-26 13:05:00" (UTC, como o SQLite grava) → "26/10/2026 10:05" no fuso local. */
export function dataLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: config.timezone, dateStyle: "short", timeStyle: "short" }).format(d).replace(",", "");
}

/** Centavos → "1234,50" (vírgula decimal, sem símbolo, para somar no Excel). */
export const reais = (centavos: number | null | undefined) => (centavos == null ? "" : (centavos / 100).toFixed(2).replace(".", ","));
