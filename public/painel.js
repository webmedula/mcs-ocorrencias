// Central de Ocorrências v1.2.0 — painel interno
(function () {
  const $ = (s) => document.querySelector(s);
  const STATUS_INT = { nova: "Nova", em_analise: "Em análise", aguardando_cliente: "Aguardando cliente", resolvida: "Resolvida" };
  const PAPEL = { gerente: "Gerente", atendimento: "Atendimento" };

  const estado = { eu: null, meta: null, filtro: { q: "", canal: "", status: "", origem: "", pagina: 1 }, aberto: null, aba: "ocorrencias", msgResp: "" };

  // ---------- utilidades ----------
  function h(tag, attrs, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const f of filhos.flat(Infinity)) if (f != null && f !== false) el.append(f.nodeType ? f : document.createTextNode(String(f)));
    return el;
  }
  const fmt = (iso) => (iso ? new Date(iso.replace(" ", "T") + "Z").toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
  const mostrar = (el, sim) => el.classList.toggle("oculto", !sim);
  const erroEm = (el, msg) => { el.textContent = msg || ""; mostrar(el, Boolean(msg)); };

  async function api(metodo, caminho, corpo) {
    const res = await fetch("/api/admin" + caminho, {
      method: metodo,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "painel" },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && caminho !== "/login") { mostrarLogin(); }
    return { ok: res.ok, status: res.status, json };
  }

  // ---------- navegação ----------
  function mostrarLogin() {
    estado.eu = null;
    mostrar($("#menu"), false);
    for (const v of ["ocorrencias", "equipe", "conta"]) mostrar($("#v-" + v), false);
    mostrar($("#v-login"), true);
    $("#l-senha").value = "";
    $("#l-email").focus();
  }

  function entrar(eu) {
    estado.eu = eu;
    mostrar($("#v-login"), false);
    mostrar($("#menu"), true);
    mostrar($("#aba-equipe"), eu.papel === "gerente");
    $("#quem").textContent = `${eu.nome} · ${PAPEL[eu.papel] || ""}`;
    const qml = new URLSearchParams(location.search).get("ml");
    if (qml && eu.papel === "gerente") {
      history.replaceState(null, "", location.pathname + location.hash);
      abrirAba("equipe");
      const av = $("#ml-aviso");
      av.textContent = qml === "ok" ? "Mercado Livre conectado! As reclamações abertas estão sendo importadas." : "Não foi possível conectar ao Mercado Livre. Tente de novo.";
      mostrar(av, true);
      return;
    }
    abrirAba("ocorrencias");
  }

  function abrirAba(nome) {
    estado.aba = nome;
    for (const b of document.querySelectorAll(".aba")) b.classList.toggle("ativa", b.dataset.aba === nome);
    for (const v of ["ocorrencias", "equipe", "conta"]) mostrar($("#v-" + v), v === nome);
    if (nome === "ocorrencias") { carregarLista().then(() => abrirDoHash()); }
    if (nome === "equipe") carregarEquipe();
  }

  // ---------- ocorrências ----------
  async function carregarLista() {
    const f = estado.filtro;
    const q = new URLSearchParams({ q: f.q, canal: f.canal, status: f.status, origem: f.origem, pagina: String(f.pagina) });
    const r = await api("GET", "/ocorrencias?" + q);
    if (!r.ok) return;
    const d = r.json;
    if (!estado.meta) montarFiltros(d);
    estado.meta = d;
    renderKpis(d.contagem);
    const corpo = $("#linhas");
    corpo.replaceChildren();
    for (const o of d.itens) {
      const tr = h("tr", { class: "item-oc" + (o.protocolo === estado.aberto ? " sel" : ""), tabindex: "0", "data-p": o.protocolo, role: "button", "aria-label": `Abrir ${o.protocolo}` },
        h("td", {}, h("strong", {}, o.protocolo, o.origem === "ml" ? h("span", { class: "sel-ml" }, "ML") : null), h("small", {}, `${o.nome} · ${fmt(o.criado_em)}`), prazoEl(o), h("small", { class: "so-m" }, `${d.canais[o.canal] || o.canal} · ${d.tipos[o.tipo] || o.tipo}`)),
        h("td", { class: "col-m" }, d.canais[o.canal] || o.canal),
        h("td", { class: "col-m" }, d.tipos[o.tipo] || o.tipo),
        h("td", {}, h("span", { class: "etiqueta " + o.status }, STATUS_INT[o.status] || o.status)),
      );
      const abrir = () => selecionar(o.protocolo);
      tr.addEventListener("click", abrir);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrir(); } });
      corpo.append(tr);
    }
    mostrar($("#vazio"), d.itens.length === 0);
    const paginas = Math.max(1, Math.ceil(d.total / d.porPagina));
    $("#p-info").textContent = `${d.total} ocorrência${d.total === 1 ? "" : "s"} · página ${d.pagina} de ${paginas}`;
    $("#p-ant").disabled = d.pagina <= 1;
    $("#p-prox").disabled = d.pagina >= paginas;
  }

  // Prazo do Mercado Livre: vermelho quando falta menos de 24 h
  function prazoEl(o) {
    if (o.origem !== "ml" || !o.prazo_em || o.status === "resolvida") return null;
    const t = new Date(o.prazo_em.replace(" ", "T") + (o.prazo_em.includes("Z") ? "" : "Z")).getTime();
    if (Number.isNaN(t)) return null;
    const falta = t - Date.now();
    const urgente = falta < 24 * 3600 * 1000;
    return h("small", { class: "prazo" + (urgente ? " urgente" : "") }, falta < 0 ? "Prazo vencido" : `Responder até ${fmt(o.prazo_em)}`);
  }

  function montarFiltros(d) {
    for (const [k, v] of Object.entries(d.canais)) $("#f-canal").append(h("option", { value: k }, v));
    for (const k of Object.keys(d.status)) $("#f-status").append(h("option", { value: k }, STATUS_INT[k] || k));
  }

  function renderKpis(contagem) {
    const box = $("#kpis");
    box.replaceChildren();
    for (const k of ["nova", "em_analise", "aguardando_cliente", "resolvida"]) {
      const b = h("button", { type: "button", class: `kpi ${k}${estado.filtro.status === k ? " sel" : ""}`, "aria-pressed": String(estado.filtro.status === k) },
        STATUS_INT[k], h("b", {}, String(contagem[k] ?? 0)));
      b.addEventListener("click", () => {
        estado.filtro.status = estado.filtro.status === k ? "" : k;
        estado.filtro.pagina = 1;
        $("#f-status").value = estado.filtro.status;
        carregarLista();
      });
      box.append(b);
    }
  }

  function abrirDoHash() {
    const p = decodeURIComponent(location.hash.slice(1));
    if (p && /^[A-Za-z0-9-]{6,40}$/.test(p) && p !== estado.aberto) selecionar(p, false);
  }

  async function selecionar(protocolo, rolar = true) {
    estado.aberto = protocolo;
    history.replaceState(null, "", "#" + encodeURIComponent(protocolo));
    for (const tr of document.querySelectorAll("#linhas tr")) tr.classList.toggle("sel", tr.dataset.p === protocolo);
    const r = await api("GET", "/ocorrencias/" + encodeURIComponent(protocolo));
    const box = $("#detalhe");
    box.replaceChildren();
    if (!r.ok) { box.append(h("p", { class: "vazio" }, r.json.erro || "Não foi possível abrir.")); return; }
    renderDetalhe(box, r.json);
    if (rolar && window.matchMedia("(max-width: 1100px)").matches) { box.scrollIntoView({ behavior: "smooth", block: "start" }); box.focus({ preventScroll: true }); }
  }

  function renderDetalhe(box, o) {
    const m = estado.meta;
    const tiny = o.tiny_status === "encontrado" && o.tiny
      ? h("div", { class: "faixa ok" }, h("span", {}, h("strong", {}, `Pedido #${o.tiny.numero} no Tiny. `), `${o.tiny.situacao} · R$ ${o.tiny.valor} · ${o.tiny.cliente}`))
      : o.tiny_status === "nao_encontrado" ? h("div", { class: "faixa aviso-f" }, "Pedido não encontrado no Tiny. Confira o número com o cliente.")
      : o.tiny_status === "erro" ? h("div", { class: "faixa aviso-f" }, "Falha ao consultar o Tiny no momento do registro.")
      : h("div", { class: "faixa neutro" }, "Integração com o Tiny desligada.");

    const seletor = h("select", { id: "d-status", "aria-label": "Mudar status" },
      Object.keys(m.status).map((k) => h("option", { value: k, selected: k === o.status }, STATUS_INT[k] || k)));
    const msgStatus = h("p", { class: "msg-ok oculto", role: "status" });
    seletor.addEventListener("change", async () => {
      seletor.disabled = true;
      const r = await api("PATCH", `/ocorrencias/${encodeURIComponent(o.protocolo)}/status`, { status: seletor.value });
      if (r.ok) { await selecionar(o.protocolo, false); await carregarLista(); }
      else { seletor.disabled = false; msgStatus.textContent = r.json.erro || "Não foi possível mudar o status."; mostrar(msgStatus, true); }
    });

    const fotos = o.anexos.length
      ? h("div", { class: "fotos-p" }, o.anexos.map((a) =>
          h("a", { href: `/api/admin/anexos/${a.id}`, target: "_blank", rel: "noopener", "aria-label": `Abrir foto ${a.original}` },
            h("img", { src: `/api/admin/anexos/${a.id}`, alt: `Foto enviada pelo cliente: ${a.original}`, loading: "lazy", width: "84", height: "84" }))))
      : h("p", { class: "aviso" }, "O cliente não enviou fotos.");

    const hist = h("ul", { class: "hist-p" }, [...o.eventos].reverse().map((e) => {
      const interna = !e.publico;
      const doCliente = !e.autor;
      const rotulo = interna ? ["Nota interna", ""] : doCliente ? ["Sistema", "sis"] : ["Cliente vê", "pub"];
      return h("li", {},
        h("span", { class: "tipo " + rotulo[1] }, rotulo[0]), e.texto,
        h("div", {}, h("time", {}, fmt(e.criado_em)), e.autor ? h("span", { class: "autor" }, ` · ${e.autor}`) : null));
    }));

    const notaTxt = h("textarea", { id: "d-nota", rows: "2", maxlength: "3000" });
    const notaMsg = h("p", { class: "msg-ok oculto", role: "status" });
    const formNota = h("form", { class: "acao nota-int", novalidate: true },
      h("label", { for: "d-nota" }, "Nota interna ", h("span", { class: "dica" }, "(só a equipe vê)")), notaTxt, notaMsg,
      h("button", { type: "submit", class: "sec mini" }, "Salvar nota"));
    formNota.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (notaTxt.value.trim().length < 2) return;
      const r = await api("POST", `/ocorrencias/${encodeURIComponent(o.protocolo)}/notas`, { texto: notaTxt.value });
      if (r.ok) { await selecionar(o.protocolo, false); } else { notaMsg.textContent = r.json.erro || "Não foi possível salvar."; mostrar(notaMsg, true); }
    });

    const ehMl = o.origem === "ml" && o.ml;
    const respTxt = h("textarea", { id: "d-resp", rows: "3", maxlength: "3000" });
    const respMsg = h("p", { class: "msg-ok oculto", role: "status" });
    if (estado.msgResp && !ehMl) { respMsg.textContent = estado.msgResp; mostrar(respMsg, true); estado.msgResp = ""; }
    const formResp = h("form", { class: "acao", novalidate: true },
      h("label", { for: "d-resp" }, "Resposta ao cliente ", h("span", { class: "dica" }, "(vai por e-mail e aparece na consulta)")), respTxt, respMsg,
      h("button", { type: "submit", class: "mini" }, "Enviar resposta"));
    formResp.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (respTxt.value.trim().length < 2) return;
      const btn = formResp.querySelector("button"); btn.disabled = true;
      const r = await api("POST", `/ocorrencias/${encodeURIComponent(o.protocolo)}/resposta`, { texto: respTxt.value });
      btn.disabled = false;
      if (r.ok) {
        const aviso = r.json.emailEnviado ? "" : " (o e-mail não pôde ser enviado; a resposta aparece na consulta do cliente)";
        estado.msgResp = "Resposta registrada" + aviso + ".";
        await selecionar(o.protocolo, false);
      } else { respMsg.textContent = r.json.erro || "Não foi possível enviar."; mostrar(respMsg, true); }
    });

    box.append(
      h("div", { class: "cab" }, h("h2", {}, o.protocolo), h("span", { class: "etiqueta " + o.status }, STATUS_INT[o.status] || o.status)),
      h("p", { class: "meta" }, `${m.canais[o.canal] || o.canal} · pedido ${o.pedido} · ${m.tipos[o.tipo] || o.tipo}`),
      ehMl
        ? h("p", { class: "meta" }, `Comprador ${o.nome} (o Mercado Livre não informa o e-mail) · aberta em ${fmt(o.criado_em)}`)
        : h("p", { class: "meta" }, `${o.nome} · `, h("a", { href: "mailto:" + o.email }, o.email), o.telefone ? ` · ${o.telefone}` : "", ` · aberta em ${fmt(o.criado_em)}`),
      ...(ehMl ? [blocoMl(o)] : []),
      tiny,
      h("h3", {}, ehMl ? "Descrição" : "Relato do cliente"), h("p", { class: "relato" }, o.descricao),
      ...(ehMl ? [] : [h("h3", {}, `Fotos (${o.anexos.length})`), fotos]),
      h("div", { class: "acao" }, h("label", { for: "d-status" }, "Mudar status"), seletor, msgStatus),
      formNota, ehMl ? formMl(o) : formResp,
      h("h3", {}, "Histórico"), hist,
    );
  }

  const ROTULO_REM = { complainant: "Comprador", respondent: "Vendedor", mediator: "Mediador do ML" };
  const TIPO_CLAIM = { mediations: "Mediação", returns: "Devolução", cancel_purchase: "Cancelamento", fulfillment: "Fulfillment" };
  const ACAO = { send_message_to_complainant: "Responder o comprador", send_message_to_mediator: "Responder o mediador", refund: "Reembolsar", allow_return: "Autorizar devolução" };

  function blocoMl(o) {
    const c = o.ml.claim || {};
    const linhas = [
      ["Reclamação", c.id], ["Tipo", TIPO_CLAIM[c.type] || c.type], ["Etapa", c.stage === "dispute" ? "Em disputa (mediação do ML)" : c.stage === "claim" ? "Reclamação (você pode resolver)" : c.stage],
      ["Motivo", c.motivo || c.reason_id], ["Situação", c.status === "closed" ? "Encerrada" : "Aberta"],
      ["Prazo", o.prazo_em ? fmt(o.prazo_em) : null],
    ].filter((x) => x[1]);
    const acoes = (c.acoes || []).map((a) => ACAO[a.action] || a.action);
    return h("div", { class: "faixa ml-info" },
      h("dl", {}, linhas.map(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))])),
      acoes.length ? h("p", { class: "aviso" }, "Ações disponíveis no ML: " + acoes.join(", ") + ".") : null);
  }

  function formMl(o) {
    const msgs = o.ml.mensagens || [];
    const conversa = msgs.length
      ? h("ul", { class: "conversa" }, msgs.map((m) =>
          h("li", { class: "bolha " + (m.remetente === "respondent" ? "nos" : m.remetente === "complainant" ? "comprador" : "mediador") },
            h("span", { class: "quem-msg" }, (ROTULO_REM[m.remetente] || m.remetente) + (m.autor ? ` (${m.autor})` : "")),
            h("p", {}, m.texto + (m.anexos ? ` [${m.anexos} anexo(s) — veja no Mercado Livre]` : "")),
            h("time", {}, fmt(m.data)))))
      : h("p", { class: "aviso" }, "Ainda não há mensagens nesta reclamação.");
    const caixa = h("div", {}, h("h3", {}, "Conversa no Mercado Livre"), conversa);
    if (o.ml.encerrada) { caixa.append(h("p", { class: "aviso" }, "Reclamação encerrada: não é possível enviar novas mensagens.")); return caixa; }
    const para = o.ml.destinatario === "mediator" ? "ao mediador do Mercado Livre" : "ao comprador";
    const txt = h("textarea", { id: "d-ml", rows: "4", maxlength: "2000" });
    const msg = h("p", { class: "msg-ok oculto", role: "status" });
    if (estado.msgResp) { msg.textContent = estado.msgResp; mostrar(msg, true); estado.msgResp = ""; }
    const f = h("form", { class: "acao", novalidate: true },
      h("label", { for: "d-ml" }, "Mensagem ", h("span", { class: "dica" }, `(vai ${para}, direto no Mercado Livre; até 2000 caracteres)`)), txt, msg,
      h("button", { type: "submit", class: "mini" }, "Enviar no Mercado Livre"));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (txt.value.trim().length < 2) return;
      const btn = f.querySelector("button"); btn.disabled = true;
      const r = await api("POST", `/ocorrencias/${encodeURIComponent(o.protocolo)}/ml/mensagem`, { texto: txt.value });
      btn.disabled = false;
      if (r.ok) { estado.msgResp = "Mensagem enviada no Mercado Livre."; await selecionar(o.protocolo, false); await carregarLista(); }
      else { msg.textContent = r.json.erro || "Não foi possível enviar."; mostrar(msg, true); }
    });
    caixa.append(f);
    return caixa;
  }

  // ---------- Mercado Livre (equipe) ----------
  async function carregarMl() {
    const r = await api("GET", "/ml/status");
    const est = $("#ml-estado"), ac = $("#ml-acoes");
    est.replaceChildren(); ac.replaceChildren();
    if (!r.ok) { est.append(h("p", { class: "aviso" }, r.json.erro || "Não foi possível ler o status.")); return; }
    const s = r.json;
    if (!s.configurado) {
      est.append(h("p", { class: "aviso" }, "Falta definir ML_CLIENT_ID e ML_CLIENT_SECRET nas variáveis do Easypanel."));
      return;
    }
    if (!s.conectado) {
      est.append(h("p", {}, "Não conectado."), h("p", { class: "aviso" }, `Na aplicação do Mercado Livre, a URL de redirecionamento deve incluir: ${s.redirectUri}`));
    } else {
      est.append(h("p", {}, h("strong", {}, "Conectado"), ` como ${s.nickname || s.userId}`, ` desde ${fmt(s.conectadoEm)}`),
        h("p", { class: "aviso" }, `Última verificação: ${s.ultimaSync ? fmt(s.ultimaSync) : "ainda não"} · a cada ${s.intervaloMin} min`));
      if (s.ultimoErro) est.append(h("p", { class: "erro-geral" }, "Último erro: " + s.ultimoErro));
    }
    const conectar = h("button", { type: "button", class: s.conectado ? "sec mini" : "primario" }, s.conectado ? "Reconectar" : "Conectar ao Mercado Livre");
    conectar.addEventListener("click", async () => {
      conectar.disabled = true;
      const c = await api("POST", "/ml/conectar");
      if (c.ok && c.json.url) window.location.assign(c.json.url);
      else { conectar.disabled = false; est.append(h("p", { class: "erro-geral" }, c.json.erro || "Não foi possível iniciar a conexão.")); }
    });
    ac.append(conectar);
    if (s.conectado) {
      const sinc = h("button", { type: "button", class: "sec mini" }, "Sincronizar agora");
      sinc.addEventListener("click", async () => {
        sinc.disabled = true; sinc.textContent = "Sincronizando…";
        const x = await api("POST", "/ml/sincronizar");
        const av = $("#ml-aviso");
        av.textContent = x.ok ? `Pronto: ${x.json.novas ?? 0} nova(s), ${x.json.atualizadas ?? 0} atualizada(s), ${x.json.mensagens ?? 0} mensagem(ns).` : (x.json.erro || "Falha ao sincronizar.");
        mostrar(av, true); carregarMl();
      });
      const des = h("button", { type: "button", class: "sec mini" }, "Desconectar");
      des.addEventListener("click", async () => {
        if (!window.confirm("Desconectar o Mercado Livre? As reclamações já importadas continuam no painel.")) return;
        await api("DELETE", "/ml"); carregarMl();
      });
      ac.append(sinc, des);
    }
  }

  // ---------- equipe ----------
  async function carregarEquipe() {
    carregarMl();
    const [u, k] = await Promise.all([api("GET", "/usuarios"), api("GET", "/chaves")]);
    if (u.ok) {
      const corpo = $("#usuarios");
      corpo.replaceChildren();
      for (const x of u.json) {
        const eu = x.email === estado.eu.email;
        const ativar = h("button", { type: "button", class: "sec mini" }, x.ativo ? "Desativar" : "Reativar");
        ativar.disabled = eu;
        ativar.addEventListener("click", async () => {
          const r = await api("PATCH", "/usuarios/" + x.id, { ativo: !x.ativo });
          if (!r.ok) alertaEquipe(r.json.erro); else carregarEquipe();
        });
        const trocar = h("button", { type: "button", class: "sec mini" }, "Nova senha");
        trocar.addEventListener("click", async () => {
          const s = window.prompt(`Nova senha para ${x.nome} (mínimo 10 caracteres):`);
          if (!s) return;
          const r = await api("PATCH", "/usuarios/" + x.id, { senha: s });
          alertaEquipe(r.ok ? "Senha alterada. O usuário precisará entrar de novo." : r.json.erro);
        });
        corpo.append(h("tr", {},
          h("td", {}, h("strong", {}, x.nome), h("small", {}, x.email)),
          h("td", {}, PAPEL[x.papel]),
          h("td", {}, x.ativo ? "Ativo" : "Desativado", h("small", {}, x.ultimo_login ? "Último acesso " + fmt(x.ultimo_login) : "Nunca entrou")),
          h("td", {}, h("div", { class: "acoes-u" }, ativar, trocar))));
      }
    }
    if (k.ok) {
      const ul = $("#chaves");
      ul.replaceChildren();
      if (!k.json.length) ul.append(h("li", {}, h("span", { class: "aviso" }, "Nenhuma chave criada ainda.")));
      for (const c of k.json) {
        const rev = h("button", { type: "button", class: "sec mini" }, "Revogar");
        rev.addEventListener("click", async () => {
          if (!window.confirm(`Revogar a chave "${c.nome}"? O Gerente IA perde o acesso na hora.`)) return;
          await api("DELETE", "/chaves/" + c.id); carregarEquipe();
        });
        ul.append(h("li", {},
          h("span", {}, h("strong", {}, c.nome), h("small", {}, `${c.prefixo}… · ${c.ativa ? "ativa" : "revogada"} · ${c.ultimo_uso ? "último uso " + fmt(c.ultimo_uso) : "nunca usada"}`)),
          c.ativa ? rev : null));
      }
    }
  }
  function alertaEquipe(msg) { erroEm($("#usuario-erro"), msg); }

  // ---------- eventos ----------
  $("#f-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#login-erro"), "");
    const r = await api("POST", "/login", { email: $("#l-email").value, senha: $("#l-senha").value });
    if (!r.ok) { erroEm($("#login-erro"), r.json.erro || "Não foi possível entrar."); return; }
    entrar({ tipo: "usuario", ...r.json });
  });
  $("#sair").addEventListener("click", async () => { await api("POST", "/logout"); estado.meta = null; mostrarLogin(); });
  for (const b of document.querySelectorAll(".aba")) b.addEventListener("click", () => abrirAba(b.dataset.aba));

  let timer;
  $("#f-busca").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { estado.filtro.q = e.target.value.trim(); estado.filtro.pagina = 1; carregarLista(); }, 300);
  });
  $("#f-canal").addEventListener("change", (e) => { estado.filtro.canal = e.target.value; estado.filtro.pagina = 1; carregarLista(); });
  $("#f-origem").addEventListener("change", (e) => { estado.filtro.origem = e.target.value; estado.filtro.pagina = 1; carregarLista(); });
  $("#f-status").addEventListener("change", (e) => { estado.filtro.status = e.target.value; estado.filtro.pagina = 1; carregarLista(); });
  $("#p-ant").addEventListener("click", () => { estado.filtro.pagina--; carregarLista(); });
  $("#p-prox").addEventListener("click", () => { estado.filtro.pagina++; carregarLista(); });

  $("#f-usuario").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#usuario-erro"), "");
    const r = await api("POST", "/usuarios", { nome: $("#u-nome").value, email: $("#u-email").value, senha: $("#u-senha").value, papel: $("#u-papel").value });
    if (!r.ok) { erroEm($("#usuario-erro"), r.json.erro || "Não foi possível criar."); return; }
    e.target.reset(); carregarEquipe();
  });
  $("#f-chave").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#chave-erro"), "");
    const r = await api("POST", "/chaves", { nome: $("#k-nome").value });
    if (!r.ok) { erroEm($("#chave-erro"), r.json.erro || "Não foi possível gerar."); return; }
    $("#chave-token").textContent = r.json.token;
    mostrar($("#chave-nova"), true);
    e.target.reset(); carregarEquipe();
  });
  $("#chave-copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#chave-token").textContent); $("#chave-copiar").textContent = "Copiada!"; }
    catch { $("#chave-copiar").textContent = "Selecione e copie a chave acima"; }
  });
  $("#f-senha").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#senha-erro"), ""); mostrar($("#senha-ok"), false);
    const r = await api("POST", "/eu/senha", { atual: $("#s-atual").value, nova: $("#s-nova").value });
    if (!r.ok) { erroEm($("#senha-erro"), r.json.erro || "Não foi possível trocar."); return; }
    e.target.reset(); mostrar($("#senha-ok"), true);
  });
  window.addEventListener("hashchange", () => { if (estado.eu && estado.aba === "ocorrencias") abrirDoHash(); });
  setInterval(() => { if (estado.eu && estado.aba === "ocorrencias" && document.visibilityState === "visible") carregarLista(); }, 60000);

  // ---------- início ----------
  (async function iniciar() {
    try {
      const cfg = await (await fetch("/api/config")).json();
      $("#rodape").textContent = cfg.marca + " · painel v" + cfg.versao;
    } catch {}
    const r = await api("GET", "/me");
    if (r.ok && r.json.tipo === "usuario") entrar(r.json); else mostrarLogin();
  })();
})();
