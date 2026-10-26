# Central de Ocorrências — v1.6.0

Página única de reclamações para vários canais de venda: **Mercado Livre, Shopee, TikTok Shop e loja própria**.
O cliente registra o problema, recebe um **protocolo** por e-mail e pode acompanhar o status. Você recebe o aviso no **Telegram** com os dados do pedido vindos do **Tiny**.

> Versão atual: **1.6.0** (o histórico de mudanças está em `CHANGELOG.md` e o guia de deploy no Easypanel em `DEPLOY-EASYPANEL.md`).

## Como funciona

```
Cliente (QR code no encarte) ──► /index.html ──► POST /api/ocorrencias
                                                    ├─ valida campos e fotos
                                                    ├─ consulta o pedido no Tiny (opcional)
                                                    ├─ grava no SQLite + fotos em disco
                                                    ├─ avisa no Telegram
                                                    └─ envia e-mail com o protocolo
Cliente ──► /consulta.html ──► GET /api/consulta?protocolo=…&email=…
```

- Se o Tiny, o Telegram ou o SMTP estiverem fora do ar ou sem configuração, **a ocorrência é registrada mesmo assim**; o problema vai para o log.
- Pedido não encontrado no Tiny não bloqueia o cliente. A ocorrência fica marcada como `nao_encontrado` para você conferir.
- A consulta exige **protocolo + e-mail**, para que ninguém descubra protocolos de outras pessoas.

## Rodar

### Docker (recomendado, no VPS)

```bash
cp .env.example .env     # preencha
docker compose up -d --build
```

O serviço escuta em `127.0.0.1:3000`. Publique com Nginx/Traefik em HTTPS (ex.: `ocorrencias.seudominio.com.br`) e defina `PUBLIC_URL` e `TRUST_PROXY=1` no `.env`.
Banco e fotos ficam em `./data` (faça backup dessa pasta).

### Local

```bash
npm install
cp .env.example .env
npm run dev              # http://localhost:3000
npm test                 # testes automáticos (banco temporário, nada é enviado)
# produção: npm run build && npm start
```

## Configuração (`.env`)

| Variável | Para quê |
|---|---|
| `BRAND_NAME`, `SUPPORT_EMAIL`, `SUPPORT_WHATSAPP`, `PRIVACY_URL` | Nome e contatos exibidos na página |
| `PROTOCOL_PREFIX` | Prefixo do protocolo (padrão `MCS`) |
| `TINY_TOKEN` | Token da API do Tiny (v2). Vazio = sem consulta ao Tiny |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Aviso de nova ocorrência. Vazio = desligado |
| `SMTP_*`, `MAIL_FROM` | E-mail de confirmação. Sem `SMTP_HOST`, só registra no log |
| `IP_SALT` | Texto aleatório; o IP é guardado apenas como hash |
| `DATA_DIR` | Pasta do banco e das fotos |

**Identidade visual:** o logo da MCS Brasil está em `public/logo.png` (cabeçalho) e `public/favicon.png`. As cores ficam nas variáveis do topo de `public/style.css` (`--cor-marca`, `--cor-destaque`). Para trocar o logo, substitua os dois arquivos mantendo os nomes.

## QR code do encarte

O link aceita parâmetros que já deixam o formulário preenchido:

- `https://ocorrencias.seudominio.com.br/?canal=shopee`: pré-seleciona o canal. Use um QR diferente por canal, e você ainda descobre a origem pelos dados.
- `…/?canal=mercado_livre&pedido=123`: também preenche o pedido, útil se o encarte for impresso por pedido.

Canais válidos: `mercado_livre`, `shopee`, `tiktok_shop`, `loja_propria`.

## Telegram: como obter os dados

1. Crie um bot com o `@BotFather` e copie o token em `TELEGRAM_BOT_TOKEN`.
2. Adicione o bot ao grupo (ou converse com ele) e descubra o `chat_id` em `https://api.telegram.org/bot<TOKEN>/getUpdates`.

Se preferir reaproveitar o bot do Gerente, use o mesmo token e o chat que ele já usa.

## Tiny

A v1.0.0 usa a **API v2 por token** (`pedidos.pesquisa.php`), buscando primeiro pelo número do pedido do e-commerce (`numeroEcommerce`, onde marketplaces costumam gravar o número) e depois pelo número do Tiny. Se os serviços da MCS usam outra forma de autenticação (por exemplo OAuth da API v3), só o arquivo `src/tiny.ts` precisa mudar.

## Segurança e privacidade

- Limite de envios por IP (8 por hora) e de consultas (30 por 15 min), campo isca contra robôs e cabeçalhos de segurança (CSP via Helmet).
- Fotos: só JPG/PNG/WebP, até 5 MB e 5 arquivos; a assinatura real do arquivo é conferida e o nome é substituído por um aleatório. As fotos **não são servidas pelo site**.
- LGPD: consentimento obrigatório no formulário, IP guardado só como hash. Coloque o link da sua política em `PRIVACY_URL` e defina por quanto tempo vai guardar as ocorrências.

## Tabelas (SQLite)

`ocorrencias` (dados e status), `anexos` (fotos) e `eventos` (histórico; `publico=1` aparece na consulta do cliente). Status: `nova`, `em_analise`, `aguardando_cliente`, `resolvida`.

## Painel interno (v1.1.0)

Em `/painel`. Perfis: **gerente** (tudo, mais equipe e chaves) e **atendimento** (triagem: status, notas, respostas, fotos).

1. Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` (mín. 10 caracteres) e reinicie: o primeiro gerente é criado. Depois remova `ADMIN_PASSWORD`.
2. Entre em `/painel`, abra **Equipe** e crie as contas do atendimento.
3. Para o Gerente IA, gere uma chave em **Equipe → Chaves do Gerente IA** e veja `API-GERENTE-IA.md`.

Uma lista de usuários esquecidos ou de chaves fica sempre visível na aba Equipe; desativar um usuário derruba as sessões dele na hora.

## Mercado Livre (v1.2.0)

Com `ML_CLIENT_ID` e `ML_CLIENT_SECRET` definidos, o gerente conecta a conta vendedora em **Equipe → Mercado Livre**. A Central verifica as reclamações abertas a cada `ML_POLL_MINUTES` (padrão 3), cria uma ocorrência por reclamação (origem `ml`), avisa no Telegram e deixa a equipe e o Gerente IA responderem o comprador dentro da reclamação. Tokens ficam criptografados no banco. Passo a passo em `DEPLOY-EASYPANEL.md`.

Tabelas extras: `ml_conexao`, `ml_estados`, `ml_mensagens`, `ml_envios`.

## Novidades da v1.3.0

- **Esqueci minha senha** por e-mail (link de 1 hora, uso único).
- **Modelos de resposta** com `{nome}`, `{protocolo}`, `{pedido}`.
- **Telegram**: alerta de prazo do Mercado Livre (24 h e 6 h) e resumo diário (`RESUMO_HORA`).
- **Aba Números** e **QR codes por canal** (aba Equipe).
- **Backup diário** do banco em `/data/backups` + download do banco e das fotos pelo gerente.

Tabelas extras: `redefinicoes`, `modelos`, `alertas_prazo`, `rotinas_estado`.

## Novidades da v1.4.0

- `/privacidade.html` (política de privacidade) preenchida por `PRIVACY_*`.
- Painel: baixar dados do titular, anonimizar e excluir ocorrência; retenção automática opcional (`RETENCAO_MESES`).
- Equipe: registro de atividades (logins, trocas de senha, exclusões) com alertas no Telegram.
- Minha conta: aviso por e-mail de ocorrência nova e prazos.

Tabelas extras: `registro`, `ml_ignorados`; colunas `ocorrencias.anonimizada` e `usuarios.avisar_email`.

## Novidades da v1.5.0

Reclamações do Mercado Livre mostram a foto, o título, o SKU e o link do anúncio do produto comprado (e uma miniatura na lista). As fotos ficam em `/data/produtos`. Sem variável nova.

## Novidades da v1.6.0

- **Cliente responde pela consulta**: na página do protocolo, o cliente escreve e anexa fotos (até 15 por atendimento). A mensagem aparece no histórico do painel como "Cliente escreveu", reabre o atendimento que estava aguardando o cliente ou resolvido e avisa no Telegram e por e-mail.
- **Desfecho e custo** de cada ocorrência (reembolso, reenvio, troca, cupom…), com gráfico e custo total na aba Números.
- **Pesquisa de satisfação**: algumas horas depois de resolvida, o cliente do formulário recebe um e-mail para dar nota de 1 a 5 (`/avaliar.html`). Nota 1 ou 2 avisa no Telegram. Variáveis `PESQUISA_SATISFACAO` e `PESQUISA_HORAS`.
- **Exportar CSV** da lista com os filtros aplicados (abre no Excel).
- **Testes automáticos** (`npm test`), rodados no GitHub antes de publicar a imagem.

Tabela extra: `pesquisas`; colunas `ocorrencias.desfecho`, `ocorrencias.custo_centavos`, `ocorrencias.resolvida_em` e `eventos.do_cliente`.
