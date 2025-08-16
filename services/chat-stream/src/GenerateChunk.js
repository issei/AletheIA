/**
 * AletheIA — services/chat-stream/src/GenerateChunk.js
 * ----------------------------------------------------
 * Lambda invocada pela rota WebSocket `$default` do API Gateway.
 *
 * Responsabilidades
 * - Montar requisição ao LLM (OpenAI via HTTP streaming OU Bedrock Runtime streaming).
 * - Transmitir chunks de resposta ao cliente (WS) preservando ordem: (sequence, chunkIndex).
 * - Marcar mensagem final (isFinal=true) com metadados (usage/custos quando disponíveis).
 * - Telemetria: logs JSON estruturados + EMF (TTFT, Chunks, OutputChars, Error=0/1, CostEstimateUSD).
 * - Tolerância a falhas: retries exponenciais para chamadas de LLM e envio WS.
 * - Sem segredos no código: chaves lidas de AWS Secrets Manager/SSM ou ENV.
 *
 * Variáveis de ambiente esperadas
 * - LLM_PROVIDER                : "openai" | "bedrock" (default: "openai")
 * - MODEL_ID                    : id do modelo (ex.: gpt-4o-mini | anthropic.claude-3-haiku-20240307)
 * - WS_ENDPOINT                 : (opcional) wss/https do API GW; se ausente, monta via event.requestContext
 * - OPENAI_API_KEY              : (opcional) chave direta; preferir OPENAI_SECRET_ID em Secrets Manager
 * - OPENAI_SECRET_ID            : (opcional) nome/id do segredo contendo {"apiKey":"...", "baseUrl":"..."}
 * - OPENAI_BASE_URL             : (opcional) override do endpoint (ex.: proxy)
 * - PRICING_INPUT_PER_1K        : (opcional) preço USD/1k tokens input (para estimativa)
 * - PRICING_OUTPUT_PER_1K       : (opcional) preço USD/1k tokens output (para estimativa)
 * - LOG_LEVEL                   : INFO | DEBUG | WARN | ERROR (default: INFO)
 *
 * Contrato de entrada (via WebSocket $default -> event.body JSON)
 * {
 *   "messageType": "user",
 *   "messageId": "uuid",
 *   "correlationId": "conv-uuid",
 *   "sequence": 21,
 *   "payload": { "text": "Explique o erro X" },
 *   "context": { "history": [...], "cursor": 0 }
 * }
 *
 * Contrato de saída (enviado ao WS)
 * {
 *   "messageType": "chunk|final|error",
 *   "messageId": "<gerado>",
 *   "correlationId": "conv-uuid",
 *   "role": "assistant",
 *   "sequence": <number>,
 *   "chunkIndex": <number>,
 *   "isFinal": <boolean>,
 *   "payload": { "text": "...", "usage"?: {"input": nTokensIn, "output": nTokensOut} }
 * }
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { TextDecoder } from 'node:util'

// AWS SDK v3 (importes modulares)
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

// Bedrock Runtime é opcional; carregaremos dinamicamente quando necessário
let BedrockRuntimeClient, InvokeModelWithResponseStreamCommand

// ------------------------- Utilidades -------------------------
const ENV = {
  provider: process.env.LLM_PROVIDER?.toLowerCase() || 'openai',
  model: process.env.MODEL_ID || 'gpt-4o-mini',
  wsEndpoint: process.env.WS_ENDPOINT || '',
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiSecretId: process.env.OPENAI_SECRET_ID || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
  pricingIn: parseFloat(process.env.PRICING_INPUT_PER_1K || '0'),
  pricingOut: parseFloat(process.env.PRICING_OUTPUT_PER_1K || '0'),
}

const logger = (() => {
  const should = (lvl) => {
    const order = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
    return order[lvl] >= order[ENV.logLevel]
  }
  const base = (level, obj) => {
    console.log(JSON.stringify({ level, svc: 'chat-stream', at: new Date().toISOString(), ...obj }))
  }
  return {
    debug: (o) => should('DEBUG') && base('DEBUG', o),
    info: (o) => should('INFO') && base('INFO', o),
    warn: (o) => should('WARN') && base('WARN', o),
    error: (o) => base('ERROR', o),
  }
})()

const safeJsonParse = (s) => { try { return JSON.parse(s) } catch { return null } }

async function withRetry(name, fn, { tries = 3, baseMs = 300, maxMs = 3000 } = {}) {
  let attempt = 0
  for (;;) {
    try { return await fn(attempt) } catch (err) {
      attempt++
      if (attempt >= tries) throw err
      const delay = Math.min(baseMs * 2 ** attempt, maxMs) * (0.5 + Math.random())
      logger.warn({ msg: 'retry', name, attempt, delayMs: Math.round(delay), err: String(err?.message || err) })
      await sleep(delay)
    }
  }
}

// --------------------------- Secrets ---------------------------
const smClient = new SecretsManagerClient({})

async function getOpenAIConfig() {
  if (ENV.openaiSecretId) {
    const data = await smClient.send(new GetSecretValueCommand({ SecretId: ENV.openaiSecretId }))
    const secret = typeof data.SecretString === 'string' ? JSON.parse(data.SecretString) : {}
    return { apiKey: secret.apiKey || ENV.openaiApiKey, baseUrl: secret.baseUrl || ENV.openaiBaseUrl || 'https://api.openai.com' }
  }
  if (ENV.openaiApiKey) return { apiKey: ENV.openaiApiKey, baseUrl: ENV.openaiBaseUrl || 'https://api.openai.com' }
  throw new Error('OPENAI_API_KEY/OPENAI_SECRET_ID não configurado')
}

// --------------------------- WS client ------------------------
function buildWsEndpointFromEvent(event) {
  const { domainName, stage } = event.requestContext || {}
  if (!domainName || !stage) return ''
  return `https://${domainName}/${stage}` // ApiGatewayManagementApi pede HTTPS
}
function wsClientFor(event) {
  const endpoint = ENV.wsEndpoint || buildWsEndpointFromEvent(event)
  if (!endpoint) throw new Error('WS endpoint não disponível')
  return new ApiGatewayManagementApiClient({ endpoint })
}
async function postToWs(client, connectionId, data, { tries = 3 } = {}) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return withRetry('ws-post', async () => {
    try {
      await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(payload) }))
      return true
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 410) { // Gone
        logger.warn({ msg: 'ws.gone', connectionId })
        throw err
      }
      throw err
    }
  }, { tries })
}

// ---------------------------- LLMs ------------------------------------------

/**
 * OpenAI Chat Completions streaming (SSE) — usa fetch nativo (Node 20).
 * Retorna um async generator que produz strings (tokens/trechos).
 */
async function * openaiStream({ model, inputText }) {
  const { apiKey, baseUrl } = await getOpenAIConfig()
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`
  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: 'Você é um assistente investigativo da AletheIA. Responda de forma clara e incremental.' },
      { role: 'user', content: inputText },
    ],
    temperature: 0.2,
    top_p: 0.95,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`openai http ${res.status}: ${text?.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2)
      const line = chunk.trim(); if (!line) continue
      const match = /^data:\s*(.*)$/i.exec(line); if (!match) continue
      const data = match[1]; if (data === '[DONE]') return
      const j = safeJsonParse(data)
      const token = j?.choices?.[0]?.delta?.content || ''
      if (token) yield token
    }
  }
}

/**
 * Bedrock (Anthropic) streaming — InvokeModelWithResponseStream
 * Suporta modelos: anthropic.claude-3-* (mensagens)
 */
async function * bedrockStream({ model, inputText }) {
  if (!BedrockRuntimeClient) {
    const mod = await import('@aws-sdk/client-bedrock-runtime')
    BedrockRuntimeClient = mod.BedrockRuntimeClient
    InvokeModelWithResponseStreamCommand = mod.InvokeModelWithResponseStreamCommand
  }
  const br = new BedrockRuntimeClient({})
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    messages: [ { role: 'user', content: [ { type: 'text', text: inputText } ] } ],
    max_tokens: 1024,
    temperature: 0.2,
    stream: true,
  }
  const cmd = new InvokeModelWithResponseStreamCommand({
    modelId: model, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(payload),
  })
  const resp = await br.send(cmd)
  const stream = resp.body
  // eventos stream: chunk.bytes (Uint8Array) contendo JSON
  const decoder = new TextDecoder()
  for await (const evt of stream) {
    const bytes = evt?.chunk?.bytes; if (!bytes) continue
    const s = decoder.decode(bytes)
    const j = safeJsonParse(s)
    const text = j?.delta?.text || j?.content_block?.text || ''
    if (text) yield text
  }
}
const getStreamForProvider = (p) => (p === 'bedrock' ? bedrockStream : openaiStream)

// ------------------------- Custo/uso (estimativas) ----------
const estimateTokensFromText = (text) => Math.max(1, Math.ceil([...(text || '')].length / 4))
function estimateCostUSD(tokensIn, tokensOut) {
  const inCost = (tokensIn / 1000) * (ENV.pricingIn || 0)
  const outCost = (tokensOut / 1000) * (ENV.pricingOut || 0)
  return +(inCost + outCost).toFixed(6)
}

// ---------------------------- Handler ------------------------
export const handler = async (event) => {
  const tStart = Date.now()
  const connectionId = event?.requestContext?.connectionId
  const ws = wsClientFor(event)

  const input = typeof event.body === 'string' ? safeJsonParse(event.body) : event
  if (!input) throw new Error('payload inválido')

  // Validação mínima
  const messageId = input.messageId || randomUUID()
  const correlationId = input.correlationId || `conv-${randomUUID()}`
  const sequence = Number.isFinite(input.sequence) ? input.sequence : 0
  const text = input?.payload?.text?.toString?.() || ''
  if (!text) throw new Error('payload.payload.text ausente')

  // Preferir prompt preparado quando existir
  const prepared = input.prepared || null
  let promptSource = 'local'
  let prompt
  if (prepared && typeof prepared.composite === 'string' && prepared.composite.trim().length > 0) {
    prompt = prepared.composite
    promptSource = 'prepared'
  } else {
    prompt = buildPrompt({ text, context: input.context })
  }

  const outMsgId = randomUUID()
  const streamFn = getStreamForProvider(ENV.provider)

  let chunkIndex = 0
  let firstTokenAt = 0
  let totalChars = 0
  let aggregated = ''

  logger.info({ msg: 'generate.start', provider: ENV.provider, model: ENV.model, correlationId, messageId, sequence, promptSource })

  try {
    const iterator = await withRetry('llm-stream', async () => streamFn({ model: ENV.model, inputText: prompt }), { tries: 2 })

    for await (const piece of iterator) {
      if (!firstTokenAt) firstTokenAt = Date.now()
      const payload = {
        messageType: 'chunk',
        messageId: outMsgId,
        correlationId,
        role: 'assistant',
        sequence,
        chunkIndex,
        isFinal: false,
        payload: { text: piece },
      }
      await postToWs(ws, connectionId, payload)
      chunkIndex++
      totalChars += piece.length
      aggregated += piece
      logger.debug({ msg: 'chunk.sent', correlationId, messageId: outMsgId, chunkIndex, len: piece.length })
    }

    // Mensagem final
    const tokensOut = estimateTokensFromText(aggregated)
    let tokensIn = estimateTokensFromText(prompt)
    if (prepared?.budget) {
      const approx = (prepared.budget.usedByHistory || 0)
        + estimateTokensFromText(prepared.user || '')
        + estimateTokensFromText(prepared.system || '')
      tokensIn = Math.min(tokensIn, approx || tokensIn)
    }
    const cost = estimateCostUSD(tokensIn, tokensOut)

    const finalPayload = {
      messageType: 'final',
      messageId: outMsgId,
      correlationId,
      role: 'assistant',
      sequence,
      chunkIndex,
      isFinal: true,
      payload: { text: aggregated, usage: { input: tokensIn, output: tokensOut }, costEstimateUSD: cost },
    }
    await postToWs(ws, connectionId, finalPayload)

    // EMF
    emitEmf({
      Model: ENV.model,
      TTFTMs: firstTokenAt ? firstTokenAt - tStart : null,
      Chunks: chunkIndex,
      OutputChars: totalChars,
      Errors: 0,
      CostEstimateUSD: cost,
      PromptSource: promptSource,
    })

    logger.info({ msg: 'generate.done', correlationId, messageId: outMsgId, chunks: chunkIndex, ttftMs: firstTokenAt ? firstTokenAt - tStart : null })
    return { statusCode: 200, body: JSON.stringify({ ok: true }) }
  } catch (err) {
    logger.error({ msg: 'generate.error', correlationId, err: String(err?.message || err) })
    // Tenta sinalizar erro ao cliente (se conexão existir)
    try {
      await postToWs(ws, connectionId, {
        messageType: 'error',
        messageId: outMsgId,
        correlationId,
        role: 'system',
        sequence,
        chunkIndex,
        isFinal: true,
        payload: { text: 'Ocorreu um erro ao gerar a resposta. Tente novamente.' },
      })
    } catch {}
    emitEmf({ Model: ENV.model, TTFTMs: null, Chunks: chunkIndex, OutputChars: totalChars, Errors: 1, CostEstimateUSD: 0, PromptSource: promptSource })
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'generation_failed' }) }
  }
}

// --------------------------- Helpers ---------------------------
function buildPrompt({ text, context }) {
  // Simples; PreparePrompt Lambda pode enriquecer em outra etapa
  const preface = 'Contexto: Você é um agente de investigação da AletheIA. Objetivo: explicar o problema e sugerir próximos passos curtos.'
  const history = Array.isArray(context?.history) ? context.history.slice(-8) : []
  const histStr = history.map((h) => `- ${h.role || 'user'}: ${truncate(h.text || '', 180)}`).join('\n')
  return [preface, histStr ? `Histórico:\n${histStr}` : null, `Pergunta:\n${text}`].filter(Boolean).join('\n\n')
}
const truncate = (s, n = 180) => (s || '').length > n ? String(s).slice(0, n) + '…' : String(s || '')

function emitEmf({ Model, TTFTMs, Chunks, OutputChars, Errors, CostEstimateUSD, PromptSource }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'AletheIA',
          Dimensions: [['Service', 'Model', 'PromptSource']],
          Metrics: [
            { Name: 'TTFTMs', Unit: 'Milliseconds' },
            { Name: 'Chunks', Unit: 'Count' },
            { Name: 'OutputChars', Unit: 'Count' },
            { Name: 'Errors', Unit: 'Count' },
            { Name: 'CostEstimateUSD', Unit: 'None' },
          ],
        },
      ],
    },
    Service: 'chat-stream',
    Model,
    PromptSource: PromptSource || 'local',
    TTFTMs: TTFTMs ?? 0,
    Chunks: Chunks ?? 0,
    OutputChars: OutputChars ?? 0,
    Errors: Errors ?? 0,
    CostEstimateUSD: CostEstimateUSD ?? 0,
  }
  console.log(JSON.stringify(emf))
}
