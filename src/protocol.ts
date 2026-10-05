import crypto from "node:crypto";
import { config } from "./config.js";

// Alfabeto sem caracteres ambíguos (0/O, 1/I/L)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function gerarProtocolo(): string {
  const d = new Date();
  const data =
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  let sufixo = "";
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) sufixo += ALPHABET[b % ALPHABET.length];
  return `${config.protocolPrefix}-${data}-${sufixo}`;
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(config.ipSalt + ip).digest("hex").slice(0, 24);
}
