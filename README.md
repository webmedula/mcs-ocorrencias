# Central de Ocorrências — v1.0.4

Página única de reclamações para vários canais de venda: **Mercado Livre, Shopee, TikTok Shop e loja própria**.
O cliente registra o problema, recebe um **protocolo** por e-mail e pode acompanhar o status. Você recebe o aviso no **Telegram** com os dados do pedido vindos do **Tiny**.

> Versão atual: **1.0.4** (guia de deploy no Easypanel: `DEPLOY-EASYPANEL.md`) (veja `CHANGELOG.md`). O painel interno de triagem fica para a v1.1.0.

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

## Próxima versão (v1.1.0)

Painel interno com login: lista e filtros por canal/status, ver fotos e dados do Tiny, mudar status, notas internas e mensagem pública ao cliente (com e-mail automático).
