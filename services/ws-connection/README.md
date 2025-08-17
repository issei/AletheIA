# ws-connection (API Gateway WebSocket)

Handlers de **conexão WebSocket** da AletheIA:

* **`$connect` → `ConnectFunction.js`**: registra a conexão no DynamoDB com idempotência e metadados.
* **`$disconnect` → `disconnectWS.js`**: marca a conexão como encerrada.
* **`WebSocketResponder.js`**: publica **uma** mensagem no canal WebSocket (usado por Step Functions e outras Lambdas).

> O streaming da resposta do LLM é realizado pelo serviço **chat-stream**; aqui tratamos **conexão**, **desconexão** e **mensagens avulsas** (ex.: avisos de sistema, erros, progresso).

---

## 📦 Estrutura

```
services/ws-connection/
├─ README.md
├─ package.json
├─ lambda.manifest.json
└─ src/
   ├─ ConnectFunction.js      # $connect
   ├─ disconnectWS.js         # $disconnect
   └─ WebSocketResponder.js   # publisher (PostToConnection)
```

---

## ⚙️ Variáveis de ambiente

### Comuns

| Nome        | Descrição                        | Padrão |
| ----------- | -------------------------------- | ------ |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |

### `ConnectFunction`

| Nome                     | Descrição                           | Obrigatório | Padrão |
| ------------------------ | ----------------------------------- | ----------: | ------ |
| `TABLE_CONNECTIONS`      | Nome da tabela DynamoDB de conexões |           ✓ | —      |
| `CONNECTION_TTL_MINUTES` | TTL (min) para expiração automática |             | `180`  |

### `disconnectWS`

| Nome                | Descrição                   | Obrigatório |
| ------------------- | --------------------------- | ----------: |
| `TABLE_CONNECTIONS` | Tabela DynamoDB de conexões |           ✓ |

### `WebSocketResponder`

| Nome          | Descrição                                   | Obrigatório | Observações                                                        |
| ------------- | ------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `WS_ENDPOINT` | Endpoint HTTP do API Gateway Management API |             | Pode ser omitido; o código tenta deduzir de `event.requestContext` |

> **Endpoint do Management API** é **HTTP** (não WSS). Ex.: `https://abc.execute-api.us-east-1.amazonaws.com/prod`.

---

## 🗃️ DynamoDB — Tabela `TABLE_CONNECTIONS`

**Chaves**

* `pk = CONN#<connectionId>`
* `sk = CONNECTION`

**Atributos** (principais)

* `connectionId`, `conversationId`, `userId`, `status`, `connectedAt`, `disconnectedAt`, `updatedAt`, `ip`, `userAgent`.
* **GSI #1**: `gsi1pk = CONV#<conversationId>`, `gsi1sk = CONN#<connectionId>` → listar conexões por conversa.
* **GSI #2**: `gsi2pk = USER#<userId>`, `gsi2sk = CONN#<connectionId>` → listar conexões por usuário.
* **TTL**: atributo `ttl` (epoch seconds) — controlado por `CONNECTION_TTL_MINUTES`.

Sugestão de capacidade: `PAY_PER_REQUEST` durante desenvolvimento; avalie provisionado quando estabilizar o tráfego.

---

## 🔌 Contratos & uso

### `$connect` → **payload de entrada (API Gateway)**

`ConnectFunction` usa apenas metadados do contexto e (opcionalmente) query string:

```http
GET wss://<ws-id>.execute-api.<region>.amazonaws.com/prod?correlationId=conv-123&userId=u-42
```

* `connectionId` vem de `event.requestContext.connectionId`.
* `conversationId` (correlationId) é extraído de `queryStringParameters`, ou do **Authorizer** (quando houver), ou gerado (`conv-<uuid>`).
* Registra item idempotente no DDB; se já existir, trata como sucesso.

### `$disconnect`

`disconnectWS` marca o item como `DISCONNECTED` (se não existir, retorna 200 e registra `NotFound`).

### **Publicação avulsa** (Step Functions/Lambda) → `WebSocketResponder`

Entrada (exemplo):

```json
{
  "connectionId": "abc123=",
  "messageType": "system",
  "correlationId": "conv-123",
  "sequence": 21,
  "isFinal": false,
  "payload": { "text": "Processando…" },
  "wsEndpoint": "https://abc.execute-api.us-east-1.amazonaws.com/prod"
}
```

* Prioridade do endpoint: `event.wsEndpoint` → `ENV.WS_ENDPOINT` → `requestContext.domainName/stage`.
* Respostas HTTP:

  * `200` sucesso; `410` conexão **GONE**; `500` falha genérica.

---

## 🔒 IAM (permissões mínimas)

### `ConnectFunction`

* `dynamodb:PutItem` na `TABLE_CONNECTIONS`.
* (Opcional) `dynamodb:UpdateItem`/`GetItem` se expandir a lógica.

### `disconnectWS`

* `dynamodb:UpdateItem` na `TABLE_CONNECTIONS`.

### `WebSocketResponder`

* `execute-api:ManageConnections` no **Management API** do seu WebSocket.

> Garanta **least privilege**: restrinja por **ARN** da tabela e do **WebSocket API**.

---

## 📈 Observabilidade

* **Logs** JSON estruturados com campos `svc`, `level`, `at`, `connectionId`, etc.
* **EMF (CloudWatch)**:

  * `ws-connect`: `Connected`, `Errors`
  * `ws-disconnect`: `Disconnected`, `NotFound`, `Errors`
  * `ws-responder`: `Posted`, `Errors`

---

## 🧪 Testes locais

### Simular `$connect`/`$disconnect` com SAM

```bash
sam local invoke ConnectFunction --event events/connect.json
sam local invoke disconnectWS    --event events/disconnect.json
```

### PostToConnection manual (AWS CLI)

```bash
aws apigatewaymanagementapi post-to-connection \
  --endpoint-url https://abc.execute-api.us-east-1.amazonaws.com/prod \
  --connection-id abc123= \
  --data '{"messageType":"system","payload":{"text":"ping"}}'
```

---

## 🛠️ Build & Deploy

* Empacote com o **builder** do repositório:

```bash
scripts/build-lambda.sh --service services/ws-connection --mode bundle
```

* Saída em `dist/lambdas/ws-connection/<Função>/<Função>.zip` + SHA256.
* **Terraform** referencia os zips (ver `infra/terraform`).
* **GitHub Actions**: `ci.yml` instala deps e (se houver) roda lint/test/build; `tf-apply.yml` aplica infra por ambiente via OIDC.

---

## 🔐 Segurança & boas práticas

* Use **Authorizer** (JWT/Cognito/Custom) no WebSocket; preencha `principalId` e restrinja quem pode conectar.
* Não logue **segredos** nem PII; se necessário, anonimize IP/UA.
* Habilite **WAF** no API WebSocket quando aplicável.
* Revise limites de **throttling** e **rate limiting** por IP/usuário.

---

## ❓ Troubleshooting

* **410 Gone** ao publicar: conexão cliente encerrou; limpe registros órfãos quando conveniente.
* **AccessDenied** no `ManageConnections`: verifique a **policy** da role Lambda (ARN correto do WebSocket API).
* Mensagens não chegam: confira `endpoint` resolvido (precisa ser o **HTTPS** do **Management API**, não o WSS público do cliente).

---

## 📜 Referências cruzadas

* `services/chat-stream/` — streaming e geração LLM.
* `services/orchestration/` — Step Functions e publicação de mensagens sistêmicas.
* `scripts/build-lambda.sh` — builder universal de artefatos.
