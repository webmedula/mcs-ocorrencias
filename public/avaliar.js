// Central de Ocorrências v1.6.0 — pesquisa de satisfação
(async function () {
  const $ = (s) => document.querySelector(s);
  const mostrar = (el, sim) => el.classList.toggle("oculto", !sim);
  const ROTULOS = ["Muito ruim", "Ruim", "Regular", "Bom", "Ótimo"];
  const params = new URLSearchParams(location.search);
  const token = params.get("t") || "";
  let nota = Number(params.get("nota")) || 0;
  // Tira o token da barra de endereço (não fica no histórico nem é compartilhado sem querer)
  history.replaceState(null, "", location.pathname);

  const erro = (m) => { $("#erro-geral").textContent = m; mostrar($("#erro-geral"), true); };
  try {
    const cfg = await (await fetch("/api/config")).json();
    document.title = "Avaliar atendimento — " + cfg.marca;
    $("#rodape").textContent = cfg.marca + " · v" + cfg.versao;
    if (cfg.privacidadeUrl) for (const l of document.querySelectorAll(".link-rodape")) l.href = cfg.privacidadeUrl;
  } catch {}

  async function enviar(corpo) {
    const res = await fetch("/api/avaliacao", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token, ...corpo }) });
    return { ok: res.ok, j: await res.json().catch(() => ({})) };
  }

  function marcar(n) {
    nota = n;
    for (const b of document.querySelectorAll("#notas button")) b.setAttribute("aria-pressed", String(Number(b.dataset.n) === n));
  }

  let dados;
  try {
    const res = await fetch("/api/avaliacao?" + new URLSearchParams({ t: token }));
    dados = await res.json().catch(() => ({}));
    if (!res.ok) { erro(dados.erro || "Este link de avaliação não é válido."); return; }
  } catch { erro("Sem conexão. Tente novamente."); return; }

  $("#protocolo").textContent = "Atendimento " + dados.protocolo;
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.n = String(n); b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `${n} de 5: ${ROTULOS[n - 1]}`);
    b.append(String(n), Object.assign(document.createElement("small"), { textContent: ROTULOS[n - 1] }));
    b.addEventListener("click", async () => {
      marcar(n);
      const r = await enviar({ nota: n });
      if (r.ok) { $("#ok").textContent = "Nota registrada. Obrigado! Se quiser, deixe um comentário abaixo."; mostrar($("#ok"), true); }
    });
    $("#notas").append(b);
  }
  $("#comentario").value = dados.comentario || "";
  mostrar($("#form"), true);

  // A nota escolhida no e-mail já é registrada ao abrir a página
  if (nota >= 1 && nota <= 5) {
    marcar(nota);
    const r = await enviar({ nota });
    if (r.ok) { $("#ok").textContent = "Nota registrada. Obrigado! Se quiser, deixe um comentário abaixo."; mostrar($("#ok"), true); }
  } else if (dados.nota) marcar(dados.nota);

  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    mostrar($("#erro-geral"), false);
    if (!nota) { erro("Escolha uma nota de 1 a 5."); return; }
    const btn = $("#enviar"); btn.disabled = true;
    const r = await enviar({ nota, comentario: $("#comentario").value });
    btn.disabled = false;
    if (!r.ok) { erro(r.j.erro || "Não foi possível enviar."); return; }
    $("#ok").textContent = "Avaliação enviada. Muito obrigado!"; mostrar($("#ok"), true);
  });
})();
