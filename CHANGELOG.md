# Changelog

## v1.2.0 — 2026-10-08

Reclamações do Mercado Livre dentro da Central, com resposta ao comprador.

- **Conexão própria** com o Mercado Livre (OAuth), feita pelo gerente na aba Equipe → *Mercado Livre* → *Conectar*. Tokens guardados criptografados (AES-256-GCM); renovação automática.
- **Importação automática** das reclamações abertas (verifica a cada 3 min, `ML_POLL_MINUTES`). Cada reclamação vira uma ocorrência com o selo **ML**, canal Mercado Livre, pedido, comprador (apelido), motivo, etapa e **prazo para responder** (em vermelho quando falta menos de 24 h). Consulta ao Tiny pelo número do pedido, se ligado.
- **Aviso no Telegram** para reclamação nova e para nova mensagem do comprador.
- **Responder o comprador pelo painel**: a conversa aparece como bate-papo e a resposta vai direto para a reclamação no Mercado Livre (ao mediador, se a reclamação estiver em disputa). **Pessoas e o Gerente IA** podem responder; o histórico mostra quem enviou. A IA tem limite de 20 mensagens por hora.
- Reclamação encerrada no ML vira **Resolvida** sozinha; mensagem nova do comprador reabre como **Em análise**.
- Filtro por origem (formulário do site × Mercado Livre) na lista.
- Reclamações do ML **não** aparecem na consulta pública do cliente e não têm resposta por e-mail (o Mercado Livre não informa o e-mail do comprador).
- Novas variáveis: `ML_CLIENT_ID`, `ML_CLIENT_SECRET` (opcionais: `ML_REDIRECT_URI`, `ML_POLL_MINUTES`).

## v1.1.0 — 2026-10-05

Painel interno de triagem, com login da equipe e acesso do Gerente IA.

- **Painel** em `/painel`: lista com filtros (canal, status, busca por protocolo, pedido, nome ou e-mail) e contadores por status; detalhe com relato, dados do Tiny, fotos, histórico; mudança de status; nota interna; resposta ao cliente por e-mail (também aparece na consulta); layout para celular e computador.
- **Login por usuário e senha** com dois perfis: *gerente* (também administra a equipe e as chaves) e *atendimento*. Contas criadas e desativadas dentro do painel (aba Equipe). O primeiro gerente nasce de `ADMIN_EMAIL` e `ADMIN_PASSWORD`.
- **Gerente IA**: chaves de API (`Authorization: Bearer mcsia_…`) geradas e revogadas pelo gerente. A IA lista e lê ocorrências, muda status e anota; **não** responde clientes nem vê fotos. Ver `API-GERENTE-IA.md`.
- Histórico mostra **quem** fez cada ação (pessoa ou Gerente IA). Notas internas nunca aparecem para o cliente.
- Segurança: senhas com scrypt; cookie de sessão HttpOnly, SameSite=Strict e Secure; proteção extra contra CSRF; limite de 10 tentativas de login por 15 min; fotos só para quem está logado; chaves guardadas só como hash.
- O aviso no Telegram ganhou o link "Abrir no painel".
- O botão do e-mail de confirmação passou para o laranja da MCS.

## v1.0.6 — 2026-10-05

Novo visual da Central e e-mail com Reply-To.

- **Novo layout** (aprovado no Claude Design): formulário em passos numerados, tela de protocolo em formato de comprovante, consulta com linha do tempo e status coloridos. Funciona em celular e computador.
- Fontes (DM Sans e Bricolage Grotesque) hospedadas no próprio site: nenhuma requisição ao Google, bom para a LGPD.
- E-mail de confirmação agora leva `Reply-To` = `SUPPORT_EMAIL`: se o cliente responder, a resposta cai na caixa de atendimento, mesmo com o remetente em outro domínio (ex.: `send.mcs.ind.br` do Resend).
- O tema escuro foi removido (o layout é claro).
- CSP: liberadas fontes do próprio site (`font-src 'self'`).

## v1.0.5 — 2026-10-05

Correção do remetente dos e-mails de confirmação.

- **Correção:** sem `MAIL_FROM`, o remetente passava a ser `no-reply@example.com` (endereço de exemplo). O servidor de e-mail aceitava a mensagem, mas os destinos a recusavam e nada chegava. Agora, sem `MAIL_FROM`, o remetente é `<BRAND_NAME> <SMTP_USER>`.
- O remetente do envelope (Return-Path) passa a ser sempre a conta autenticada (`SMTP_USER`), para que devoluções cheguem a uma caixa real.
- Ao iniciar, o log mostra o remetente em uso e avisa se ele for um endereço de exemplo ou de domínio diferente do login SMTP.
- O log de cada envio inclui o `from` e o `envelope` usados.

## v1.0.4 — 2026-10-05

Diagnóstico do e-mail. Nenhuma mudança visível para o cliente.

- Ao iniciar, a central testa o SMTP (conexão, TLS e login) e registra o resultado no log: `[mail] SMTP verificado…` ou `[mail] FALHA ao verificar SMTP…`, com o código do erro e uma dica do que ajustar.
- Cada envio de confirmação agora é registrado: `[mail] enviado <protocolo> para <e-mail> · aceitos=… recusados=… · resposta=…`.
- Falhas de envio mostram código, comando e resposta do servidor (antes só a mensagem).

## v1.0.3 — 2026-10-05

Configuração de e-mail da MCS. Sem mudança de funcionalidade.

- `.env.example` e `DEPLOY-EASYPANEL.md` com os dados reais do SMTP (`mail.mcs.ind.br`, porta 465, TLS direto, `atendimento@mcs.ind.br`).
- Nova variável opcional `SMTP_TLS_SERVERNAME` para o caso de o certificado do servidor de e-mail ser emitido com outro nome (comum na HostGator), sem desligar a verificação.
- Tempos limite de conexão do SMTP (15–20 s), para o envio não ficar pendurado se a porta estiver bloqueada.

## v1.0.2 — 2026-10-05

Preparação para o deploy no Easypanel da MCS. Nenhuma mudança de funcionalidade.

- `DEPLOY-EASYPANEL.md`: passo a passo (subdomínio, variáveis, volume, domínio/HTTPS, validação).
- `.github/workflows/docker.yml`: publica a imagem no ghcr.io a cada push (mesmo esquema do ml-actions).
- `docker-entrypoint.sh`: ajusta a permissão do volume `/data` (nasce como root no Easypanel) e roda o app como usuário `node`.

## v1.0.1 — 2026-10-04

Identidade visual da MCS Brasil. Nenhuma mudança de comportamento ou de API.

- Logo da MCS Brasil no cabeçalho (`public/logo.png`) e favicon (`public/favicon.png`).
- Paleta laranja do logo: laranja escuro nos botões e links (texto branco legível), laranja do logo como faixa do cabeçalho.
- Cabeçalho claro (escuro no modo escuro) para o logo, que tem contorno branco, aparecer bem.
- Versão exibida no rodapé da página: v1.0.1.

## v1.0.0 — 2026-10-03

Primeira versão.

- Formulário público (mobile-first) com escolha do canal: Mercado Livre, Shopee, TikTok Shop, loja própria.
- Protocolo único (`MCS-AAAAMMDD-XXXXXX`) e tela de confirmação.
- Upload de até 5 fotos (JPG/PNG/WebP, 5 MB cada), com checagem da assinatura real do arquivo.
- Consulta de status por protocolo + e-mail (`/consulta.html`).
- Consulta do pedido no Tiny (API v2 por token); falha do Tiny não impede o registro.
- Aviso no Telegram a cada nova ocorrência.
- E-mail de confirmação com o protocolo (SMTP).
- Proteções: rate limit, honeypot, CSP, consentimento LGPD, IP guardado só como hash.
- Banco SQLite, Dockerfile e docker-compose.

**Fora desta versão (previsto para v1.1.0):** painel interno de triagem (login, filtros, mudança de status, notas, resposta ao cliente, visualização das fotos).
