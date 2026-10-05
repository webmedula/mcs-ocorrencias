// Central de Ocorrências v1.0.5 — consulta de protocolo
(async function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (iso) => new Date(iso.replace(" ", "T") + "Z").toLocaleString("pt-BR");

  try {
    const cfg = await (await fetch("/api/config")).json();
    document.title = "Consultar protocolo — " + cfg.marca;
    $("#marca").textContent = cfg.marca;
    $("#rodape").textContent = cfg.marca + " · v" + cfg.versao;
  } catch {}

  const pre = new URLSearchParams(location.search).get("protocolo");
  if (pre) $("#protocolo").value = pre.slice(0, 40);

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
      const q = new URLSearchParams({ protocolo, email });
      const res = await fetch("/api/consulta?" + q);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { erro.textContent = j.erro || "Não foi possível consultar."; erro.classList.remove("oculto"); return; }
      const st = $("#status"); st.textContent = j.statusTexto; st.className = "status " + j.status;
      $("#r-protocolo").textContent = j.protocolo;
      $("#r-meta").textContent = `${j.canal} · ${j.tipo} · aberto em ${fmt(j.criadoEm)}`;
      const ul = $("#hist"); ul.replaceChildren();
      for (const h of j.historico) {
        const li = document.createElement("li");
        const t = document.createElement("time"); t.textContent = fmt(h.criado_em);
        li.append(t, document.createTextNode(h.texto)); ul.append(li);
      }
      $("#resultado").classList.remove("oculto");
    } catch {
      erro.textContent = "Sem conexão. Tente novamente."; erro.classList.remove("oculto");
    } finally { btn.disabled = false; btn.textContent = "Consultar"; }
  });
})();
