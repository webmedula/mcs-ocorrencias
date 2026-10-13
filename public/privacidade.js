// Central de Ocorrências v1.4.0 — preenche a política com os dados da empresa (/api/config)
(async function () {
  const $ = (s) => document.querySelector(s);
  try {
    const cfg = await (await fetch("/api/config")).json();
    document.title = "Política de privacidade — " + cfg.marca;
    $("#p-controlador").textContent = cfg.controlador || cfg.marca;
    if (cfg.cnpj) $("#p-cnpj").textContent = ", CNPJ " + cfg.cnpj;
    const a = $("#p-contato");
    const c = cfg.contatoPrivacidade || cfg.emailSuporte;
    if (c) { a.textContent = c; a.href = "mailto:" + c; } else { a.textContent = "nossos canais de atendimento"; a.removeAttribute("href"); }
    $("#p-retencao").textContent = cfg.retencaoMeses > 0
      ? `Guardamos a ocorrência enquanto ela estiver em andamento. Depois de resolvida, removemos os seus dados pessoais (nome, e-mail, telefone, relato e fotos) após ${cfg.retencaoMeses} meses, mantendo apenas números sem identificação para estatística. Podemos guardar por mais tempo o que a lei exigir ou o que for necessário para a nossa defesa em processos.`
      : "Guardamos a ocorrência enquanto ela estiver em andamento e depois pelo tempo necessário para cumprir obrigações legais e para a nossa defesa em eventuais processos. Se você pedir, anonimizamos ou excluímos os seus dados antes disso, salvo quando a lei nos obrigar a mantê-los.";
    $("#rodape").textContent = cfg.marca + " · v" + cfg.versao;
  } catch {}
})();
