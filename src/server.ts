import { config } from "./config.js";
import { app } from "./app.js";
import { iniciarSincronizacaoML } from "./ml.js";
import { iniciarRotinas } from "./rotinas.js";
import { garantirPrimeiroGerente, limparSessoesVencidas } from "./auth.js";
import { verificarSmtp } from "./notify.js";

garantirPrimeiroGerente();
iniciarSincronizacaoML();
iniciarRotinas();
limparSessoesVencidas();
setInterval(limparSessoesVencidas, 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  verificarSmtp();
  console.log(`Central de Ocorrências v${config.version} em http://localhost:${config.port}`);
  console.log(
    `Tiny: ${config.tinyToken ? "on" : "off"} · Telegram: ${config.telegramToken ? "on" : "off"} · SMTP: ${config.smtpHost ? "on" : "off"}`,
  );
});
