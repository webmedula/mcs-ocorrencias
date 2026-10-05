// Central de Ocorrências v1.1.0 — formulário
(async function () {
  const $ = (s) => document.querySelector(s);
  const form = $("#form");
  const MAX_FOTOS = 5, MAX_BYTES = 5 * 1024 * 1024;
  const TIPOS_OK = ["image/jpeg", "image/png", "image/webp"];

  // ----- Configuração (marca, canais, assuntos) -----
  try {
    const cfg = await (await fetch("/api/config")).json();
    document.title = "Registrar ocorrência — " + cfg.marca;
    $("#marca").textContent = cfg.marca;
    $("#rodape").textContent = cfg.marca + " · v" + cfg.versao;
    if (cfg.emailSuporte) $("#suporte").textContent = "Dúvidas? " + cfg.emailSuporte;

    const canais = $("#canais");
    for (const [valor, nome] of Object.entries(cfg.canais)) {
      const l = document.createElement("label");
      l.className = "canal";
      const i = document.createElement("input");
      i.type = "radio"; i.name = "canal"; i.value = valor;
      const s = document.createElement("span"); s.textContent = nome;
      l.append(i, s); canais.append(l);
    }
    const sel = $("#tipo");
    for (const [valor, nome] of Object.entries(cfg.tipos)) {
      const o = document.createElement("option"); o.value = valor; o.textContent = nome; sel.append(o);
    }
    if (cfg.privacidadeUrl) {
      const a = $("#link-privacidade"); a.href = cfg.privacidadeUrl; a.classList.remove("oculto");
    }
    // Pré-seleção opcional via QR code: ?canal=shopee
    const qs = new URLSearchParams(location.search);
    const pre = qs.get("canal");
    if (pre && cfg.canais[pre]) form.querySelector(`input[name=canal][value="${pre}"]`).checked = true;
    if (qs.get("pedido")) $("#pedido").value = qs.get("pedido").slice(0, 60);
  } catch {
    $("#erro-geral").textContent = "Não foi possível carregar o formulário. Recarregue a página.";
    $("#erro-geral").classList.remove("oculto");
  }

  // ----- Prévia e validação das fotos -----
  $("#fotos").addEventListener("change", (e) => {
    const previa = $("#previa"); previa.replaceChildren();
    setErro("fotos", "");
    const files = [...e.target.files];
    if (files.length > MAX_FOTOS) { setErro("fotos", "Envie no máximo 5 fotos."); e.target.value = ""; return; }
    for (const f of files) {
      if (!TIPOS_OK.includes(f.type)) { setErro("fotos", "Use apenas JPG, PNG ou WebP."); e.target.value = ""; previa.replaceChildren(); return; }
      if (f.size > MAX_BYTES) { setErro("fotos", "Cada foto pode ter no máximo 5 MB."); e.target.value = ""; previa.replaceChildren(); return; }
      const img = document.createElement("img"); img.alt = "Prévia da foto"; img.src = URL.createObjectURL(f);
      img.onload = () => URL.revokeObjectURL(img.src); previa.append(img);
    }
  });

  function setErro(campo, msg) {
    const el = document.querySelector(`[data-erro="${campo}"]`);
    if (el) el.textContent = msg;
  }
  function limparErros() {
    document.querySelectorAll("[data-erro]").forEach((e) => (e.textContent = ""));
    $("#erro-geral").classList.add("oculto");
  }

  // ----- Validação local (a do servidor é a que vale) -----
  function validar() {
    const v = Object.fromEntries(new FormData(form));
    const e = {};
    if (!v.canal) e.canal = "Escolha onde você comprou.";
    if (!v.pedido || v.pedido.trim().length < 3) e.pedido = "Informe o número do pedido.";
    if (!v.tipo) e.tipo = "Escolha o assunto.";
    if (!v.descricao || v.descricao.trim().length < 10) e.descricao = "Descreva o problema com mais detalhes.";
    if (!v.nome || v.nome.trim().length < 2) e.nome = "Informe seu nome.";
    if (!/^\S+@\S+\.\S+$/.test(v.email || "")) e.email = "Informe um e-mail válido.";
    if (!v.consentimento) e.consentimento = "É necessário aceitar o uso dos dados.";
    return e;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    limparErros();
    const erros = validar();
    if (Object.keys(erros).length) {
      for (const [c, m] of Object.entries(erros)) setErro(c, m);
      const primeiro = document.querySelector("[data-erro]:not(:empty)");
      primeiro && primeiro.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const btn = $("#enviar"); btn.disabled = true; btn.textContent = "Enviando…";
    try {
      const res = await fetch("/api/ocorrencias", { method: "POST", body: new FormData(form) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.campos) for (const [c, m] of Object.entries(json.campos)) setErro(c, m);
        $("#erro-geral").textContent = json.erro || "Não foi possível enviar. Tente novamente.";
        $("#erro-geral").classList.remove("oculto");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      $("#protocolo").textContent = json.protocolo;
      $("#ver-status").href = "consulta.html?protocolo=" + encodeURIComponent(json.protocolo);
      $("#tela-form").classList.add("oculto");
      document.title = "Ocorrência registrada — " + $("#marca").textContent;
      $("#tela-ok").classList.remove("oculto");
      window.scrollTo({ top: 0 });
    } catch {
      $("#erro-geral").textContent = "Sem conexão. Verifique sua internet e tente de novo.";
      $("#erro-geral").classList.remove("oculto");
    } finally {
      btn.disabled = false; btn.textContent = "Enviar ocorrência";
    }
  });

  $("#copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#protocolo").textContent); $("#copiar").textContent = "Copiado!"; }
    catch { $("#copiar").textContent = "Selecione e copie o número acima"; }
  });
})();
