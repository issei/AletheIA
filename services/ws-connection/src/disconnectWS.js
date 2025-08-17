/**
 * AletheIA — services/ws-connection/src/disconnectWS.js
 * ----------------------------------------------------
 * Handler para rota **$disconnect** do API Gateway WebSocket.
 * Marca a conexão como desconectada no DynamoDB (ou ignora se não existir).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const ENV = {
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  table: process.env.TABLE_CONNECTIONS,
}

const logger = (() => {
  const order = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
  const enabled = (lvl) => order[lvl] >= order[ENV.logLevel]
  const base = (level, o) => console.log(JSON.stringify({ level, svc: 'ws-disconnect', at: new Date().toISOString(), ...o }))
  return { debug: (o) => enabled('DEBUG') && base('DEBUG', o), info: (o) => enabled('INFO') && base('INFO', o), warn: (o) => enabled('WARN') && base('WARN', o), error: (o) => base('ERROR', o) }
})()

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

export const handler = async (event) => {
  if (!ENV.table) {
    logger.error({ msg: 'env.missing', table: ENV.table })
    return { statusCode: 500, body: 'env missing' }
  }
  const connectionId = event?.requestContext?.connectionId
  if (!connectionId) return { statusCode: 400, body: 'missing connectionId' }

  try {
    await ddb.send(new UpdateCommand({
      TableName: ENV.table,
      Key: { pk: `CONN#${connectionId}`, sk: 'CONNECTION' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
      UpdateExpression: 'SET #status = :disc, #discAt = :now, #updated = :now',
      ExpressionAttributeNames: { '#status': 'status', '#discAt': 'disconnectedAt', '#updated': 'updatedAt' },
      ExpressionAttributeValues: { ':disc': 'DISCONNECTED', ':now': new Date().toISOString() },
      ReturnValues: 'NONE'
    }))
    logger.info({ msg: 'disconnected', connectionId })
    emitEmf({ Disconnected: 1, NotFound: 0, Errors: 0 })
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // item não existia — tratar como desconectado
      logger.warn({ msg: 'disconnect.not_found', connectionId })
      emitEmf({ Disconnected: 0, NotFound: 1, Errors: 0 })
    } else {
      logger.error({ msg: 'disconnect.error', err: String(err?.message || err), connectionId })
      emitEmf({ Disconnected: 0, NotFound: 0, Errors: 1 })
      return { statusCode: 500, body: 'error' }
    }
  }
  return { statusCode: 200, body: 'OK' }
}

function emitEmf({ Disconnected, NotFound, Errors }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'AletheIA', Dimensions: [['Service']], Metrics: [
          { Name: 'Disconnected', Unit: 'Count' },
          { Name: 'NotFound', Unit: 'Count' },
          { Name: 'Errors', Unit: 'Count' }
        ]}
      ]
    },
    Service: 'ws-disconnect',
    Disconnected: Disconnected ?? 0,
    NotFound: NotFound ?? 0,
    Errors: Errors ?? 0,
  }
  console.log(JSON.stringify(emf))
}
