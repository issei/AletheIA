/**
 * AletheIA — services/ws-connection/src/WebSocketResponder.js
 * -----------------------------------------------------------
 * Publica **uma** mensagem no canal WebSocket (API Gateway Management API).
 * Usado pela orquestração/Step Functions para enviar mensagens "system" ou erros.
 *
 * ENV/Parâmetros de endpoint (prioridade):
 * 1) event.wsEndpoint (ex.: https://abc.execute-api.us-east-1.amazonaws.com/prod)
 * 2) ENV.WS_ENDPOINT
 * 3) event.requestContext.{domainName,stage}
 */

import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

const ENV = { logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(), wsEndpoint: process.env.WS_ENDPOINT || '' }

const logger = (() => {
  const order = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
  const enabled = (lvl) => order[lvl] >= order[ENV.logLevel]
  const base = (level, o) => console.log(JSON.stringify({ level, svc: 'ws-responder', at: new Date().toISOString(), ...o }))
  return { debug: (o) => enabled('DEBUG') && base('DEBUG', o), info: (o) => enabled('INFO') && base('INFO', o), warn: (o) => enabled('WARN') && base('WARN', o), error: (o) => base('ERROR', o) }
})()

export const handler = async (event) => {
  const input = typeof event?.body === 'string' ? safeJsonParse(event.body) : (event || {})
  const connectionId = input.connectionId || event?.requestContext?.connectionId
  if (!connectionId) return http(400, { ok: false, error: 'missing_connectionId' })

  const endpoint = pickEndpoint(input, event)
  if (!endpoint) return http(500, { ok: false, error: 'endpoint_unavailable' })

  const client = new ApiGatewayManagementApiClient({ endpoint })

  const payload = {
    messageType: input.messageType || 'system',
    messageId: input.messageId || cryptoRandom(),
    correlationId: input.correlationId,
    role: input.role || 'system',
    sequence: Number.isFinite(input.sequence) ? input.sequence : 0,
    chunkIndex: Number.isFinite(input.chunkIndex) ? input.chunkIndex : 0,
    isFinal: Boolean(input.isFinal),
    payload: input.payload || { text: '' },
  }

  try {
    await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(payload)) }))
    logger.info({ msg: 'posted', connectionId, endpoint, type: payload.messageType })
    emitEmf({ Posted: 1, Errors: 0 })
    return http(200, { ok: true })
  } catch (err) {
    const gone = err?.$metadata?.httpStatusCode === 410
    logger[ gone ? 'warn' : 'error' ]({ msg: gone ? 'gone' : 'post.error', connectionId, endpoint, err: String(err?.message || err) })
    emitEmf({ Posted: 0, Errors: 1 })
    return http(gone ? 410 : 500, { ok: false, error: gone ? 'gone' : 'post_failed' })
  }
}

function pickEndpoint(input, event) {
  if (typeof input?.wsEndpoint === 'string' && input.wsEndpoint) return input.wsEndpoint
  if (ENV.wsEndpoint) return ENV.wsEndpoint
  const dn = event?.requestContext?.domainName
  const st = event?.requestContext?.stage
  if (dn && st) return `https://${dn}/${st}`
  return ''
}

function http(statusCode, body) { return { statusCode, body: JSON.stringify(body) } }
function safeJsonParse(s) { try { return JSON.parse(s) } catch { return null } }
function cryptoRandom() { return Math.random().toString(36).slice(2) + Date.now().toString(36) }

function emitEmf({ Posted, Errors }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'AletheIA', Dimensions: [['Service']], Metrics: [
          { Name: 'Posted', Unit: 'Count' },
          { Name: 'Errors', Unit: 'Count' }
        ]}
      ]
    },
    Service: 'ws-responder',
    Posted: Posted ?? 0,
    Errors: Errors ?? 0,
  }
  console.log(JSON.stringify(emf))
}
