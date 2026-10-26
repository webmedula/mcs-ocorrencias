// Central de Ocorrências v1.6.0 — consulta de protocolo e mensagem do cliente
(async function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (iso) => new Date(iso.replace(" ", "T") + "Z").toLocaleString("pt-BR");
  const MAX_FOTOS = 5, MAX_BYTES = 5 * 1024 * 1024, TIPOS_OK = ["image/jpeg", "image/png", "image/webp"];
  const mostrar = (el, sim) => el.classList.toggle("oculto", !sim);
  const atual = { protocolo: "", email: "" };

  try {
    const cfg = await (await fetch("/api/config")).json();
    document.title = "Consultar protocolo — " + cfg.marca;
    $("#marca").textContent = cfg.marca;
    $("#rodape").textContent = cfg.marca + " · v" + cfg.versao;
    if (cfg.privacidadeUrl) for (const l of document.querySelectorAll(".link-rodape")) l.href = cfg.privacidadeUrl;
    if (cfg.emailSuporte) $("#suporte").textContent = "Dúvidas? " + cfg.emailSuporte;
  } catch {}

  const pre = new URLSearchParams(location.search).get("protocolo");
  if (pre) $("#protocolo").value = pre.slice(0, 40);

  function render(j) {
    const st = $("#status"); st.textContent = j.statusTexto; st.className = "status " + j.status;
    $("#r-protocolo").textContent = j.protocolo;
    $("#r-meta").textContent = `${j.canal} · ${j.tipo} · aberto em ${fmt(j.criadoEm)}`;
    const ul = $("#hist"); ul.replaceChildren();
    for (const h of j.historico) {
      const li = document.createElement("li");
      if (h.cliente) li.className = "cliente";
      const t = document.createElement("time"); t.textContent = fmt(h.criado_em) + (h.cliente ? " · você" : "");
      const p = document.createElement("span"); p.className = "texto"; p.textContent = h.texto;
      li.append(t, p); ul.append(li);
    }
    mostrar($("#f-msg"), Boolean(j.podeResponder));
    $("#resultado").classList.remove("oculto");
  }

  async function consultar() {
    const res = await fetch("/api/consulta?" + new URLSearchParams(atual));
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, j };
  }

  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $("#erro-geral"); erro.classList.add("oculto");
    $("#resultado").classList.add("oculto");
    const protocolo = $("#protocolo").value.trim(), email = $("#email").value.trim();
    if (!protocolo || !email) {
      erro.textContent = "Preencha o protocolo e o e-mail."; erro.classList.remove("oculto"); return;
    }
    const btn = $("#buscar"); btn.disabled = true; btn.textContent = "Consultando…";
    try {
      atual.protocolo = protocolo; atual.email = email;
      const { ok, j } = await consultar();
      if (!ok) { erro.textContent = j.erro || "Não foi possível consultar."; erro.classList.remove("oculto"); return; }
      mostrar($("#msg-ok"), false);
      render(j);
    } catch {
      erro.textContent = "Sem conexão. Tente novamente."; erro.classList.remove("oculto");
    } finally { btn.disabled = false; btn.textContent = "Consultar"; }
  });

  // ----- Mensagem do cliente -----
  const erroMsg = (m) => { $("#msg-erro").textContent = m || ""; mostrar($("#msg-erro"), Boolean(m)); };
  $("#msg-fotos").addEventListener("change", (e) => {
    const previa = $("#msg-previa"); previa.replaceChildren(); erroMsg("");
    const files = [...e.target.files];
    if (files.length > MAX_FOTOS) { erroMsg("Envie no máximo 5 fotos por mensagem."); e.target.value = ""; return; }
    for (const f of files) {
      if (!TIPOS_OK.includes(f.type)) { erroMsg("Use apenas fotos JPG, PNG ou WebP."); e.target.value = ""; previa.replaceChildren(); return; }
      if (f.size > MAX_BYTES) { erroMsg("Cada foto pode ter no máximo 5 MB."); e.target.value = ""; previa.replaceChildren(); return; }
      const img = document.createElement("img"); img.alt = "Prévia da foto"; img.src = URL.createObjectURL(f);
      previa.append(img);
    }
  });

  $("#f-msg").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroMsg(""); mostrar($("#msg-ok"), false);
    const texto = $("#msg-texto").value.trim();
    if (texto.length < 2) { erroMsg("Escreva a sua mensagem."); return; }
    const dados = new FormData();
    dados.append("protocolo", atual.protocolo); dados.append("email", atual.email); dados.append("texto", texto);
    for (const f of $("#msg-fotos").files) dados.append("fotos", f);
    const btn = $("#msg-enviar"); btn.disabled = true; btn.textContent = "Enviando…";
    try {
      const res = await fetch("/api/consulta/mensagem", { method: "POST", body: dados });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { erroMsg(j.erro || "Não foi possível enviar."); return; }
      $("#msg-texto").value = ""; $("#msg-fotos").value = ""; $("#msg-previa").replaceChildren();
      const r = await consultar();
      if (r.ok) render(r.j);
      $("#msg-ok").textContent = "Mensagem enviada. Nossa equipe vai responder por e-mail e aqui nesta página.";
      mostrar($("#msg-ok"), true);
    } catch {
      erroMsg("Sem conexão. Tente novamente.");
    } finally { btn.disabled = false; btn.textContent = "Enviar mensagem"; }
  });
})();
