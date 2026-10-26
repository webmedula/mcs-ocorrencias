import { describe, expect, it } from "vitest";
import { celula, dataLocal, gerarCsv, reais } from "../src/csv.js";
import { gerarProtocolo } from "../src/protocol.js";

describe("csv", () => {
  it("escapa ponto e vírgula, aspas e quebras de linha", () => {
    expect(celula("simples")).toBe("simples");
    expect(celula("a;b")).toBe('"a;b"');
    expect(celula('diz "oi"')).toBe('"diz ""oi"""');
    expect(celula("linha\nnova")).toBe('"linha\nnova"');
    expect(celula(null)).toBe("");
    expect(celula(42)).toBe("42");
  });

  it("neutraliza fórmulas (injeção de CSV)", () => {
    expect(celula("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(celula("+5511999")).toBe("'+5511999");
    expect(celula("@soma")).toBe("'@soma");
  });

  it("gera arquivo com BOM, cabeçalho e CRLF", () => {
    const csv = gerarCsv(["A", "B"], [[1, "x"]]);
    expect(csv.startsWith("﻿A;B\r\n1;x\r\n")).toBe(true);
  });

  it("formata valores e datas", () => {
    expect(reais(4990)).toBe("49,90");
    expect(reais(null)).toBe("");
    expect(dataLocal("2026-10-26 13:05:00")).toBe("26/10/2026 10:05");
    expect(dataLocal(null)).toBe("");
  });
});

describe("protocolo", () => {
  it("segue o formato PREFIXO-AAAAMMDD-XXXXXX sem caracteres ambíguos", () => {
    for (let i = 0; i < 50; i++) expect(gerarProtocolo()).toMatch(/^MCS-\d{8}-[A-HJ-KMNP-Z2-9]{6}$/);
  });
});
