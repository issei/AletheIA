/**
 * AletheIA — services/ws-connection/src/ConnectFunction.js
 * --------------------------------------------------------
 * Handler para rota **$connect** do API Gateway WebSocket.
 * Registra a conexão no DynamoDB (idempotente), associa usuário/conversa,
 * e emite métricas de conexão.
 *
 * ENV esperadas:
 * - TABLE_CONNECTIONS           (obrigatória) — tabela DDB de conexões
 * - CONNECTION_TTL_MINUTES      (opcional) — TTL em minutos (default: 180)
 * - LOG_LEVEL                   (opcional) — INFO|DEBUG|WARN|ERROR
 *
 * Observações:
 * - Autenticação/autorização devem ocorrer por **(Custom) Authorizer** no API GW.
 *   Aqui apenas lemos `event.requestContext.authorizer` para metadados (principalId/claims).
 */

import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

const ENV = {
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  table: process.env.TABLE_CONNECTIONS,
  ttlMinutes: parseInt(process.env.CONNECTION_TTL_MINUTES || '180', 10),
}

// ---------------- logger ----------------
const logger = (() => {
  const order = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
  const enabled = (lvl) => order[lvl] >= order[ENV.logLevel]
  const base = (level, o) => console.log(JSON.stringify({ level, svc: 'ws-connect', at: new Date().toISOString(), ...o }))
  return { debug: (o) => enabled('DEBUG') && base('DEBUG', o), info: (o) => enabled('INFO') && base('INFO', o), warn: (o) => enabled('WARN') && base('WARN', o), error: (o) => base('ERROR', o) }
})()

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

const ttlEpoch = (min) => Math.floor(Date.now() / 1000) + Math.max(1, min) * 60
const nowIso = () => new Date().toISOString()

export const handler = async (event) => {
  if (!ENV.table) {
    logger.error({ msg: 'env.missing', table: ENV.table })
    return { statusCode: 500, body: 'env missing' }
  }

  const { connectionId, requestTimeEpoch } = event?.requestContext || {}
  if (!connectionId) return { statusCode: 400, body: 'missing connectionId' }

  // Metadados úteis
  const qs = event?.queryStringParameters || {}
  const headers = normalizeHeaders(event?.headers)
  const authorizer = event?.requestContext?.authorizer || {}

  const conversationId = qs.correlationId || qs.conversationId || authorizer?.conversationId || `conv-${randomUUID()}`
  const userId = authorizer?.principalId || qs.userId || 'anonymous'
  const ip = event?.requestContext?.identity?.sourceIp || headers['x-forwarded-for'] || null
  const userAgent = headers['user-agent'] || null

  // Item de conexão (idempotente)
  const item = {
    pk: `CONN#${connectionId}`,
    sk: 'CONNECTION',
    type: 'connection',
    connectionId,
    conversationId,
    userId,
    status: 'CONNECTED',
    connectedAt: nowIso(),
    requestTimeEpoch: requestTimeEpoch || Date.now(),
    userAgent,
    ip,
    gsi1pk: `CONV#${conversationId}`,
    gsi1sk: `CONN#${connectionId}`,
    gsi2pk: `USER#${userId}`,
    gsi2sk: `CONN#${connectionId}`,
    ttl: ttlEpoch(ENV.ttlMinutes),
  }

  try {
    await ddb.send(new PutCommand({
      TableName: ENV.table,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
    }))
    logger.info({ msg: 'connected', connectionId, conversationId, userId })
    emitEmf({ Connected: 1, Errors: 0 })
    return { statusCode: 200, body: 'OK' }
  } catch (err) {
    // Se a conexão já existir, tratamos como idempotente
    if (err?.name === 'ConditionalCheckFailedException') {
      logger.warn({ msg: 'idempotent_hit', connectionId })
      emitEmf({ Connected: 0, Errors: 0 })
      return { statusCode: 200, body: 'OK' }
    }
    logger.error({ msg: 'connect.error', err: String(err?.message || err), connectionId })
    emitEmf({ Connected: 0, Errors: 1 })
    return { statusCode: 500, body: 'error' }
  }
}

function normalizeHeaders(h) {
  const o = {}
  for (const k of Object.keys(h || {})) o[k.toLowerCase()] = h[k]
  return o
}

function emitEmf({ Connected, Errors }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'AletheIA', Dimensions: [['Service']], Metrics: [
          { Name: 'Connected', Unit: 'Count' },
          { Name: 'Errors', Unit: 'Count' }
        ]}
      ]
    },
    Service: 'ws-connect',
    Connected: Connected ?? 0,
    Errors: Errors ?? 0,
  }
  console.log(JSON.stringify(emf))
}
