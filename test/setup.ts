import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cada arquivo de teste roda com um banco novo, sem e-mail, Telegram, Tiny ou Mercado Livre de verdade.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ocorrencias-teste-"));
Object.assign(process.env, {
  ADMIN_EMAIL: "gerente@teste.local",
  ADMIN_PASSWORD: "senha-forte-de-teste",
  ADMIN_NAME: "Gerente Teste",
  PUBLIC_URL: "http://localhost",
  SMTP_HOST: "",
  TELEGRAM_BOT_TOKEN: "",
  TINY_TOKEN: "",
  ML_CLIENT_ID: "",
  ML_CLIENT_SECRET: "",
  RESUMO_HORA: "-1",
});
