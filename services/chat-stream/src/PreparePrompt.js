/**
 * AletheIA — services/chat-stream/src/PreparePrompt.js
 * ----------------------------------------------------
 * Lambda de preparação de prompt: recebe a mensagem do usuário e o contexto,
 * higieniza/compacta histórico, aplica instruções de sistema e devolve um
 * prompt composto pronto para consumo por modelos (OpenAI/Bedrock).
 *
 * Objetivos
 * - Reduzir acoplamento: construir o prompt **fora** da Lambda de geração.
 * - Consistência: aplicar sempre as mesmas instruções de sistema.
 * - Segurança: mascarar PII e padrões sensíveis no texto/histórico.
 * - Orçamento: respeitar limite de tokens e reservar espaço p/ saída.
 * - Telemetria: logs JSON + EMF (tempo, redactions, tokens mantidos).
 *
 * Entrada (event.body JSON ou objeto já parseado)
 * {
 *   "messageId": "uuid",
 *   "correlationId": "conv-uuid",
 *   "sequence": 21,
 *   "messageType": "user",
 *   "payload": { "text": "Explique o erro X" },
 *   "context": { "history": [ {"role":"user|assistant","text":"..."} ], "cursor": 0 }
 * }
 *
 * Saída
 * {
 *   "messageId": "uuid",
 *   "correlationId": "conv-uuid",
 *   "sequence": 21,
 *   "prepared": {
 *     "system": "...",
 *     "user": "<texto sanitizado>",
 *     "history": [ { role, text }, ... ],
 *     "composite": "<prompt final>",
 *     "budget": { "maxInputTokens": n, "reservedOutput": n, "availableForHistory": n, "usedByHistory": n },
 *     "safety": { "flags": ["pii:email", ...], "redactions": { email: 2, phone: 0, awsKey: 0 } },
 *     "lang": "pt-BR"
 *   }
 * }
 */

import { randomUUID } from 'node:crypto'

// ------------------------- Configuração por ENV ------------------------------
const ENV = {
  logLevel: (process.env.LOG_LEVEL || 'INFO').toUpperCase(),
  maxInputTokens: parseInt(process.env.MAX_INPUT_TOKENS || '6200', 10),
  reservedOutputTokens: parseInt(process.env.RESERVED_OUTPUT_TOKENS || '800', 10),
  maxHistoryTokens: parseInt(process.env.MAX_HISTORY_TOKENS || '4000', 10),
  maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES || '12', 10),
  tokenPerChar: parseFloat(process.env.TOKEN_PER_CHAR || '4'),
  redactPII: String(process.env.REDACT_PII || 'true').toLowerCase() === 'true',
  systemInstruction: (process.env.SYSTEM_INSTRUCTION || '').trim(),
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'pt-BR',
}

const logger = (() => {
  const should = (lvl) => ({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }[lvl] >= ({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }[ENV.logLevel]))
  const base = (level, obj) => console.log(JSON.stringify({ level, svc: 'prepare-prompt', at: new Date().toISOString(), ...obj }))
  return {
    debug: (o) => should('DEBUG') && base('DEBUG', o),
    info: (o) => should('INFO') && base('INFO', o),
    warn: (o) => should('WARN') && base('WARN', o),
    error: (o) => base('ERROR', o),
  }
})()

const safeJsonParse = (s) => { try { return JSON.parse(s) } catch { return null } }

// --------------------------- Sanitização & PII -------------------------------
function sanitizeText(text, flags) {
  let t = String(text || '')
  const stats = { email: 0, phone: 0, awsKey: 0, secret: 0 }

  // e-mail
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => { stats.email++; return '[EMAIL]'; })
  // telefone (simples, Brasil + Intl)
  t = t.replace(/\+?\d{1,3}[\s-]?(\(?\d{2,3}\)?)[\s-]?\d{3,5}[\s-]?\d{4}/g, (m) => { stats.phone++; return '[PHONE]'; })
  // AWS Access Key ID (AKIA...)
  t = t.replace(/\b(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16})\b/g, (m) => { stats.awsKey++; return '[AWS_ACCESS_KEY_ID]'; })
  // chaves secretas comuns (heurística)
  t = t.replace(/(secret|token|password|senha)\s*[:=]\s*['\"][^'\"]{8,}['\"]/gi, (m) => { stats.secret++; return '[SECRET_REDACTED]'; })

  if (flags) {
    if (stats.email) flags.add('pii:email')
    if (stats.phone) flags.add('pii:phone')
    if (stats.awsKey) flags.add('secret:aws-key')
    if (stats.secret) flags.add('secret:generic')
  }
  return { text: t, stats }
}

// --------------------------- Token/Orçamento ---------------------------------
const countTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / Math.max(1, ENV.tokenPerChar)))

function budgetForPrompt(userText, systemText) {
  const maxIn = ENV.maxInputTokens
  const reservedOut = Math.max(0, Math.min(ENV.reservedOutputTokens, Math.floor(maxIn * 0.5)))
  const baseOverhead = countTokens(userText) + countTokens(systemText)
  const availableForHistory = Math.max(0, Math.min(ENV.maxHistoryTokens, maxIn - reservedOut - baseOverhead))
  return { maxInputTokens: maxIn, reservedOutput: reservedOut, availableForHistory }
}

// --------------------------- Histórico/Compactação ---------------------------
function clampHistory(history) {
  if (!Array.isArray(history)) return []
  // normaliza itens: {role, text}
  const norm = history
    .filter(Boolean)
    .map((h) => ({ role: (h.role || 'user'), text: String(h.text || h.content || '') }))
    .filter((h) => h.text.trim().length > 0)
  // mantém no máximo N itens recentes
  const maxN = ENV.maxHistoryMessages
  return norm.length > maxN ? norm.slice(norm.length - maxN) : norm
}

function summarizeOlder(history, targetTokens) {
  // Estratégia simples: últimos 4 itens íntegros; o restante, resumo extracitivo curto
  const keepTail = 4
  if (history.length <= keepTail) return { kept: history, summary: null }
  const older = history.slice(0, history.length - keepTail)
  const recent = history.slice(history.length - keepTail)
  const bullets = older.map((h) => `• ${h.role}: ${truncate(h.text, 140)}`)
  let summary = bullets.join('\n')
  // reduz até caber no orçamento aproximado
  while (countTokens(summary) > targetTokens && summary.length > 80) {
    summary = summary.slice(Math.floor(summary.length * 0.85)) // corte incremental
  }
  return { kept: recent, summary }
}

function buildComposite({ system, user, historyKept, historySummary }) {
  const blocks = [
    system && `SISTEMA:\n${system}`,
    historySummary && `RESUMO DO HISTÓRICO:\n${historySummary}`,
    historyKept.length ? `HISTÓRICO RECENTE:\n${historyKept.map(h => `- ${h.role}: ${truncate(h.text, 180)}`).join('\n')}` : null,
    `SOLICITAÇÃO ATUAL:\n${user}`,
    'INSTRUÇÕES DE RESPOSTA:\n- Seja claro e incremental.\n- Proponha próximos passos práticos.\n- Se faltar dado, explicite as suposições.\n- Formate listas com marcadores quando útil.'
  ].filter(Boolean)
  return blocks.join('\n\n')
}

// --------------------------- Handler principal -------------------------------
export const handler = async (event) => {
  const t0 = Date.now()
  const input = typeof event?.body === 'string' ? safeJsonParse(event.body) : (event || {})
  if (!input) return http(400, { error: 'invalid_payload' })

  const correlationId = input.correlationId || `conv-${randomUUID()}`
  const messageId = input.messageId || randomUUID()
  const sequence = Number.isFinite(input.sequence) ? input.sequence : 0
  const rawUser = String(input?.payload?.text || '').trim()
  const rawHistory = input?.context?.history || []

  if (!rawUser) return http(400, { error: 'missing_user_text', correlationId })

  // idioma (heurística leve)
  const lang = detectLanguage(rawUser) || ENV.defaultLanguage

  // PII/segurança
  const flags = new Set()
  const userSan = ENV.redactPII ? sanitizeText(rawUser, flags) : { text: rawUser, stats: { email:0, phone:0, awsKey:0, secret:0 } }

  // Histórico: normalizar, sanitizar (se ativo), limitar
  const histNorm = clampHistory(rawHistory).map((h) => {
    const s = ENV.redactPII ? sanitizeText(h.text, flags) : { text: h.text, stats: {} }
    return { role: h.role || 'user', text: s.text }
  })

  // Orçamento de tokens
  const system = buildSystemInstruction(lang)
  const budget = budgetForPrompt(userSan.text, system)

  // Resumo de older + kept recente, respeitando orçamento
  const { kept, summary } = summarizeOlder(histNorm, Math.max(1, Math.floor(budget.availableForHistory * 0.6)))

  const keptTokens = countTokens(kept.map(h => `${h.role}: ${h.text}`).join('\n')) + countTokens(summary || '')
  const composite = buildComposite({ system, user: userSan.text, historyKept: kept, historySummary: summary })

  const prepared = {
    system,
    user: userSan.text,
    history: kept,
    composite,
    budget: { ...budget, usedByHistory: keptTokens },
    safety: { flags: Array.from(flags), redactions: userSan.stats },
    lang,
  }

  // Telemetria (EMF)
  emitEmf({ PrepTimeMs: Date.now() - t0, HistoryTokensKept: keptTokens, Redactions: Object.values(userSan.stats).reduce((a,b)=>a+b,0) })

  logger.info({ msg: 'prepare.done', correlationId, messageId, sequence, lang, kept: kept.length, keptTokens })

  // Retorna input enriquecido (útil para SFN → GenerateChunk)
  return http(200, { ...input, correlationId, messageId, sequence, prepared })
}

// --------------------------- Helpers ----------------------------------------
function http(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) }
}

function truncate(s, n) { return String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || '') }

function detectLanguage(text) {
  // Heurística simples: presença de palavras comuns PT / EN
  const pt = /(que|com|para|não|sim|erro|problema|melhoria|análise|investigação)/i
  const en = /(the|and|for|not|yes|error|issue|improvement|analysis|investigation)/i
  if (pt.test(text) && !en.test(text)) return 'pt-BR'
  if (en.test(text) && !pt.test(text)) return 'en-US'
  // fallback
  return null
}

function buildSystemInstruction(lang) {
  if (ENV.systemInstruction) return ENV.systemInstruction
  if (lang === 'en-US') {
    return [
      'You are AletheIA, an investigative AI agent.',
      'Goals: clarify the issue, hypothesize causes, propose next steps.',
      'Style: concise, stepwise, developer-friendly.',
    ].join(' ')
  }
  return [
    'Você é a AletheIA, agente de investigação assistida por IA.',
    'Objetivo: esclarecer o problema, levantar hipóteses de causa e sugerir próximos passos práticos.',
    'Estilo: conciso, passo a passo, amigável a desenvolvedores.',
  ].join(' ')
}

function emitEmf({ PrepTimeMs, HistoryTokensKept, Redactions }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'AletheIA',
          Dimensions: [['Service']],
          Metrics: [
            { Name: 'PrepTimeMs', Unit: 'Milliseconds' },
            { Name: 'HistoryTokensKept', Unit: 'Count' },
            { Name: 'Redactions', Unit: 'Count' }
          ],
        },
      ],
    },
    Service: 'prepare-prompt',
    PrepTimeMs: PrepTimeMs ?? 0,
    HistoryTokensKept: HistoryTokensKept ?? 0,
    Redactions: Redactions ?? 0,
  }
  console.log(JSON.stringify(emf))
}
