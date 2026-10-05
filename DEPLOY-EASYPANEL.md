# Deploy no Easypanel — Central de Ocorrências v1.0.5

Alvo: VPS da MCS, projeto **mcs** do Easypanel, endereço **https://atendimento.mcs.ind.br**
(o DNS `*.mcs.ind.br` já aponta para o VPS, então não é preciso criar registro).

## 1. Repositório e imagem (uma vez)

1. Crie um repositório privado no GitHub (ex.: `mcs-ocorrencias`) e suba o conteúdo desta pasta (sem `node_modules`, `dist`, `.env`).
2. O workflow `.github/workflows/docker.yml` roda sozinho a cada push na `main` e publica `ghcr.io/<usuario>/mcs-ocorrencias:latest` e `:1.0.5`. Confira em **Actions** que terminou verde.
3. Em **Packages** do GitHub, se o repositório for privado, o Easypanel precisa de credencial para baixar a imagem (a mesma que você configurou para o ml-actions serve). Se preferir, deixe o pacote público: a imagem não contém segredos, eles entram só por variáveis de ambiente.

## 2. Criar o serviço no Easypanel

Projeto **mcs** → **+ Serviço** → **App**, nome `mcs-ocorrencias`.

| Campo | Valor |
|---|---|
| Fonte | Imagem Docker: `ghcr.io/<usuario>/mcs-ocorrencias:1.0.5` (fixe a versão em vez de `latest`, assim você sabe o que está rodando) |
| Domínio | `atendimento.mcs.ind.br`, porta **3000**, HTTPS ligado (Let's Encrypt automático) |
| Volume | Tipo *Volume*, nome `ocorrencias-data`, caminho de montagem **`/data`** |
| Réplicas | **1** (o banco é SQLite; não escale para mais de uma) |

**O volume é obrigatório.** Sem ele, o banco e as fotos somem a cada novo deploy.

## 3. Variáveis de ambiente

```
PORT=3000
PUBLIC_URL=https://atendimento.mcs.ind.br
TRUST_PROXY=1
DATA_DIR=/data
BRAND_NAME=MCS Brasil
PROTOCOL_PREFIX=MCS
IP_SALT=<gere um texto aleatório longo>
SUPPORT_EMAIL=atendimento@mcs.ind.br
PRIVACY_URL=<link da política de privacidade>

TELEGRAM_BOT_TOKEN=<mesmo bot do Gerente, ou um bot novo>
TELEGRAM_CHAT_ID=<grupo/chat que recebe os avisos>

SMTP_HOST=mail.mcs.ind.br
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=atendimento@mcs.ind.br
SMTP_PASS=<senha da conta atendimento@mcs.ind.br — digite só no Easypanel>
SMTP_TLS_SERVERNAME=      # deixe vazio; use só se der erro de certificado (veja abaixo)
MAIL_FROM=MCS Brasil <atendimento@mcs.ind.br>

TINY_TOKEN=            # veja a observação sobre o Tiny abaixo
```

`TRUST_PROXY=1` faz o limite de envios por IP funcionar certo atrás do Traefik do Easypanel.

### Observações sobre o e-mail (HostGator)
- A porta 465 usa TLS direto, por isso `SMTP_SECURE=true`.
- **Erro de certificado:** em hospedagem compartilhada, o certificado de `mail.mcs.ind.br` às vezes é emitido para o nome do servidor da HostGator (algo como `br123.hostgator.com.br`). Se o log mostrar `Hostname/IP does not match certificate's altnames`, preencha `SMTP_TLS_SERVERNAME` com o nome que aparecer na mensagem de erro. Isso mantém a verificação do certificado ligada, sem precisar desativá-la.
- **Se travar na conexão (timeout):** o VPS pode estar bloqueando a porta 465 de saída. Teste a 587 (`SMTP_PORT=587`, `SMTP_SECURE=false`), que o servidor da HostGator também costuma aceitar.
- A senha da conta fica **só** nas variáveis do Easypanel. Não coloque em arquivo nem no GitHub.
- Para o e-mail não cair no spam, confirme no painel da HostGator (Entrega de e-mail / Email Deliverability) que **SPF e DKIM** de `mcs.ind.br` estão válidos.

### Observação sobre o Tiny
Esta versão consulta o Tiny pela **API v2 com token**. Os serviços da MCS que você está migrando parecem usar a API nova (OAuth, com URL de redirect). Se a conta ainda tiver o token v2, basta preencher `TINY_TOKEN`. Se não tiver, deixe vazio: a central funciona normalmente, só não confirma o pedido no Tiny, e as ocorrências ficam marcadas como "Tiny desligado". A adaptação para OAuth ou para reaproveitar o serviço `tiny-nf` fica para uma próxima versão, depois da virada do Tiny.

## 4. Validar

1. Abra `https://atendimento.mcs.ind.br/healthz`: deve responder `{"ok":true,"versao":"1.0.5"}`.
2. Abra `https://atendimento.mcs.ind.br/?canal=shopee` e registre uma ocorrência de teste com uma foto.
3. Confira: protocolo na tela, aviso no Telegram e e-mail de confirmação (olhe o spam na primeira vez). Se o e-mail não chegar, veja os logs do serviço no Easypanel: a linha começa com `[mail]` e diz o motivo.
4. Consulte o protocolo em `/consulta.html`.
5. **Faça um redeploy** e consulte o mesmo protocolo de novo. Se continuar existindo, o volume está certo.

## 5. Backup

Inclua o volume `ocorrencias-data` na rotina de backup do VPS (banco `ocorrencias.db` + pasta `uploads`).

## 6. Divulgação

- Gere um QR code por canal: `https://atendimento.mcs.ind.br/?canal=mercado_livre`, `…=shopee`, `…=tiktok_shop`, `…=loja_propria`.
- Coloque um link "Central de Ocorrências" no rodapé de `mcs.ind.br`.
- Lembre-se: não envie esse link dentro das mensagens do Mercado Livre ou da Shopee.

## Atualizar depois

Suba a nova versão no GitHub, espere o Actions publicar, troque a tag da imagem no Easypanel e faça o deploy. O volume preserva os dados.
