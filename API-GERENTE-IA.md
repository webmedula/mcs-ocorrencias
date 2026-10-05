# API do Gerente IA — Central de Ocorrências v1.1.0

Documento para configurar o serviço **mcs-gerente** (ou qualquer automação) para consultar a Central.

## Acesso

1. Entre no painel como **gerente** → aba **Equipe** → **Chaves do Gerente IA** → *Gerar chave*.
2. Copie a chave (`mcsia_…`). Ela aparece **uma única vez**. Guarde como variável de ambiente do serviço que vai usá-la, por exemplo `OCORRENCIAS_API_KEY`.
3. Toda chamada leva o cabeçalho `Authorization: Bearer <chave>`.
4. Para cortar o acesso, use **Revogar** na mesma tela: vale na hora.

Base: `https://atendimento.mcs.ind.br/api/admin`

## O que a chave permite

| Ação | Rota | Chave IA |
|---|---|---|
| Listar / buscar ocorrências | `GET /ocorrencias?q=&canal=&status=&pagina=` | sim |
| Ler uma ocorrência (relato, dados do Tiny, histórico) | `GET /ocorrencias/{protocolo}` | sim |
| Mudar status | `PATCH /ocorrencias/{protocolo}/status` `{"status":"em_analise"}` | sim |
| Anotar (nota interna, o cliente não vê) | `POST /ocorrencias/{protocolo}/notas` `{"texto":"…"}` | sim |
| Responder o cliente (envia e-mail) | `POST /ocorrencias/{protocolo}/resposta` | **não** |
| Ver fotos | `GET /anexos/{id}` | **não** |
| Equipe e chaves | `/usuarios`, `/chaves` | **não** |

Tudo que a chave faz fica no histórico com o autor **Gerente IA**.

Valores de `status`: `nova`, `em_analise`, `aguardando_cliente`, `resolvida`.
Valores de `canal`: `mercado_livre`, `shopee`, `tiktok_shop`, `loja_propria`.

A mudança de status aparece para o cliente na consulta ("Status atualizado: …"). Notas internas nunca aparecem.

## Exemplos

```bash
# ocorrências novas
curl -s -H "Authorization: Bearer $OCORRENCIAS_API_KEY" \
  "https://atendimento.mcs.ind.br/api/admin/ocorrencias?status=nova"

# detalhe
curl -s -H "Authorization: Bearer $OCORRENCIAS_API_KEY" \
  "https://atendimento.mcs.ind.br/api/admin/ocorrencias/MCS-20261005-7VTHZU"

# colocar em análise
curl -s -X PATCH -H "Authorization: Bearer $OCORRENCIAS_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"em_analise"}' \
  "https://atendimento.mcs.ind.br/api/admin/ocorrencias/MCS-20261005-7VTHZU/status"

# anotar
curl -s -X POST -H "Authorization: Bearer $OCORRENCIAS_API_KEY" -H "Content-Type: application/json" \
  -d '{"texto":"Resumo: cliente aguarda reenvio."}' \
  "https://atendimento.mcs.ind.br/api/admin/ocorrencias/MCS-20261005-7VTHZU/notas"
```

A lista devolve `{ itens, total, pagina, porPagina, contagem }`, com 25 itens por página e `contagem` por status. O detalhe devolve os dados do cliente, `tiny` (pedido encontrado, quando houver), `anexos` (só metadados) e `eventos` (`publico` 1 = o cliente vê; `autor` = quem fez).

## Dados pessoais

As respostas trazem nome, e-mail e telefone dos clientes (LGPD). Use a chave só em serviços seus, nunca a coloque em código público e revogue se houver suspeita de vazamento.
