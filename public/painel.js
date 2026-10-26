// Central de Ocorrências v1.7.0 — painel interno
(function () {
  const $ = (s) => document.querySelector(s);
  const STATUS_INT = { nova: "Nova", em_analise: "Em análise", aguardando_cliente: "Aguardando cliente", resolvida: "Resolvida" };
  const PAPEL = { gerente: "Gerente", atendimento: "Atendimento" };

  const estado = { eu: null, meta: null, filtro: { q: "", canal: "", status: "", origem: "", responsavel: "", pagina: 1 }, aberto: null, aba: "ocorrencias", msgResp: "" };

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
    for (const v of ["ocorrencias", "equipe", "numeros", "conta", "esqueci", "redefinir"]) mostrar($("#v-" + v), false);
    mostrar($("#v-login"), true);
    $("#l-senha").value = "";
    $("#l-email").focus();
  }

  function entrar(eu) {
    estado.eu = eu;
    for (const v of ["login", "esqueci", "redefinir"]) mostrar($("#v-" + v), false);
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
    for (const v of ["ocorrencias", "equipe", "numeros", "conta", "esqueci", "redefinir"]) mostrar($("#v-" + v), v === nome);
    if (nome === "ocorrencias") { carregarLista().then(() => abrirDoHash()); }
    if (nome === "equipe") carregarEquipe();
    if (nome === "numeros") carregarNumeros();
    if (nome === "conta") api("GET", "/me").then((r) => { if (r.ok) $("#c-avisos").checked = Boolean(r.json.avisarEmail); });
  }

  // ---------- ocorrências ----------
  async function carregarLista() {
    const f = estado.filtro;
    const q = new URLSearchParams({ q: f.q, canal: f.canal, status: f.status, origem: f.origem, responsavel: f.responsavel, pagina: String(f.pagina) });
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
        h("td", {}, o.produto?.foto ? h("img", { class: "mini-prod", src: "/api/admin/produto-img/" + o.produto.foto, alt: "", width: "44", height: "44", loading: "lazy" }) : null,
          h("strong", {}, o.protocolo, o.origem === "ml" ? h("span", { class: "sel-ml" }, "ML") : null), h("small", {}, `${o.nome} · ${fmt(o.criado_em)}`), o.responsavel ? h("small", { class: "resp-lista" }, "Com " + o.responsavel) : null, prazoEl(o), h("small", { class: "so-m" }, `${d.canais[o.canal] || o.canal} · ${d.tipos[o.tipo] || o.tipo}`)),
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
    for (const u of d.equipe || []) $("#f-responsavel").append(h("option", { value: String(u.id) }, u.nome));
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

  // Seletor de modelos de resposta: preenche o campo com o texto já personalizado
  function seletorModelo(o, campo) {
    const sel = h("select", { "aria-label": "Inserir modelo de resposta", class: "modelo-sel oculto" }, h("option", { value: "" }, "Inserir modelo de resposta…"));
    api("GET", "/modelos?protocolo=" + encodeURIComponent(o.protocolo)).then((r) => {
      if (!r.ok || !r.json.length) return;
      for (const m of r.json) sel.append(h("option", { value: m.id }, m.titulo));
      sel.addEventListener("change", () => {
        const m = r.json.find((x) => String(x.id) === sel.value);
        if (m) { campo.value = m.texto_pronto; campo.focus(); }
        sel.value = "";
      });
      mostrar(sel, true);
    });
    return sel;
  }

  function botaoLgpd(o, acao, rotulo, aviso) {
    const b = h("button", { type: "button", class: "sec mini perigo" }, rotulo);
    b.addEventListener("click", async () => {
      const palavra = acao === "excluir" ? "EXCLUIR" : "ANONIMIZAR";
      const t = window.prompt(`${aviso}\n\nPara confirmar, digite ${palavra}:`);
      if (!t) return;
      const r = await api("POST", `/ocorrencias/${encodeURIComponent(o.protocolo)}/${acao}`, { confirmar: t });
      if (!r.ok) { window.alert(r.json.erro || "Não foi possível concluir."); return; }
      if (acao === "excluir") { estado.aberto = null; history.replaceState(null, "", location.pathname); $("#detalhe").replaceChildren(h("p", { class: "vazio" }, "Ocorrência excluída.")); }
      else await selecionar(o.protocolo, false);
      carregarLista();
    });
    return b;
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
      const rotulo = e.do_cliente ? ["Cliente escreveu", "cli"] : interna ? ["Nota interna", ""] : !e.autor ? ["Sistema", "sis"] : ["Cliente vê", "pub"];
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
      h("label", { for: "d-resp" }, "Resposta ao cliente ", h("span", { class: "dica" }, "(vai por e-mail e aparece na consulta)")), ehMl ? null : seletorModelo(o, respTxt), respTxt, respMsg,
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

    const lgpd = h("div", { class: "lgpd" },
      h("h3", {}, "Dados pessoais (LGPD)"),
      h("p", { class: "aviso" }, o.anonimizada ? "Os dados pessoais desta ocorrência já foram removidos." : "A pedido do titular: baixe uma cópia dos dados ou remova-os."),
      h("div", { class: "acoes-u" },
        o.anonimizada ? null : h("a", { class: "botao-link", href: `/api/admin/ocorrencias/${encodeURIComponent(o.protocolo)}/exportar` }, "Baixar dados do titular"),
        !o.anonimizada && estado.eu.papel === "gerente" ? botaoLgpd(o, "anonimizar", "Anonimizar", "Remove nome, e-mail, telefone, relato e fotos, mas mantém a ocorrência para as estatísticas.") : null,
        estado.eu.papel === "gerente" ? botaoLgpd(o, "excluir", "Excluir tudo", "Apaga a ocorrência inteira, com histórico e fotos. Não dá para desfazer.") : null));

    const partes = [
      h("div", { class: "cab" }, h("h2", {}, o.protocolo), h("span", { class: "etiqueta " + o.status }, STATUS_INT[o.status] || o.status)),
      h("p", { class: "meta" }, `${m.canais[o.canal] || o.canal} · pedido ${o.pedido} · ${m.tipos[o.tipo] || o.tipo}`),
      ehMl
        ? h("p", { class: "meta" }, `Comprador ${o.nome} (o Mercado Livre não informa o e-mail) · aberta em ${fmt(o.criado_em)}`)
        : h("p", { class: "meta" }, `${o.nome} · `, h("a", { href: "mailto:" + o.email }, o.email), o.telefone ? ` · ${o.telefone}` : "", ` · aberta em ${fmt(o.criado_em)}`),
      ...(ehMl ? [blocoMl(o)] : []),
      blocoProdutos(o),
      tiny,
      h("h3", {}, ehMl ? "Descrição" : "Relato do cliente"), h("p", { class: "relato" }, o.descricao),
      ...(ehMl ? [] : [h("h3", {}, `Fotos (${o.anexos.length})`), fotos]),
      h("div", { class: "acao" }, h("label", { for: "d-status" }, "Mudar status"), seletor, msgStatus),
      blocoResponsavel(o),
      blocoDesfecho(o),
      blocoPesquisa(o),
      o.anonimizada ? h("p", { class: "faixa neutro" }, "Dados pessoais removidos: não é possível responder o cliente.") : null,
      formNota, o.anonimizada ? null : ehMl ? formMl(o) : formResp,
      h("h3", {}, "Histórico"), hist, lgpd,
    ];
    box.append(...partes.flat(Infinity).filter((x) => x != null && x !== false));
  }

  // Responsável: seletor com a equipe ativa e atalho "Assumir"
  function blocoResponsavel(o) {
    const equipe = estado.meta?.equipe || [];
    const atual = o.responsavel;
    const opcoes = [...equipe];
    if (atual && !opcoes.some((u) => u.id === atual.id)) opcoes.push({ id: atual.id, nome: atual.nome + " (desativado)" });
    const sel = h("select", { id: "d-resp-pessoa" }, h("option", { value: "" }, "Ninguém"),
      opcoes.map((u) => h("option", { value: String(u.id), selected: atual?.id === u.id }, u.nome)));
    const msg = h("p", { class: "msg-ok oculto", role: "status" });
    async function salvar(usuarioId) {
      sel.disabled = true;
      const r = await api("PATCH", `/ocorrencias/${encodeURIComponent(o.protocolo)}/responsavel`, { usuarioId });
      if (r.ok) { await selecionar(o.protocolo, false); await carregarLista(); }
      else { sel.disabled = false; msg.textContent = r.json.erro || "Não foi possível mudar o responsável."; mostrar(msg, true); }
    }
    sel.addEventListener("change", () => salvar(sel.value ? Number(sel.value) : null));
    const meuId = estado.eu?.id;
    const assumir = meuId && atual?.id !== meuId ? h("button", { type: "button", class: "sec mini", onclick: () => salvar(meuId) }, "Assumir") : null;
    return h("div", { class: "acao" }, h("label", { for: "d-resp-pessoa" }, "Responsável"),
      h("div", { class: "linha-resp" }, sel, assumir), msg);
  }

  // Desfecho e custo da resolução
  function blocoDesfecho(o) {
    const desfechos = estado.meta?.desfechos || {};
    const sel = h("select", { id: "d-desfecho" }, h("option", { value: "" }, "Não registrado"),
      Object.entries(desfechos).map(([k, v]) => h("option", { value: k, selected: k === o.desfecho }, v)));
    const custo = h("input", { type: "text", id: "d-custo", inputmode: "decimal", placeholder: "0,00", autocomplete: "off",
      value: o.custo_centavos != null ? (o.custo_centavos / 100).toFixed(2).replace(".", ",") : "" });
    const msg = h("p", { class: "msg-ok oculto", role: "status" });
    const f = h("form", { class: "acao desfecho", novalidate: true },
      h("div", { class: "campos-desfecho" },
        h("div", {}, h("label", { for: "d-desfecho" }, "Desfecho"), sel),
        h("div", {}, h("label", { for: "d-custo" }, "Custo para a empresa ", h("span", { class: "dica" }, "(R$, opcional)")), custo)),
      msg, h("button", { type: "submit", class: "sec mini" }, "Salvar desfecho"));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const txt = custo.value.trim().replace(/\s|R\$/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
      const valor = txt === "" ? null : Number(txt);
      if (valor != null && (!Number.isFinite(valor) || valor < 0)) { msg.textContent = "Custo inválido. Use, por exemplo, 49,90."; mostrar(msg, true); return; }
      const r = await api("PATCH", `/ocorrencias/${encodeURIComponent(o.protocolo)}/desfecho`, { desfecho: sel.value || null, custo: valor });
      if (r.ok) await selecionar(o.protocolo, false);
      else { msg.textContent = r.json.erro || "Não foi possível salvar."; mostrar(msg, true); }
    });
    const lembrete = o.status === "resolvida" && !o.desfecho
      ? h("div", { class: "faixa aviso-f" }, "Resolvida sem desfecho: registre como foi resolvida para aparecer nos Números.") : null;
    return [lembrete, f];
  }

  function estrelas(n) { return "★".repeat(n) + "☆".repeat(5 - n); }
  function blocoPesquisa(o) {
    const p = o.pesquisa;
    if (!p) return null;
    if (p.nota == null) return h("div", { class: "faixa neutro" }, `Pesquisa de satisfação enviada em ${fmt(p.enviada_em)}. Ainda sem resposta.`);
    return h("div", { class: "faixa " + (p.nota >= 4 ? "ok" : p.nota <= 2 ? "aviso-f" : "neutro") + " pesquisa" },
      h("span", {}, h("strong", {}, `Satisfação: ${estrelas(p.nota)} ${p.nota}/5`), ` · respondida em ${fmt(p.respondida_em)}`,
        p.comentario ? h("q", {}, p.comentario) : null));
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

  const moeda = (v) => (typeof v === "number" ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : null);
  function blocoProdutos(o) {
    if (!o.produtos || !o.produtos.length) return null;
    return h("div", { class: "produtos" }, h("h3", {}, o.produtos.length > 1 ? "Produtos do pedido" : "Produto do pedido"),
      o.produtos.map((p) => {
        const url = p.foto ? "/api/admin/produto-img/" + p.foto : null;
        const det = [p.sku ? `SKU ${p.sku}` : null, p.variacao, p.qtd ? `${p.qtd} un.` : null, moeda(p.preco)].filter(Boolean).join(" · ");
        return h("div", { class: "produto" },
          url ? h("a", { href: url, target: "_blank", rel: "noopener", "aria-label": "Ver a foto do produto em tamanho maior" },
            h("img", { src: url, alt: p.titulo ? `Foto do produto: ${p.titulo}` : "Foto do produto", width: "96", height: "96", loading: "lazy" })) : h("div", { class: "sem-foto", "aria-hidden": "true" }, "sem foto"),
          h("div", {}, h("strong", {}, p.titulo || "Produto"), det ? h("small", {}, det) : null,
            p.permalink ? h("a", { href: p.permalink, target: "_blank", rel: "noopener" }, "Ver anúncio no Mercado Livre") : null));
      }));
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
      h("label", { for: "d-ml" }, "Mensagem ", h("span", { class: "dica" }, `(vai ${para}, direto no Mercado Livre; até 2000 caracteres)`)), seletorModelo(o, txt), txt, msg,
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


  // ---------- números ----------
  const NS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs, texto) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (texto != null) el.textContent = texto;
    return el;
  }
  // Barras horizontais (sem estilos inline: tudo por atributos SVG)
  function barras(alvo, itens) {
    alvo.replaceChildren();
    if (!itens.length) { alvo.append(h("p", { class: "aviso" }, "Sem dados no período.")); return; }
    const max = Math.max(...itens.map((i) => i.n), 1), linha = 30, larg = 360, rot = 130;
    const svg = sv("svg", { viewBox: `0 0 ${larg} ${itens.length * linha}`, class: "grafico", role: "img", "aria-label": itens.map((i) => `${i.rotulo}: ${i.n}`).join("; ") });
    itens.forEach((i, idx) => {
      const y = idx * linha, w = Math.max(2, ((larg - rot - 44) * i.n) / max);
      svg.append(sv("text", { x: 0, y: y + 19, class: "g-rot" }, i.rotulo.length > 20 ? i.rotulo.slice(0, 19) + "…" : i.rotulo));
      svg.append(sv("rect", { x: rot, y: y + 6, width: w, height: 16, rx: 4, class: "g-barra" }));
      svg.append(sv("text", { x: rot + w + 6, y: y + 19, class: "g-val" }, i.n));
    });
    alvo.append(svg);
  }
  function colunas(alvo, itens) {
    alvo.replaceChildren();
    if (!itens.length) { alvo.append(h("p", { class: "aviso" }, "Sem dados nas últimas 8 semanas.")); return; }
    const max = Math.max(...itens.map((i) => i.n), 1), l = 64, alt = 150;
    const svg = sv("svg", { viewBox: `0 0 ${itens.length * l} ${alt + 40}`, class: "grafico", role: "img", "aria-label": itens.map((i) => `${i.rotulo}: ${i.n}`).join("; ") });
    itens.forEach((i, idx) => {
      const hh = Math.max(2, ((alt - 20) * i.n) / max), x = idx * l + 12;
      svg.append(sv("rect", { x, y: alt - hh, width: l - 24, height: hh, rx: 4, class: "g-barra" }));
      svg.append(sv("text", { x: x + (l - 24) / 2, y: alt - hh - 5, class: "g-val", "text-anchor": "middle" }, i.n));
      svg.append(sv("text", { x: x + (l - 24) / 2, y: alt + 18, class: "g-rot", "text-anchor": "middle" }, i.rotulo));
    });
    alvo.append(svg);
  }
  const horas = (x) => (x == null ? "—" : x < 48 ? `${x.toLocaleString("pt-BR")} h` : `${(x / 24).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`);

  async function carregarNumeros() {
    const r = await api("GET", "/estatisticas?dias=" + encodeURIComponent($("#n-dias").value));
    if (!r.ok) return;
    const d = r.json, box = $("#n-kpis");
    box.replaceChildren();
    for (const [rot, val, cls] of [["Em aberto agora", d.abertas, "nova"], ["Recebidas no período", d.total, "em_analise"], ["Resolvidas", d.resolvidas, "resolvida"],
      ["Tempo até a 1ª resposta", horas(d.horasPrimeiraResposta), "aguardando_cliente"], ["Tempo até resolver", horas(d.horasResolucao), "em_analise"],
      ["Custo das resolvidas", moeda(d.custoTotal) || "R$ 0,00", "nova"],
      ["Satisfação média", d.satisfacao.media == null ? "—" : `${d.satisfacao.media.toLocaleString("pt-BR")} / 5`, "resolvida"]])
      box.append(h("div", { class: "kpi " + cls }, rot, h("b", {}, String(val))));
    // Sempre as últimas 8 semanas (segunda-feira de cada uma), mesmo as vazias
    const hoje = new Date(); hoje.setUTCHours(0, 0, 0, 0);
    const seg = new Date(hoje.getTime() - ((hoje.getUTCDay() + 6) % 7) * 86400000);
    const semanas = [];
    for (let i = 7; i >= 0; i--) {
      const dt = new Date(seg.getTime() - i * 7 * 86400000), k = dt.toISOString().slice(0, 10);
      semanas.push({ rotulo: k.slice(8, 10) + "/" + k.slice(5, 7), n: d.porSemana.find((x) => x.k === k)?.n ?? 0 });
    }
    colunas($("#g-semana"), semanas);
    barras($("#g-canal"), d.porCanal.map((x) => ({ rotulo: d.canais[x.k] || x.k, n: x.n })));
    barras($("#g-tipo"), d.porTipo.map((x) => ({ rotulo: d.tipos[x.k] || x.k, n: x.n })));
    barras($("#g-origem"), d.porOrigem.map((x) => ({ rotulo: x.k === "ml" ? "Mercado Livre (reclamações)" : "Formulário do site", n: x.n })));
    barras($("#g-desfecho"), d.porDesfecho.map((x) => ({ rotulo: x.k === "sem_registro" ? "Não registrado" : d.desfechos[x.k] || x.k, n: x.n })));
    $("#desfecho-custo").textContent = d.porDesfecho.some((x) => x.custo > 0)
      ? "Custo por desfecho: " + d.porDesfecho.filter((x) => x.custo > 0).map((x) => `${x.k === "sem_registro" ? "Não registrado" : d.desfechos[x.k] || x.k} ${moeda(x.custo)}`).join(" · ")
      : "Nenhum custo registrado no período.";
    const s = d.satisfacao;
    if (s.respostas) barras($("#g-satisfacao"), [5, 4, 3, 2, 1].map((n) => ({ rotulo: estrelas(n), n: (d.porNota || []).find((x) => x.k === n)?.n ?? 0 })));
    else $("#g-satisfacao").replaceChildren();
    $("#satisfacao-info").textContent = s.enviadas || s.respostas
      ? `${s.respostas} resposta(s) de ${s.enviadas} pesquisa(s) enviada(s) no período${s.respostas ? ` · ${Math.round((s.boas / s.respostas) * 100)}% deram 4 ou 5` : ""}.`
      : "Nenhuma pesquisa enviada no período. Elas saem por e-mail algumas horas depois de a ocorrência ser resolvida.";
  }

  // ---------- modelos, QR e backup (equipe) ----------
  async function carregarModelos() {
    const r = await api("GET", "/modelos");
    const ul = $("#modelos");
    ul.replaceChildren();
    if (!r.ok) return;
    for (const m of r.json) {
      const ed = h("button", { type: "button", class: "sec mini" }, "Editar");
      ed.addEventListener("click", () => {
        $("#m-id").value = m.id; $("#m-titulo").value = m.titulo; $("#m-texto").value = m.texto;
        $("#m-salvar").textContent = "Salvar alterações"; mostrar($("#m-cancelar"), true); $("#m-titulo").focus();
      });
      const ex = h("button", { type: "button", class: "sec mini" }, "Excluir");
      ex.addEventListener("click", async () => { if (window.confirm(`Excluir o modelo "${m.titulo}"?`)) { await api("DELETE", "/modelos/" + m.id); carregarModelos(); } });
      ul.append(h("li", {}, h("span", {}, h("strong", {}, m.titulo), h("small", {}, m.texto.length > 110 ? m.texto.slice(0, 110) + "…" : m.texto)), h("span", { class: "acoes-u" }, ed, ex)));
    }
  }
  function limparFormModelo() { $("#f-modelo").reset(); $("#m-id").value = ""; $("#m-salvar").textContent = "Adicionar modelo"; mostrar($("#m-cancelar"), false); }

  function carregarQrs() {
    const alvo = $("#qrs");
    if (alvo.childElementCount) return;
    const canais = estado.meta?.canais || { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop", loja_propria: "Loja própria" };
    for (const [k, nome] of [["", "Geral (todos os canais)"], ...Object.entries(canais)]) {
      const q = k ? `canal=${k}&` : "";
      alvo.append(h("figure", { class: "qr" },
        h("img", { src: `/api/admin/qr?${q}formato=svg`, alt: `QR code: ${nome}`, width: "132", height: "132", loading: "lazy" }),
        h("figcaption", {}, nome, h("br"),
          h("a", { href: `/api/admin/qr?${q}formato=png`, download: `qr-${k || "geral"}.png` }, "PNG"), " · ",
          h("a", { href: `/api/admin/qr?${q}formato=svg`, download: `qr-${k || "geral"}.svg` }, "SVG"))));
    }
  }

  const tamanho = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  async function carregarBackups() {
    const r = await api("GET", "/backups");
    const ul = $("#backups");
    ul.replaceChildren();
    if (!r.ok) return;
    if (!r.json.length) ul.append(h("li", {}, h("span", { class: "aviso" }, "Nenhum backup ainda: o primeiro sai em até 30 s depois de iniciar, ou use o botão abaixo.")));
    for (const b of r.json.slice(0, 7))
      ul.append(h("li", {}, h("span", {}, h("strong", {}, b.nome), h("small", {}, `${tamanho(b.bytes)} · ${fmt(b.criado.replace("T", " ").slice(0, 19))}`)),
        h("a", { class: "botao-link", href: "/api/admin/backups/" + encodeURIComponent(b.nome) }, "Baixar")));
  }

  const ROT_REG = { login_ok: "Entrou", login_falha: "Senha errada", login_novo_ip: "Entrou de IP novo", alerta_falhas: "Alerta: várias senhas erradas",
    redefinicao_pedida: "Pediu nova senha", senha_redefinida: "Nova senha por e-mail", senha_alterada: "Trocou a senha", usuario_criado: "Criou usuário",
    usuario_alterado: "Alterou usuário", chave_criada: "Criou chave da IA", chave_revogada: "Revogou chave da IA", dados_exportados: "Baixou dados do titular",
    ocorrencia_anonimizada: "Anonimizou ocorrência", ocorrencia_excluida: "Excluiu ocorrência", lista_exportada: "Exportou a lista (CSV)" };
  async function carregarRegistro() {
    const r = await api("GET", "/registro?so=" + encodeURIComponent($("#reg-filtro").value));
    const corpo = $("#registro");
    corpo.replaceChildren();
    if (!r.ok) return;
    if (!r.json.length) corpo.append(h("tr", {}, h("td", { colspan: "4" }, "Nada registrado ainda.")));
    for (const x of r.json)
      corpo.append(h("tr", {}, h("td", {}, fmt(x.criado_em)), h("td", {}, x.quem || x.email || "—"),
        h("td", {}, ROT_REG[x.tipo] || x.tipo, x.detalhe ? h("small", {}, x.detalhe) : null), h("td", { class: "col-m" }, x.ip || "—")));
  }

  // ---------- equipe ----------
  async function carregarEquipe() {
    carregarMl(); carregarModelos(); carregarQrs(); carregarBackups(); carregarRegistro();
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
    erroEm($("#login-erro"), ""); mostrar($("#login-ok"), false);
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
  $("#f-responsavel").addEventListener("change", (e) => { estado.filtro.responsavel = e.target.value; estado.filtro.pagina = 1; carregarLista(); });
  $("#exportar-csv").addEventListener("click", () => {
    const f = estado.filtro;
    window.location.assign("/api/admin/ocorrencias.csv?" + new URLSearchParams({ q: f.q, canal: f.canal, status: f.status, origem: f.origem, responsavel: f.responsavel }));
  });
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

  $("#n-dias").addEventListener("change", carregarNumeros);
  $("#reg-filtro").addEventListener("change", carregarRegistro);
  $("#c-avisos").addEventListener("change", async (e) => {
    const r = await api("POST", "/eu/avisos", { email: e.target.checked }), m = $("#avisos-ok");
    m.textContent = r.ok ? (e.target.checked ? "Avisos por e-mail ligados." : "Avisos por e-mail desligados.") : (r.json.erro || "Não foi possível salvar.");
    mostrar(m, true);
  });
  $("#f-modelo").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#modelo-erro"), "");
    const id = $("#m-id").value, corpo = { titulo: $("#m-titulo").value, texto: $("#m-texto").value };
    const r = id ? await api("PATCH", "/modelos/" + id, corpo) : await api("POST", "/modelos", corpo);
    if (!r.ok) { erroEm($("#modelo-erro"), r.json.erro || "Não foi possível salvar."); return; }
    limparFormModelo(); carregarModelos();
  });
  $("#m-cancelar").addEventListener("click", limparFormModelo);
  $("#b-agora").addEventListener("click", async () => {
    const r = await api("POST", "/backups"), m = $("#backup-msg");
    m.textContent = r.ok ? "Backup criado." : (r.json.erro || "Falha ao criar o backup."); mostrar(m, true); carregarBackups();
  });

  // Recuperação de senha
  $("#ir-esqueci").addEventListener("click", () => { mostrar($("#v-login"), false); mostrar($("#v-esqueci"), true); $("#e-email").value = $("#l-email").value; $("#e-email").focus(); });
  $("#voltar-login").addEventListener("click", () => { mostrar($("#v-esqueci"), false); mostrar($("#v-login"), true); });
  $("#f-esqueci").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#esqueci-erro"), ""); mostrar($("#esqueci-ok"), false);
    const r = await api("POST", "/esqueci", { email: $("#e-email").value });
    if (!r.ok) { erroEm($("#esqueci-erro"), r.json.erro || "Não foi possível enviar."); return; }
    $("#esqueci-ok").textContent = r.json.mensagem; mostrar($("#esqueci-ok"), true);
  });
  $("#f-redefinir").addEventListener("submit", async (e) => {
    e.preventDefault();
    erroEm($("#redef-erro"), "");
    const token = new URLSearchParams(location.hash.slice(1)).get("redefinir") || "";
    const r = await api("POST", "/redefinir", { token, nova: $("#r-nova").value });
    if (!r.ok) { erroEm($("#redef-erro"), r.json.erro || "Não foi possível salvar."); return; }
    history.replaceState(null, "", location.pathname);
    $("#r-nova").value = "";
    mostrarLogin();
    erroEm($("#login-erro"), "");
    $("#login-ok").textContent = "Senha alterada. Entre com a nova senha."; mostrar($("#login-ok"), true);
  });
  window.addEventListener("hashchange", () => { if (estado.eu && estado.aba === "ocorrencias") abrirDoHash(); });
  setInterval(() => { if (estado.eu && estado.aba === "ocorrencias" && document.visibilityState === "visible") carregarLista(); }, 60000);

  // ---------- início ----------
  (async function iniciar() {
    try {
      const cfg = await (await fetch("/api/config")).json();
      $("#rodape").textContent = cfg.marca + " · painel v" + cfg.versao;
    } catch {}
    if (new URLSearchParams(location.hash.slice(1)).get("redefinir")) {
      mostrarLogin(); mostrar($("#v-login"), false); mostrar($("#v-redefinir"), true); $("#r-nova").focus();
      return;
    }
    const r = await api("GET", "/me");
    if (r.ok && r.json.tipo === "usuario") entrar(r.json); else mostrarLogin();
  })();
})();
