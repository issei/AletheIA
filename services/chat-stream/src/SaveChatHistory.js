/**
 * AletheIA — services/chat-stream/src/SaveChatHistory.js
 * ------------------------------------------------------
 * Persiste mensagens de conversa no DynamoDB com **idempotência** e ordenação.
 *
 * Suporta salvar mensagens **user** e **assistant** (geralmente chamada quando `isFinal=true`).
 * Atualiza o item de **conversa** (lastActivityAt/lastSequence) e emite métricas EMF.
 *
 * Tabelas (por ENV):
 * - TABLE_MESSAGES       : tabela de mensagens (PK/SK, GSI por messageId)
 * - TABLE_CONVERSATIONS  : tabela de conversas (um item por conversa)
 *
 * Chaves (mensagens):
 *   pk = `CONV#<conversationId>`
 *   sk = `SEQ#<sequence(12)>#MSG#<messageId>`   // zero‑pad para ordenação lexicográfica
 *   gsi1pk = `MSG#<messageId>`
 *   gsi1sk = `CONV#<conversationId>`
 *
 * ENV esperadas
 * - LOG_LEVEL
 * - TABLE_MESSAGES, TABLE_CONVERSATIONS
 * - MESSAGE_TTL_DAYS (opcional)
 */

import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const ENV = {
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  tableMessages: process.env.TABLE_MESSAGES,
  tableConvs: process.env.TABLE_CONVERSATIONS,
  ttlDays: parseInt(process.env.MESSAGE_TTL_DAYS || '0', 10),
}

// -------------------------- logger ------------------------------------------
const logger = (() => {
  const should = (lvl) => ({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }[lvl] >= ({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }[ENV.logLevel]))
  const base = (level, obj) => console.log(JSON.stringify({ level, svc: 'save-chat-history', at: new Date().toISOString(), ...obj }))
  return { debug: (o) => should('DEBUG') && base('DEBUG', o), info: (o) => should('INFO') && base('INFO', o), warn: (o) => should('WARN') && base('WARN', o), error: (o) => base('ERROR', o) }
})()

const safeJsonParse = (s) => { try { return JSON.parse(s) } catch { return null } }

// -------------------------- ddb client --------------------------------------
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

const pad = (n, w = 12) => String(Math.max(0, Number(n) || 0)).padStart(w, '0')
const nowIso = () => new Date().toISOString()
const ttlEpoch = (days) => days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : undefined

// -------------------------- validação ---------------------------------------
function normalizeMessage(m) {
  const out = { ...m }
  out.messageId = out.messageId || randomUUID()
  out.correlationId = out.correlationId || out.conversationId || `conv-${randomUUID()}`
  out.conversationId = out.correlationId
  out.sequence = Number.isFinite(out.sequence) ? out.sequence : 0
  out.role = out.role || (out.messageType === 'user' ? 'user' : 'assistant')
  out.text = out.text || out?.payload?.text || ''
  out.isFinal = Boolean(out.isFinal)
  out.model = out.model || m?.model
  if (!out.text || !out.conversationId) {
    throw new Error('mensagem inválida: requer {conversationId, text}')
  }
  return out
}

// -------------------------- persistência ------------------------------------
async function saveOneMessage(m) {
  const message = normalizeMessage(m)
  const pk = `CONV#${message.conversationId}`
  const sk = `SEQ#${pad(message.sequence)}#MSG#${message.messageId}`

  const item = {
    pk, sk,
    type: 'message',
    gsi1pk: `MSG#${message.messageId}`,
    gsi1sk: `CONV#${message.conversationId}`,
    conversationId: message.conversationId,
    messageId: message.messageId,
    role: message.role,
    sequence: message.sequence,
    isFinal: message.isFinal,
    text: message.text,
    usage: message.usage || null,
    costEstimateUSD: message.costEstimateUSD ?? null,
    provider: message.provider || null,
    model: message.model || null,
    promptSource: message.promptSource || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ttl: ttlEpoch(ENV.ttlDays),
  }

  // Idempotência: put condicional; se colidir, tratamos como sucesso idempotente.
  try {
    await ddb.send(new PutCommand({
      TableName: ENV.tableMessages,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
    }))
    logger.info({ msg: 'message.saved', conversationId: message.conversationId, messageId: message.messageId, sequence: message.sequence })
  } catch (err) {
    // ConditionalCheckFailedException → já existe; consideramos idempotente
    if (err?.name === 'ConditionalCheckFailedException') {
      logger.warn({ msg: 'message.idempotent_hit', conversationId: message.conversationId, messageId: message.messageId })
    } else {
      throw err
    }
  }

  // Atualiza conversa (lastActivityAt, lastSequence, counters por role)
  const update = new UpdateCommand({
    TableName: ENV.tableConvs,
    Key: { pk: `CONV#${message.conversationId}`, sk: 'CONVERSATION' },
    UpdateExpression: [
      'SET #type = if_not_exists(#type, :type),',
      '#lastAt = :now,',
      '#lastSeq = if_not_exists(#lastSeq, :neg1)',
      '      <setMaxSeq>',
      '#countTotal = if_not_exists(#countTotal, :zero) + :one,',
      message.role === 'user' ? '#countUser = if_not_exists(#countUser, :zero) + :one,' : '#countAssistant = if_not_exists(#countAssistant, :zero) + :one,',
      '#updatedAt = :now'
    ].join(' ')
    .replace('<setMaxSeq>', ''),
    ExpressionAttributeNames: {
      '#type': 'type',
      '#lastAt': 'lastActivityAt',
      '#lastSeq': 'lastSequence',
      '#countTotal': 'messages',
      '#countUser': 'userMessages',
      '#countAssistant': 'assistantMessages',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':type': 'conversation',
      ':now': nowIso(),
      ':neg1': -1,
      ':zero': 0,
      ':one': 1,
    },
  })
  await ddb.send(update).catch((e) => logger.warn({ msg: 'conversation.update.warn', conversationId: message.conversationId, err: String(e?.message || e) }))

  return { ok: true, messageId: message.messageId }
}

// -------------------------- EMF ---------------------------------------------
function emitEmf({ Saved, IdempotentHits, Count, RoleUser, RoleAssistant, SaveTimeMs }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'AletheIA',
          Dimensions: [['Service']],
          Metrics: [
            { Name: 'Saved', Unit: 'Count' },
            { Name: 'IdempotentHits', Unit: 'Count' },
            { Name: 'Count', Unit: 'Count' },
            { Name: 'RoleUser', Unit: 'Count' },
            { Name: 'RoleAssistant', Unit: 'Count' },
            { Name: 'SaveTimeMs', Unit: 'Milliseconds' },
          ],
        },
      ],
    },
    Service: 'save-chat-history',
    Saved: Saved ?? 0,
    IdempotentHits: IdempotentHits ?? 0,
    Count: Count ?? 0,
    RoleUser: RoleUser ?? 0,
    RoleAssistant: RoleAssistant ?? 0,
    SaveTimeMs: SaveTimeMs ?? 0,
  }
  console.log(JSON.stringify(emf))
}

// -------------------------- handler -----------------------------------------
export const handler = async (event) => {
  const t0 = Date.now()
  if (!ENV.tableMessages || !ENV.tableConvs) {
    logger.error({ msg: 'env.missing', tableMessages: ENV.tableMessages, tableConvs: ENV.tableConvs })
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'env_missing' }) }
  }

  const body = typeof event?.body === 'string' ? safeJsonParse(event.body) : (event || {})
  if (!body) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid_payload' }) }

  const messages = Array.isArray(body?.messages) ? body.messages : [body]

  let saved = 0, idem = 0, roleUser = 0, roleAssistant = 0
  for (const m of messages) {
    try {
      const norm = normalizeMessage(m)
      if (norm.role === 'user') roleUser++; else roleAssistant++
      const res = await saveOneMessage(norm)
      if (res?.ok) saved++
    } catch (err) {
      if (String(err?.name) === 'ConditionalCheckFailedException') { idem++ } else {
        logger.error({ msg: 'save.error', err: String(err?.message || err), messageId: m?.messageId, conversationId: m?.correlationId || m?.conversationId })
        // continua salvando demais mensagens
      }
    }
  }

  emitEmf({ Saved: saved, IdempotentHits: idem, Count: messages.length, RoleUser: roleUser, RoleAssistant: roleAssistant, SaveTimeMs: Date.now() - t0 })
  return { statusCode: 200, body: JSON.stringify({ ok: true, saved }) }
}
