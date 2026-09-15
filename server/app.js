import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db.js'
import { createLithic, isUuid, LithicError } from './lithicApi.js'
import { AppError, createLithicService } from './lithicService.js'
import { buildServerSeed } from './seed.js'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createRateLimiter,
  generatePassword,
  hashPassword,
  parseCookies,
  passwordProblem,
  sessionCookie,
  verifyPassword,
} from './accounts.js'
import {
  allocateTransaction,
  applyCredit,
  authorizeAsa,
  cashRuleMembers,
  cashUsageFor,
  createCashRule,
  decideCash,
  deleteCashRule,
  updateCashRule,
  withCash,
  requestCash,
  withdrawCashRequest,
  holderById,
  id,
  isDuplicateCredit,
  notify,
  recallCredit,
  resolveBeneficiary,
  virtualIbanFor,
} from './domain.js'
import { verifyHmac, verifyLithicWebhook } from './hmacNode.js'
import { buildCamt029, buildPain002, parseCamt056, parsePain001 } from '../src/lib/pain001.js'
import { defaultCountriesFor } from '../src/data/agencies.js'
import { loggerFromEnv } from './log.js'
import { createMailer, deliverOutbox } from './mailer.js'
import { createXsdValidator } from './xsd.js'
import { registerResponderRoutes } from './responders.js'
import { registerLedgerRoutes } from './ledgerRoutes.js'
import { appSettings, applySettings, serverConfig, settingSources, validateSettings } from './settings.js'
import { ALERT_GROUP_KEYS } from '../src/lib/alerts.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_BODY_LIMIT = 1024 * 1024
const APP_BODY_LIMIT = 12 * 1024 * 1024

const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const startedAt = Date.now()

export function createApp({ env = {}, dataFile, lithic: lithicOverride, log = loggerFromEnv(env), mailer = createMailer(env), timers = true } = {}) {
  let credentials = []
  const file = dataFile ?? env.STIPEND_DATA_FILE ?? join(here, 'data', 'stipend.sqlite')
  const db = createDb({
    file,
    legacyJsonFile: join(here, 'data', 'stipend.json'),
    backupDir: env.STIPEND_BACKUP_DIR || join(dirname(file), 'backups'),
    log,
    pollMs: timers ? 1000 : 0,
    seed: () => {
      const seeded = buildServerSeed(env)
      credentials = seeded.credentials
      return seeded.state
    },
  })
  const settings = () => appSettings(db.read(), env)
  const mailOptions = () => ({ publicUrl: settings().publicUrl || undefined, from: settings().mailFrom })

  const environment = env.LITHIC_ENV === 'production' ? 'production' : 'sandbox'
  const lithic = lithicOverride || createLithic({ apiKey: env.LITHIC_API_KEY || '', environment })
  const service = createLithicService({ lithic, db, env })
  const sessions = db.sessions
  const xsd = createXsdValidator({ log })
  const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 8 })
  const syncThrottle = new Map()
  const routes = []

  // Refresh Lithic reachability and ASA enrollment on start, so the console never shows a stale "idle".
  if (lithic.configured) service.status().catch(() => null)

  const intervals = []
  if (timers) {
    const every = (ms, fn) => {
      const handle = setInterval(() => Promise.resolve().then(fn).catch((err) => log.error?.('background job failed', { err })), ms)
      handle.unref?.()
      intervals.push(handle)
    }
    const backupIfDue = () => {
      const last = db.lastBackupAt()
      if (!last || Date.now() - Date.parse(last) > 24 * 60 * 60 * 1000) log.info?.('database backup', { file: db.backup({ keep: settings().backupKeep }) })
    }
    backupIfDue()
    every(60 * 60 * 1000, backupIfDue)
    every(15 * 60 * 1000, () => sessions.purgeExpired())
    every(15000, () => deliverOutbox({ db, mailer, log, ...mailOptions() }))
  }

  /** Every operator write and every sign-in lands in the audit table. */
  function audit(ctx, action, { outcome = 'ok', target, details } = {}) {
    try {
      db.audit({
        actor: ctx.user?.email || ctx.actor || 'anonymous',
        action,
        target: target ?? (Object.keys(ctx.params || {}).length ? JSON.stringify(ctx.params) : null),
        outcome,
        details: details ?? sanitize(ctx.body),
        ip: ctx.req.socket?.remoteAddress || null,
      })
    } catch (err) {
      log.error?.('audit write failed', { err })
    }
  }

  const route = (method, path, access, handler) => routes.push({ method, path, parts: path.split('/').filter(Boolean), access, handler })

  // ---------------- helpers ----------------

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const session = sessions.get(token)
    if (!session) return null
    const user = (db.read().users || []).find((u) => u.id === session.userId)
    return user ? { ...user, sessionToken: token } : null
  }

  function publicUser(user) {
    if (!user) return null
    const { passwordHash, sessionToken, ...rest } = user
    return rest
  }

  function holderIdFor(ctx) {
    if (ctx.user.role === 'cardholder') return ctx.user.cardholderId
    const requested = ctx.query.get('cardholderId') || ctx.body?.cardholderId || ctx.req.headers['x-stipend-cardholder']
    const holderId = requested || db.read().cardholders?.[0]?.id
    if (!holderById(db.read(), holderId)) throw new AppError('Unknown cardholder', 404)
    return holderId
  }

  /** What cardholders may see about the program running their card. */
  function programInfo(s) {
    const { programName, organisation, supportEmail, supportPhone } = appSettings(s, env)
    return { programName, organisation, supportEmail, supportPhone }
  }

  function scopeState(user, holderId) {
    const s = db.read()
    const mask = (conn) => {
      const { hmacSecret, ...rest } = conn
      return { ...rest, hmacSecretPreview: hmacSecret ? `${hmacSecret.slice(0, 8)}…${hmacSecret.slice(-4)}` : null }
    }
    const holder = holderById(s, holderId)
    const mine = (rows) => (rows || []).filter((r) => r.cardholderId === holderId)
    const base = {
      version: s.version,
      environment,
      lithic: { ...(s.lithic || {}), configured: lithic.configured, environment, asaSecretConfigured: Boolean(s.settings?.asaSecret || env.LITHIC_ASA_SECRET) },
      user: publicUser(user),
      cardholder: withCash(s, holder),
      program: programInfo(s),
      cashUsage: cashUsageFor(s, holderId),
      envelopes: mine(s.envelopes),
      transactions: mine(s.transactions).map(({ asaResponse, ...t }) => t),
      credits: mine(s.credits),
      disputes: mine(s.disputes),
      notifications: (s.notifications || []).filter((n) => n.holderId === holderId),
      emailOutbox: (s.emailOutbox || []).filter((m) => m.to === holder?.email),
      emailDelivery: mailer.configured,
      activeSessions: sessions.countForUser(user.id),
    }
    if (user.role !== 'admin') {
      return {
        ...base,
        connections: (s.connections || [])
          .filter((c) => base.envelopes.some((e) => e.connectionId === c.id) || base.credits.some((cr) => cr.connectionId === c.id))
          .map((c) => ({ id: c.id, name: c.name, agency: c.agency, mccs: c.mccs, countries: c.countries, protocol: c.protocol, purpose: c.purpose })),
      }
    }
    const envelopeSums = {}
    for (const e of s.envelopes || []) {
      envelopeSums[e.cardholderId] = envelopeSums[e.cardholderId] || { count: 0, available: 0 }
      envelopeSums[e.cardholderId].count++
      envelopeSums[e.cardholderId].available += e.balanceCents
    }
    return {
      ...base,
      operator: s.operator,
      appSettings: appSettings(s, env),
      connections: (s.connections || []).map(mask),
      cardholders: (s.cardholders || []).map((c) => ({ ...withCash(s, c), summary: envelopeSums[c.id] || { count: 0, available: 0 }, cashUsage: cashUsageFor(s, c.id) })),
      cashRules: (s.cashRules || []).map((r) => ({ ...r, memberIds: cashRuleMembers(s, r.id).map((h) => h.id) })),
      allCredits: s.credits || [],
      allTransactions: (s.transactions || []).map(({ asaResponse, ...t }) => t),
      allDisputes: s.disputes || [],
      cases: s.cases || [],
      asaLog: s.asaLog || [],
      webhooks: (s.webhooks || []).slice(0, 100),
      reports: (s.reports || []).map(({ xml, ...r }) => r),
      users: (s.users || []).map(publicUser),
      allOutbox: (s.emailOutbox || []).slice(0, 100),
      allEnvelopes: s.envelopes || [],
      mail: { configured: mailer.configured },
    }
  }

  function afterCredit(credits) {
    const holders = new Set()
    for (const credit of credits) {
      holders.add(credit.cardholderId)
      const holder = holderById(db.read(), credit.cardholderId)
      service
        .disburse({ amountCents: credit.amountCents, memo: credit.remittance, accountToken: holder?.lithicAccount, externalId: credit.endToEndId })
        .then((transfer) =>
          db.mutate((s) => {
            const row = s.credits.find((c) => c.id === credit.id)
            if (row) row.lithicTransfer = transfer
          }),
        )
        .catch((err) => log.warn?.('book transfer failed', { creditId: credit.id, err }))
    }
    for (const holderId of holders) service.syncRules(holderId).catch(() => null)
  }

  /** Credit a batch of lines from one connection; returns per-line ISO statuses and a stored pain.002. */
  function processCredits(connection, { msgId, pmtInfId, lines, protocol }) {
    const statuses = []
    const created = []
    db.mutate((s) => {
      const conn = s.connections.find((c) => c.id === connection.id)
      const seen = new Set()
      for (const line of lines) {
        const reject = (reason, detail) => statuses.push({ endToEndId: line.endToEndId, status: 'RJCT', reason, detail })
        if (line.errors?.length) {
          reject('FF01', line.errors.join('; '))
          continue
        }
        if ((line.currency || 'EUR') !== 'EUR') {
          reject('AM11', `Currency ${line.currency} not supported`)
          continue
        }
        if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) {
          reject('AM12', 'Amount must be a positive number of cents')
          continue
        }
        if (!line.endToEndId) {
          reject('FF01', 'EndToEndId is required')
          continue
        }
        if (seen.has(line.endToEndId) || isDuplicateCredit(s, conn.id, line.endToEndId)) {
          reject('AM05', `EndToEndId ${line.endToEndId} was already credited`)
          continue
        }
        const holder = resolveBeneficiary(s, { beneficiaryRef: line.beneficiaryRef, iban: line.creditorIban })
        if (!holder) {
          reject('BE06', 'Beneficiary reference or IBAN not known to Stipend')
          continue
        }
        seen.add(line.endToEndId)
        created.push(
          applyCredit(s, {
            connection: conn,
            holder,
            amountCents: line.amountCents,
            endToEndId: line.endToEndId,
            remittance: line.remittance,
            purpose: line.purpose,
            protocol,
            msgId,
          }),
        )
        statuses.push({ endToEndId: line.endToEndId, status: 'ACCP' })
      }
    })
    const report = buildPain002({ originalMsgId: msgId || lines[0]?.endToEndId, originalPmtInfId: pmtInfId, statuses })
    const reportId = id('rpt')
    db.mutate((s) => {
      s.reports = [
        { id: reportId, kind: 'pain.002', connectionId: connection.id, createdAt: new Date().toISOString(), groupStatus: report.groupStatus, statuses, xml: report.xml },
        ...(s.reports || []),
      ].slice(0, 300)
    })
    afterCredit(created)
    return { groupStatus: report.groupStatus, statuses, credits: created, reportId, xml: report.xml }
  }

  function parseCreditBody(raw, body, { schema = true } = {}) {
    const isXml = raw.trim().startsWith('<')
    if (isXml) {
      const parsed = parsePain001(raw)
      // Official ISO 20022 schema first; the structural checks still catch business-rule problems.
      const checked = schema ? xsd.validate(raw, 'pain.001.001.09') : { ok: true, errors: [] }
      const fileErrors = [...(checked.ok ? [] : checked.errors.map((e) => `XSD ${e}`)), ...parsed.errors]
      return { protocol: 'pain001', msgId: parsed.msgId, pmtInfId: parsed.pmtInfId, fileErrors, lines: parsed.payments }
    }
    if (!body) throw new AppError('Body must be pain.001 XML or JSON', 400)
    const items = Array.isArray(body.credits) ? body.credits : [body]
    return {
      protocol: 'json',
      msgId: body.message_id || null,
      fileErrors: [],
      lines: items.map((item) => ({
        endToEndId: item.end_to_end_id || item.endToEndId,
        amountCents: Number(item.amount ?? item.amountCents),
        currency: item.currency || 'EUR',
        beneficiaryRef: item.beneficiary_ref || item.beneficiaryRef,
        creditorIban: item.creditor_iban || item.iban,
        purpose: item.purpose_code || item.purpose,
        remittance: item.remittance,
        errors: [],
      })),
    }
  }

  function respondCredits(ctx, result, { preferXml }) {
    const accepted = result.statuses.filter((s) => s.status === 'ACCP').length
    const status = accepted
      ? 200
      : result.statuses.length === 1 && result.statuses[0].reason === 'AM05'
        ? 409
        : result.statuses.length === 1 && ['AM12', 'AM11'].includes(result.statuses[0].reason)
          ? 400
          : 422
    if (preferXml) return sendRaw(ctx.res, status, result.xml, 'application/xml')
    return send(ctx.res, status, {
      ok: accepted > 0,
      groupStatus: result.groupStatus,
      statuses: result.statuses,
      credits: result.credits.map((c) => ({ id: c.id, endToEndId: c.endToEndId, amountCents: c.amountCents, cardholderId: c.cardholderId })),
      reportId: result.reportId,
      error: accepted ? undefined : result.statuses[0]?.detail,
    })
  }

  function processRecalls(connection, raw) {
    const parsed = parseCamt056(raw)
    if (parsed.errors.length && !parsed.cases.length) throw new AppError(parsed.errors.join('; '), 400)
    const results = []
    const reversals = []
    db.mutate((s) => {
      for (const item of parsed.cases) {
        const credit = (s.credits || []).find((c) => c.connectionId === connection.id && c.endToEndId === item.originalEndToEndId)
        if (!credit) {
          results.push({ originalEndToEndId: item.originalEndToEndId, status: 'RJCR', reason: 'NOOR', detail: 'Original transaction not found' })
          continue
        }
        const outcome = recallCredit(s, { credit, reason: item.reason })
        results.push({ originalEndToEndId: item.originalEndToEndId, status: outcome.status, reason: outcome.reason, detail: outcome.detail, recalledCents: outcome.recalledCents })
        if (outcome.status === 'CNCL' && credit.lithicTransfer?.token) reversals.push({ creditId: credit.id, token: credit.lithicTransfer.token, holderId: credit.cardholderId })
      }
    })
    const xml = buildCamt029({ originalMsgId: parsed.msgId, results })
    const reportId = id('rpt')
    db.mutate((s) => {
      s.reports = [{ id: reportId, kind: 'camt.029', connectionId: connection.id, createdAt: new Date().toISOString(), results, xml }, ...(s.reports || [])].slice(0, 300)
    })
    for (const r of reversals) {
      service.reverseTransfer(r.token, 'Agency recall').then((res) =>
        db.mutate((s) => {
          const credit = s.credits.find((c) => c.id === r.creditId)
          if (credit) credit.lithicReversal = res
        }),
      )
      service.syncRules(r.holderId).catch(() => null)
    }
    return { results, xml, reportId }
  }

  function verifyConnectionSignature(ctx) {
    const connectionId = ctx.params.connectionId
    const conn = (db.read().connections || []).find((c) => c.id === connectionId)
    if (!conn) throw new AppError('Unknown connection', 404)
    const header = ctx.req.headers['x-stipend-signature'] || ctx.req.headers['x-hmac-sha256']
    if (!verifyHmac(conn.hmacSecret, ctx.raw, header)) throw new AppError('Invalid HMAC signature', 401)
    if (conn.status === 'paused') throw new AppError('Connection is paused', 409)
    return conn
  }

  function lithicSecrets() {
    const s = db.read().settings || {}
    return [env.LITHIC_WEBHOOK_SECRET, ...Object.values(s.webhookSecrets || {})].filter(Boolean)
  }

  function requireSandbox() {
    if (environment !== 'sandbox') throw new AppError('Simulations are only available in the Lithic sandbox.', 403)
  }

  // ---------------- public ----------------

  route('GET', '/api/health', 'public', (ctx) => {
    let dbOk = true
    let version = null
    try {
      version = db.read().version
    } catch {
      dbOk = false
    }
    const lithicState = db.read()?.lithic || {}
    const degraded = !dbOk || (lithic.configured && lithicState.status === 'error')
    ctx.res.statusCode = dbOk ? 200 : 503
    send(ctx.res, dbOk ? 200 : 503, {
      status: !dbOk ? 'down' : degraded ? 'degraded' : 'ok',
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      db: { ok: dbOk, version },
      lithic: { configured: lithic.configured, environment, status: lithicState.status || 'unknown', checkedAt: lithicState.checkedAt || null },
      xsdValidation: xsd.available,
    })
    return undefined
  })

  route('POST', '/api/asa', 'public', (ctx) => {
    const secret = db.read().settings?.asaSecret || env.LITHIC_ASA_SECRET
    if (secret) {
      const check = verifyLithicWebhook(secret, ctx.raw, ctx.req.headers)
      if (!check.ok) throw new AppError(`Invalid ASA signature (${check.reason})`, 401)
    } else if (environment === 'production') {
      throw new AppError('ASA secret not configured', 401)
    }
    try {
      return db.mutate((s) => authorizeAsa(s, ctx.body || {}, { source: 'asa' }))
    } catch (err) {
      log.error?.('ASA decision failed', { err })
      return { token: ctx.body?.token, result: 'UNAUTHORIZED_MERCHANT' }
    }
  })

  route('POST', '/api/hooks/credits/:connectionId', 'public', (ctx) => {
    const conn = verifyConnectionSignature(ctx)
    const parsed = parseCreditBody(ctx.raw, ctx.body)
    if (parsed.fileErrors.length) {
      const lines = parsed.lines.length ? parsed.lines.map((l) => ({ ...l, errors: [...parsed.fileErrors, ...(l.errors || [])] })) : [{ endToEndId: '', errors: parsed.fileErrors }]
      return respondCredits(ctx, processCredits(conn, { ...parsed, lines }), { preferXml: parsed.protocol === 'pain001' && wantsXml(ctx.req) })
    }
    return respondCredits(ctx, processCredits(conn, parsed), { preferXml: parsed.protocol === 'pain001' && wantsXml(ctx.req) })
  })

  route('POST', '/api/hooks/recalls/:connectionId', 'public', (ctx) => {
    const conn = verifyConnectionSignature(ctx)
    const checked = xsd.validate(ctx.raw, 'camt.056.001.08')
    if (!checked.ok) throw new AppError(`camt.056 does not match the ISO 20022 schema: ${checked.errors.join('; ')}`, 400, { errors: checked.errors })
    const result = processRecalls(conn, ctx.raw)
    if (wantsXml(ctx.req)) return sendRaw(ctx.res, 200, result.xml, 'application/xml')
    return { results: result.results, reportId: result.reportId }
  })

  route('POST', '/api/webhooks/lithic', 'public', (ctx) => {
    const secrets = lithicSecrets()
    let verified = false
    if (secrets.length) {
      verified = secrets.some((secret) => verifyLithicWebhook(secret, ctx.raw, ctx.req.headers).ok)
      if (!verified) throw new AppError('Invalid Lithic webhook signature', 401)
    } else if (environment === 'production') {
      throw new AppError('Webhook secret not configured', 401)
    }
    const messageId = ctx.req.headers['webhook-id'] || null
    const duplicate = messageId && (db.read().webhooks || []).some((w) => w.messageId === messageId)
    db.mutate((s) => {
      s.webhooks = [
        { id: id('whk'), messageId, at: new Date().toISOString(), verified, duplicate: Boolean(duplicate), eventType: ctx.body?.event_type || null, event: ctx.body },
        ...(s.webhooks || []),
      ].slice(0, 300)
    })
    if (!duplicate && ctx.body) service.handleEvent(ctx.body).catch((err) => log.error?.('event handling failed', { eventType: ctx.body.event_type, err }))
    return { ok: true, verified }
  })

  // ---------------- session ----------------

  route('POST', '/api/auth/login', 'public', (ctx) => {
    const email = String(ctx.body?.email || '').trim().toLowerCase()
    const ip = ctx.req.socket?.remoteAddress || 'unknown'
    if (!loginLimiter.allow(`${ip}|${email}`)) throw new AppError('Too many attempts. Wait a minute and try again.', 429)
    const user = (db.read().users || []).find((u) => u.email.toLowerCase() === email)
    const ok = user && verifyPassword(String(ctx.body?.password || ''), user.passwordHash)
    if (!ok) {
      audit({ ...ctx, actor: email || 'anonymous' }, 'auth.login', { outcome: 'denied', details: null })
      throw new AppError('Email or password is incorrect.', 401)
    }
    audit({ ...ctx, user }, 'auth.login', { details: null })
    const token = sessions.create(user)
    ctx.res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(ctx.req, env) }))
    return { user: publicUser(user) }
  })

  route('POST', '/api/auth/logout', 'public', (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
    if (token) sessions.destroy(token)
    ctx.res.setHeader('Set-Cookie', clearSessionCookie())
    return { ok: true }
  })

  route('GET', '/api/auth/session', 'public', (ctx) => ({ user: publicUser(currentUser(ctx.req)) }))

  route('POST', '/api/auth/password', 'user', (ctx) => {
    const { currentPassword, newPassword } = ctx.body || {}
    const user = db.read().users.find((u) => u.id === ctx.user.id)
    if (!verifyPassword(String(currentPassword || ''), user.passwordHash)) throw new AppError('Current password is incorrect.', 401)
    const problem = passwordProblem(newPassword)
    if (problem) throw new AppError(problem)
    db.mutate((s) => {
      const u = s.users.find((x) => x.id === ctx.user.id)
      u.passwordHash = hashPassword(newPassword)
      u.mustChangePassword = false
    })
    sessions.destroyUser(ctx.user.id, ctx.user.sessionToken)
    audit(ctx, 'auth.password_changed', { details: null })
    return { ok: true }
  })

  // ---------------- app state ----------------

  route('GET', '/api/app/state', 'user', (ctx) => scopeState(ctx.user, holderIdFor(ctx)))

  route('GET', '/api/app/stream', 'user', (ctx) => {
    const { req, res } = ctx
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
    res.write(`event: version\ndata: ${db.read().version}\n\n`)
    const unsubscribe = db.subscribe((version) => res.write(`event: version\ndata: ${version}\n\n`))
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    return undefined
  })

  // ---------------- cardholder (own card; admins act on ?cardholderId) ----------------

  route('POST', '/api/me/sync', 'user', async (ctx) => {
    const holderId = holderIdFor(ctx)
    if (!lithic.configured) return { skipped: 'Lithic not configured' }
    const last = syncThrottle.get(holderId) || 0
    if (Date.now() - last < 20000) return { skipped: 'throttled' }
    syncThrottle.set(holderId, Date.now())
    const holder = holderById(db.read(), holderId)
    if (!isUuid(holder.card?.token)) return { skipped: 'no card' }
    return service.syncTransactions(holderId)
  })

  route('POST', '/api/me/notifications/read', 'user', (ctx) => {
    const holderId = holderIdFor(ctx)
    db.mutate((s) => {
      for (const n of s.notifications || []) if (n.holderId === holderId) n.read = true
    })
    return { ok: true }
  })

  route('PATCH', '/api/me/prefs', 'user', (ctx) => {
    const holderId = holderIdFor(ctx)
    const b = ctx.body || {}
    const next = {}
    if (b.emailAlerts !== undefined) next.emailAlerts = Boolean(b.emailAlerts)
    if (b.emailMuted !== undefined) {
      if (!Array.isArray(b.emailMuted) || b.emailMuted.some((g) => !ALERT_GROUP_KEYS.includes(g))) throw new AppError(`emailMuted must list alert types: ${ALERT_GROUP_KEYS.join(', ')}`)
      next.emailMuted = [...new Set(b.emailMuted)]
    }
    return db.mutate((s) => {
      const h = holderById(s, holderId)
      h.prefs = { ...(h.prefs || {}), ...next }
      return h.prefs
    })
  })

  /** Cardholders keep their own contact details current; changing the sign-in email needs the password. */
  route('PATCH', '/api/me/profile', 'user', async (ctx) => {
    const holderId = holderIdFor(ctx)
    const b = ctx.body || {}
    const state = db.read()
    const holder = holderById(state, holderId)
    const fields = {}
    if (b.phone !== undefined) {
      const phone = String(b.phone).trim()
      if (!/^\+?[0-9 ()/-]{6,30}$/.test(phone)) throw new AppError('Enter a phone number with country code, for example +49 30 1234567.')
      fields.phone = phone
    }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase()
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new AppError('Enter a valid email address.')
      if (email !== String(holder.email).toLowerCase()) {
        if (ctx.user.role === 'cardholder') {
          const me = state.users.find((u) => u.id === ctx.user.id)
          if (!verifyPassword(String(b.currentPassword || ''), me.passwordHash)) throw new AppError('Current password is incorrect.', 401)
        }
        if (state.users.some((u) => u.email.toLowerCase() === email && u.cardholderId !== holderId)) throw new AppError('This email address is already in use.', 409)
        fields.email = email
      }
    }
    if (!Object.keys(fields).length) return withCash(state, holder)
    await service.updateAccountHolder(holderId, fields)
    audit(ctx, 'me.profile', { target: holderId, details: { fields: Object.keys(fields) } })
    return withCash(db.read(), holderById(db.read(), holderId))
  })

  route('POST', '/api/auth/sessions/revoke-others', 'user', (ctx) => {
    sessions.destroyUser(ctx.user.id, ctx.user.sessionToken)
    audit(ctx, 'auth.sessions_revoked', { details: null })
    return { activeSessions: sessions.countForUser(ctx.user.id) }
  })

  route('POST', '/api/me/card/state', 'user', async (ctx) => {
    const state = ctx.body?.state
    if (ctx.user.role === 'cardholder' && !['OPEN', 'PAUSED'].includes(state)) throw new AppError('Cardholders can only freeze or unfreeze.', 403)
    await service.setCardState(holderIdFor(ctx), state)
    return { ok: true }
  })
  route('POST', '/api/me/card/embed', 'user', (ctx) =>
    service.embedSession(holderIdFor(ctx), { type: ctx.body?.type, targetOrigin: originOf(ctx.req) }),
  )
  route('GET', '/api/me/card/spend-limits', 'user', (ctx) => service.spendLimits(holderIdFor(ctx)))
  route('GET', '/api/me/tokenizations', 'user', (ctx) => service.tokenizations(holderIdFor(ctx)))
  route('POST', '/api/me/tokenizations/:token/:action', 'user', (ctx) =>
    service.tokenizationAction(holderIdFor(ctx), ctx.params.token, ctx.params.action),
  )
  route('POST', '/api/me/wallets/simulate', 'user', (ctx) => {
    requireSandbox()
    return service.simulateTokenization(holderIdFor(ctx), ctx.body?.wallet)
  })
  route('POST', '/api/me/wallets/web-provision', 'user', (ctx) => service.webProvision(holderIdFor(ctx), ctx.body || {}))
  route('GET', '/api/me/wallets/config', 'user', async (ctx) => {
    const holderId = holderIdFor(ctx)
    const applePay = environment === 'sandbox' || !lithic.configured ? 'unavailable' : await service.webPushAvailability(holderId).catch(() => 'unknown')
    return {
      sandbox: environment === 'sandbox',
      applePay,
      googlePay: environment !== 'sandbox' && Boolean(env.LITHIC_GOOGLE_INTEGRATOR_ID) && applePay !== 'unavailable',
      applePartnerId: env.LITHIC_APPLE_PARTNER_ID || 'ORG-97a7c2b2-11ec-4d6d-a3f7-c3d06f4b2703',
      googleIntegratorId: env.LITHIC_GOOGLE_INTEGRATOR_ID || '',
    }
  })
  route('POST', '/api/me/purchases', 'user', (ctx) => {
    requireSandbox()
    const b = ctx.body || {}
    return service.simulatePurchase(holderIdFor(ctx), {
      amountCents: Number(b.amountCents),
      mcc: String(b.mcc || ''),
      merchant: b.merchant,
      city: b.city,
      country: b.country,
      partialApprovalCapable: Boolean(b.partialApprovalCapable),
      cashCents: Number(b.cashCents) || 0,
    })
  })

  route('POST', '/api/me/cash-request', 'user', (ctx) => {
    const holderId = holderIdFor(ctx)
    return db.mutate((s) =>
      wrapDomain(() => requestCash(s, holderId, { amountCents: Number(ctx.body?.amountCents), period: ctx.body?.period, reason: ctx.body?.reason })),
    )
  })
  route('DELETE', '/api/me/cash-request', 'user', (ctx) => {
    const holderId = holderIdFor(ctx)
    return db.mutate((s) => wrapDomain(() => withdrawCashRequest(s, holderId)))
  })
  route('POST', '/api/me/3ds', 'user', (ctx) => {
    requireSandbox()
    return service.simulate3ds(holderIdFor(ctx), ctx.body || {})
  })
  route('POST', '/api/me/3ds/:token/otp', 'user', (ctx) => {
    requireSandbox()
    holderIdFor(ctx)
    return service.enterOtp(ctx.params.token, String(ctx.body?.otp || ''))
  })
  route('POST', '/api/me/disputes', 'user', (ctx) => service.fileDispute(holderIdFor(ctx), ctx.body || {}))
  route('POST', '/api/me/disputes/:id/refresh', 'user', (ctx) => service.refreshDispute(ctx.params.id, holderIdFor(ctx)))
  route('POST', '/api/me/disputes/:id/withdraw', 'user', async (ctx) => {
    await service.withdrawDispute(ctx.params.id, holderIdFor(ctx))
    return { ok: true }
  })
  route('POST', '/api/me/disputes/:id/evidence', 'user', (ctx) => service.uploadEvidence(ctx.params.id, holderIdFor(ctx), ctx.body || {}))
  route('DELETE', '/api/me/disputes/:id/evidence/:token', 'user', (ctx) =>
    service.deleteEvidence(ctx.params.id, holderIdFor(ctx), ctx.params.token),
  )

  // ---------------- admin ----------------

  route('POST', '/api/admin/lithic/status', 'admin', () => service.status())
  route('POST', '/api/admin/sync', 'admin', () => service.syncTransactions())
  route('POST', '/api/admin/reset', 'admin', () => {
    const current = db.read()
    const { state } = buildServerSeed(env)
    db.replace({ ...state, users: current.users, settings: current.settings, lithic: current.lithic })
    return { ok: true }
  })

  route('POST', '/api/admin/connections', 'admin', (ctx) => {
    const b = ctx.body || {}
    if (!b.name || !Array.isArray(b.mccs) || !b.mccs.length) throw new AppError('Name and at least one MCC are required.')
    const state = db.read()
    const connId = b.id && !state.connections.some((c) => c.id === b.id) ? b.id : id('conn')
    const secret = `whk_${randomBytes(24).toString('base64url')}`
    db.mutate((s) => {
      s.connections.unshift({
        id: connId,
        name: b.name,
        country: b.country,
        agency: b.agency,
        system: b.system || 'pain.001',
        protocol: b.protocol || 'pain001',
        purpose: b.purpose || 'SSBE',
        mccs: b.mccs,
        countries: Array.isArray(b.countries) ? b.countries : defaultCountriesFor(b.country),
        dailyLimitCents: positiveInt(b.dailyLimitCents) ?? settings().defaultDailyLimitCents,
        cashAllowed: Boolean(b.cashAllowed),
        status: 'sandbox',
        hookPath: `/api/hooks/credits/${connId}`,
        hmacSecret: secret,
        createdAt: new Date().toISOString(),
      })
    })
    return { id: connId, hmacSecret: secret }
  })

  route('PATCH', '/api/admin/connections/:id', 'admin', (ctx) => {
    const b = ctx.body || {}
    const fields = {}
    for (const key of ['name', 'agency', 'protocol', 'purpose', 'status', 'system']) if (typeof b[key] === 'string') fields[key] = b[key]
    if (Array.isArray(b.mccs)) fields.mccs = b.mccs
    if (Array.isArray(b.countries)) fields.countries = b.countries
    if (b.dailyLimitCents !== undefined) fields.dailyLimitCents = positiveInt(b.dailyLimitCents) ?? settings().defaultDailyLimitCents
    if (b.cashAllowed !== undefined) fields.cashAllowed = Boolean(b.cashAllowed)
    const affected = db.mutate((s) => {
      const conn = s.connections.find((c) => c.id === ctx.params.id)
      if (!conn) throw new AppError('Unknown connection', 404)
      Object.assign(conn, fields)
      const holders = new Set()
      for (const e of s.envelopes) {
        if (e.connectionId !== conn.id) continue
        e.connectionName = conn.name
        e.mccs = conn.mccs
        e.countries = conn.countries
        holders.add(e.cardholderId)
      }
      return [...holders]
    })
    for (const holderId of affected) service.syncRules(holderId).catch(() => null)
    return { ok: true }
  })

  route('DELETE', '/api/admin/connections/:id', 'admin', (ctx) => {
    const affected = db.mutate((s) => {
      const holders = [...new Set(s.envelopes.filter((e) => e.connectionId === ctx.params.id).map((e) => e.cardholderId))]
      s.connections = s.connections.filter((c) => c.id !== ctx.params.id)
      s.envelopes = s.envelopes.filter((e) => e.connectionId !== ctx.params.id)
      return holders
    })
    for (const holderId of affected) service.syncRules(holderId).catch(() => null)
    return { ok: true }
  })

  route('POST', '/api/admin/connections/:id/secret', 'admin', (ctx) => {
    const rotate = Boolean(ctx.body?.rotate)
    return db.mutate((s) => {
      const conn = s.connections.find((c) => c.id === ctx.params.id)
      if (!conn) throw new AppError('Unknown connection', 404)
      if (rotate) conn.hmacSecret = `whk_${randomBytes(24).toString('base64url')}`
      conn.secretRevealedAt = new Date().toISOString()
      return { hmacSecret: conn.hmacSecret }
    })
  })

  route('POST', '/api/admin/connections/:id/files', 'admin', (ctx) => {
    const conn = db.read().connections.find((c) => c.id === ctx.params.id)
    if (!conn) throw new AppError('Unknown connection', 404)
    const content = String(ctx.body?.content || '')
    if (/FIToFIPmtCxlReq/.test(content)) {
      const checked = xsd.validate(content, 'camt.056.001.08')
      if (!checked.ok) throw new AppError(`camt.056 does not match the ISO 20022 schema: ${checked.errors.join('; ')}`, 400, { errors: checked.errors })
      return { kind: 'camt.056', ...processRecalls(conn, content) }
    }
    const parsed = parseCreditBody(content, content.trim().startsWith('{') ? JSON.parse(content) : null)
    const lines = parsed.fileErrors.length ? parsed.lines.map((l) => ({ ...l, errors: [...parsed.fileErrors, ...(l.errors || [])] })) : parsed.lines
    const result = processCredits(conn, { ...parsed, lines: lines.length ? lines : [{ endToEndId: '', errors: parsed.fileErrors }], protocol: parsed.protocol })
    return { kind: 'pain.001', groupStatus: result.groupStatus, statuses: result.statuses, reportId: result.reportId }
  })

  route('POST', '/api/admin/credits/:id/recall', 'admin', (ctx) => {
    const credit = db.read().credits.find((c) => c.id === ctx.params.id)
    if (!credit) throw new AppError('Unknown credit', 404)
    const conn = db.read().connections.find((c) => c.id === credit.connectionId)
    if (!conn) throw new AppError('Connection no longer exists', 409)
    const xml = `<Document><FIToFIPmtCxlReq><Assgnmt><Id>ADMIN-${credit.id}</Id></Assgnmt><Undrlyg><TxInf><OrgnlEndToEndId>${credit.endToEndId}</OrgnlEndToEndId><CxlRsnInf><Rsn><Cd>${String(ctx.body?.reason || 'CUST').replace(/[^A-Z0-9]/g, '').slice(0, 4)}</Cd></Rsn></CxlRsnInf></TxInf></Undrlyg></FIToFIPmtCxlReq></Document>`
    return processRecalls(conn, xml)
  })

  route('GET', '/api/admin/reports/:id', 'admin', (ctx) => {
    const report = (db.read().reports || []).find((r) => r.id === ctx.params.id)
    if (!report) throw new AppError('Unknown report', 404)
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${report.kind}-${report.id}.xml"`)
    return sendRaw(ctx.res, 200, report.xml, 'application/xml')
  })

  route('POST', '/api/admin/cardholders', 'admin', async (ctx) => {
    const b = ctx.body || {}
    for (const key of ['firstName', 'lastName', 'email', 'city']) if (!String(b[key] || '').trim()) throw new AppError(`${key} is required`)
    const email = b.email.trim().toLowerCase()
    const state = db.read()
    if (state.users.some((u) => u.email.toLowerCase() === email)) throw new AppError('A user with this email already exists.', 409)
    const beneficiaryRef = String(b.beneficiaryRef || '').trim() || `STP-${randomBytes(4).toString('hex').toUpperCase()}`
    if (state.cardholders.some((c) => c.beneficiaryRef === beneficiaryRef)) throw new AppError('Beneficiary reference already in use.', 409)
    const holderId = id('ch')
    const password = generatePassword()
    db.mutate((s) => {
      s.cardholders.unshift({
        id: holderId,
        firstName: b.firstName.trim(),
        lastName: b.lastName.trim(),
        email,
        phone: String(b.phone || '').trim(),
        city: b.city.trim(),
        country: b.country || 'DE',
        beneficiaryRef,
        iban: virtualIbanFor(holderId),
        prefs: { emailAlerts: false },
        kyc: { status: 'NOT_SUBMITTED' },
        card: { token: null, type: 'VIRTUAL', state: 'OPEN', lastFour: null },
        createdAt: new Date().toISOString(),
      })
      s.users.push({
        id: id('usr'),
        email,
        name: `${b.firstName.trim()} ${b.lastName.trim()}`,
        role: 'cardholder',
        cardholderId: holderId,
        passwordHash: hashPassword(password),
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
      })
    })
    let issueError = null
    if (lithic.configured && b.issueCard !== false) {
      await service.issueCard(holderId).catch((err) => {
        issueError = err.message
      })
    }
    return { id: holderId, temporaryPassword: password, issueError }
  })

  route('PATCH', '/api/admin/cardholders/:id', 'admin', async (ctx) => {
    await service.updateAccountHolder(ctx.params.id, ctx.body || {})
    return { ok: true }
  })
  route('DELETE', '/api/admin/cardholders/:id', 'admin', async (ctx) => {
    const holder = holderById(db.read(), ctx.params.id)
    if (!holder) throw new AppError('Unknown cardholder', 404)
    if (isUuid(holder.card?.token)) await service.setCardState(holder.id, 'CLOSED')
    db.mutate((s) => {
      s.cardholders = s.cardholders.filter((c) => c.id !== holder.id)
      s.users = s.users.filter((u) => u.cardholderId !== holder.id)
      s.envelopes = s.envelopes.filter((e) => e.cardholderId !== holder.id)
    })
    if (holder.cash?.status === 'APPROVED') service.scheduleCashSync()
    return { ok: true }
  })
  route('POST', '/api/admin/cardholders/:id/password', 'admin', (ctx) => {
    const password = generatePassword()
    const user = db.mutate((s) => {
      const u = s.users.find((x) => x.cardholderId === ctx.params.id)
      if (!u) throw new AppError('No login for this cardholder', 404)
      u.passwordHash = hashPassword(password)
      u.mustChangePassword = true
      return u
    })
    sessions.destroyUser(user.id)
    return { temporaryPassword: password }
  })
  route('POST', '/api/admin/cardholders/:id/issue', 'admin', (ctx) => service.issueCard(ctx.params.id))
  /** Cash changes touch each cardholder's MCC allowlist and the program-wide cash rules on Lithic. */
  function resyncCash(holderIds) {
    for (const holderId of holderIds) service.syncRules(holderId).catch((err) => log.warn?.('rule sync failed', { cardholderId: holderId, err }))
    service.scheduleCashSync()
  }
  route('POST', '/api/admin/cardholders/:id/cash', 'admin', (ctx) => {
    const b = ctx.body || {}
    const cash = db.mutate((s) =>
      wrapDomain(() => decideCash(s, ctx.params.id, { decision: b.decision, ruleId: b.ruleId, note: b.note, actor: ctx.user.email })),
    )
    resyncCash([ctx.params.id])
    return cash
  })
  route('POST', '/api/admin/cash-rules', 'admin', (ctx) => {
    const b = ctx.body || {}
    return db.mutate((s) => wrapDomain(() => createCashRule(s, { name: b.name, limitCents: Number(b.limitCents), period: b.period })))
  })
  route('PATCH', '/api/admin/cash-rules/:id', 'admin', (ctx) => {
    const b = ctx.body || {}
    const fields = {}
    if (b.name !== undefined) fields.name = b.name
    if (b.limitCents !== undefined) fields.limitCents = Number(b.limitCents)
    if (b.period !== undefined) fields.period = b.period
    const rule = db.mutate((s) => wrapDomain(() => updateCashRule(s, ctx.params.id, fields)))
    service.scheduleCashSync()
    return rule
  })
  route('DELETE', '/api/admin/cash-rules/:id', 'admin', (ctx) => {
    db.mutate((s) => wrapDomain(() => deleteCashRule(s, ctx.params.id)))
    service.scheduleCashSync()
    return { ok: true }
  })
  /** Bulk: add cardholders to a rule (ruleId) or remove them from cash entirely (ruleId null). */
  route('POST', '/api/admin/cash-rules/assign', 'admin', (ctx) => {
    const b = ctx.body || {}
    const ids = [...new Set(Array.isArray(b.cardholderIds) ? b.cardholderIds.map(String) : [])]
    if (!ids.length) throw new AppError('Select at least one cardholder.')
    const changed = db.mutate((s) =>
      wrapDomain(() => {
        for (const id of ids) if (!holderById(s, id)) throw Object.assign(new Error(`Unknown cardholder ${id}`), { status: 404 })
        const touched = []
        for (const id of ids) {
          const current = holderById(s, id).cash
          if (b.ruleId) {
            if (current?.status === 'APPROVED' && current.ruleId === b.ruleId) continue
            decideCash(s, id, { decision: 'APPROVE', ruleId: b.ruleId, note: b.note, actor: ctx.user.email })
          } else {
            if (current?.status !== 'APPROVED') continue
            decideCash(s, id, { decision: 'REVOKE', note: b.note, actor: ctx.user.email })
          }
          touched.push(id)
        }
        return touched
      }),
    )
    resyncCash(changed)
    return { changed }
  })
  route('POST', '/api/admin/cash-rules/sync', 'admin', () => service.syncCashRules())
  route('GET', '/api/admin/cardholders/:id/kyc', 'admin', (ctx) => service.accountHolder(ctx.params.id))
  route('POST', '/api/admin/cardholders/:id/rules/sync', 'admin', (ctx) => service.syncRules(ctx.params.id))
  route('POST', '/api/admin/cardholders/:id/card/:action', 'admin', (ctx) => {
    const b = ctx.body || {}
    const holderId = ctx.params.id
    switch (ctx.params.action) {
      case 'state':
        return service.setCardState(holderId, b.state).then(() => ({ ok: true }))
      case 'physical':
        return service.convertPhysical(holderId, b)
      case 'reissue':
        return service.reissue(holderId, b)
      case 'renew':
        return service.renew(holderId, b)
      case 'spend-limit':
        return service.updateSpendLimit(holderId, { spendLimitCents: Number(b.spendLimitCents), duration: b.duration }).then(() => ({ ok: true }))
      case 'refresh':
        return service.refreshCard(holderId)
      default:
        throw new AppError('Unknown card action', 404)
    }
  })

  route('GET', '/api/admin/rules', 'admin', (ctx) => {
    const holderId = ctx.query.get('cardholderId')
    const token = holderId ? holderById(db.read(), holderId)?.card?.token : undefined
    return service.listRules(isUuid(token) ? token : undefined)
  })
  route('PATCH', '/api/admin/rules/:token', 'admin', (ctx) => service.setRuleState(ctx.params.token, ctx.body?.state))
  route('GET', '/api/admin/rules/:token/results', 'admin', (ctx) =>
    service.ruleResults(ctx.params.token, { begin: ctx.query.get('begin') || undefined, end: ctx.query.get('end') || undefined }),
  )
  route('GET', '/api/admin/rules/:token/report', 'admin', (ctx) => service.ruleReport(ctx.params.token, ctx.query.get('begin'), ctx.query.get('end')))
  route('POST', '/api/admin/rules/:token/backtests', 'admin', (ctx) => service.requestBacktest(ctx.params.token, ctx.body?.start, ctx.body?.end))
  route('GET', '/api/admin/rules/:token/backtests/:backtest', 'admin', (ctx) => service.getBacktest(ctx.params.token, ctx.params.backtest))

  route('GET', '/api/admin/transactions/:id/rule-results', 'admin', (ctx) => service.transactionRuleResults(ctx.params.id))
  route('GET', '/api/admin/transactions/:id/enhanced', 'admin', (ctx) => service.enhancedData(ctx.params.id))
  route('POST', '/api/admin/transactions/:id/simulate', 'admin', (ctx) => {
    requireSandbox()
    return service.simulateAction(ctx.params.id, { action: ctx.body?.action, amountCents: Number(ctx.body?.amountCents) || undefined })
  })

  route('GET', '/api/admin/asa', 'admin', async () => {
    const endpoint = lithic.configured ? await service.responder('AUTH_STREAM_ACCESS').catch((err) => ({ error: err.message })) : null
    const secret = db.read().settings?.asaSecret || env.LITHIC_ASA_SECRET
    return { endpoint, secretConfigured: Boolean(secret), secretPreview: secret ? `${secret.slice(0, 10)}…${secret.slice(-4)}` : null }
  })
  route('POST', '/api/admin/asa/enroll', 'admin', (ctx) => service.enrollResponder('AUTH_STREAM_ACCESS', ctx.body?.url))
  route('DELETE', '/api/admin/asa', 'admin', () => service.disenrollResponder('AUTH_STREAM_ACCESS'))
  route('POST', '/api/admin/asa/secret', 'admin', (ctx) => service.syncAsaSecret(Boolean(ctx.body?.rotate)))

  route('GET', '/api/admin/events/subscriptions', 'admin', () => service.subscriptions())
  route('POST', '/api/admin/events/subscriptions', 'admin', (ctx) => service.createSubscription(ctx.body || {}))
  route('DELETE', '/api/admin/events/subscriptions/:token', 'admin', async (ctx) => {
    await service.deleteSubscription(ctx.params.token)
    return { ok: true }
  })
  route('POST', '/api/admin/events/subscriptions/:token/secret', 'admin', (ctx) => service.syncSubscriptionSecret(ctx.params.token, Boolean(ctx.body?.rotate)))
  route('POST', '/api/admin/events/subscriptions/:token/recover', 'admin', (ctx) => service.recoverSubscription(ctx.params.token, ctx.body?.begin))
  route('POST', '/api/admin/events/subscriptions/:token/replay', 'admin', (ctx) => service.replayMissing(ctx.params.token, ctx.body?.begin))
  route('POST', '/api/admin/events/subscriptions/:token/example', 'admin', (ctx) => service.sendExample(ctx.params.token, ctx.body?.eventType))
  route('GET', '/api/admin/events/subscriptions/:token/attempts', 'admin', (ctx) => service.subscriptionAttempts(ctx.params.token))
  route('GET', '/api/admin/events', 'admin', (ctx) => service.listEvents({ event_types: ctx.query.get('eventType') || undefined }))

  route('GET', '/api/admin/ledger', 'admin', async () => {
    const accounts = await service.financialAccounts()
    const balances = await service.balances().catch(() => ({ data: [] }))
    return { accounts, balances: balances.data || [] }
  })
  route('GET', '/api/admin/ledger/activity', 'admin', (ctx) =>
    service.accountActivity({ financial_account_token: ctx.query.get('financialAccountToken') || undefined }),
  )
  route('GET', '/api/admin/ledger/book-transfers', 'admin', () => service.bookTransfers())
  route('POST', '/api/admin/ledger/fund', 'admin', (ctx) => {
    requireSandbox()
    const amountCents = positiveInt(ctx.body?.amountCents)
    if (!amountCents) throw new AppError('Amount must be a positive number of cents.')
    return service.fundProgram({ amountCents, financialAccountToken: ctx.body?.financialAccountToken })
  })
  route('GET', '/api/admin/ledger/settlement', 'admin', (ctx) =>
    service.settlementSummary(ctx.query.get('date') || new Date(Date.now() - 86400000).toISOString().slice(0, 10)),
  )

  route('GET', '/api/admin/monitoring', 'admin', () => service.monitoringCases())
  route('PATCH', '/api/admin/monitoring/:token', 'admin', (ctx) => service.updateMonitoringCase(ctx.params.token, { status: ctx.body?.status }))
  route('PATCH', '/api/admin/cases/:id', 'admin', (ctx) =>
    db.mutate((s) => {
      const row = (s.cases || []).find((c) => c.id === ctx.params.id)
      if (!row) throw new AppError('Unknown case', 404)
      if (['OPEN', 'IN_REVIEW', 'CLOSED'].includes(ctx.body?.status)) row.status = ctx.body.status
      if (typeof ctx.body?.note === 'string') row.note = ctx.body.note.slice(0, 2000)
      return row
    }),
  )
  route('GET', '/api/admin/disputes/managed', 'admin', () => service.managedDisputes())

  route('POST', '/api/admin/transactions/:id/allocate', 'admin', (ctx) => {
    const txn = db.mutate((s) => wrapDomain(() => allocateTransaction(s, { transactionId: ctx.params.id, envelopeId: ctx.body?.envelopeId, actor: ctx.user.email })))
    service.syncRules(txn.cardholderId).catch(() => null)
    return txn
  })

  route('GET', '/api/admin/audit', 'admin', (ctx) =>
    db.auditList({
      limit: ctx.query.get('limit') || 100,
      before: ctx.query.get('before') || undefined,
      actor: ctx.query.get('actor') || undefined,
      action: ctx.query.get('action') || undefined,
    }),
  )
  route('GET', '/api/admin/backups', 'admin', () => ({ lastBackupAt: db.lastBackupAt(), backups: db.backups() }))
  route('POST', '/api/admin/backups', 'admin', () => ({ file: basename(db.backup({ keep: settings().backupKeep }) || '') }))
  route('POST', '/api/admin/outbox/deliver', 'admin', () => deliverOutbox({ db, mailer, log, ...mailOptions() }))
  route('POST', '/api/admin/disputes/:id/refresh', 'admin', (ctx) => service.refreshDispute(ctx.params.id))

  // ---------------- settings ----------------
  route('GET', '/api/admin/settings', 'admin', () => {
    const s = db.read()
    return {
      values: appSettings(s, env),
      sources: settingSources(s, env),
      server: serverConfig(env),
      stored: {
        asaSecret: Boolean(s.settings?.asaSecret),
        threeDsSecret: Boolean(s.settings?.threeDsSecret),
        tokenizationSecret: Boolean(s.settings?.tokenizationSecret),
        webhookSecrets: Object.keys(s.settings?.webhookSecrets || {}).length,
      },
      lithic: { configured: lithic.configured, environment },
      mail: { configured: mailer.configured },
      storage: { dataFile: file, lastBackupAt: db.lastBackupAt(), backups: db.backups().length },
    }
  })
  route('PATCH', '/api/admin/settings', 'admin', (ctx) => {
    const patch = wrapDomain(() => validateSettings(ctx.body || {}))
    return db.mutate((s) => {
      applySettings(s, patch)
      if ('organisation' in patch && s.operator) s.operator = { ...s.operator, org: patch.organisation || '' }
      return appSettings(s, env)
    })
  })
  route('POST', '/api/admin/settings/test-email', 'admin', async (ctx) => {
    if (!mailer.configured) throw new AppError('Email is not configured. Set SMTP_URL in .env and restart.', 409)
    const { programName, mailFrom, publicUrl } = settings()
    await mailer.send({
      to: ctx.user.email,
      from: mailFrom,
      subject: `${programName}: test email`,
      text: `Email delivery from ${programName} works.${publicUrl ? `\n${publicUrl}` : ''}`,
    })
    return { sentTo: ctx.user.email }
  })
  route('PATCH', '/api/admin/profile', 'admin', (ctx) => {
    const name = String(ctx.body?.name || '').trim()
    if (!name || name.length > 80) throw new AppError('Name must be 1 to 80 characters.')
    return db.mutate((s) => {
      const user = s.users.find((u) => u.id === ctx.user.id)
      user.name = name
      return publicUser(user)
    })
  })

  registerResponderRoutes({ route, db, lithic, env, environment, AppError })
  registerLedgerRoutes({ route, lithic, AppError })

  // ---------------- dispatcher ----------------

  async function handle(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })
    const reqId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 64)
    const started = process.hrtime.bigint()
    res.setHeader('X-Request-Id', reqId)
    res.on('close', () => {
      if (url.pathname === '/api/health') return
      log.info?.('request', {
        reqId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
        user: req.stipendUser || undefined,
      })
    })
    const parts = url.pathname.split('/').filter(Boolean)
    let match = null
    let methodMismatch = false
    for (const r of routes) {
      if (r.parts.length !== parts.length) continue
      const params = {}
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(parts[i])
          return true
        }
        return p === parts[i]
      })
      if (!ok) continue
      if (r.method !== req.method) {
        methodMismatch = true
        continue
      }
      match = { ...r, params }
      break
    }
    if (!match) return send(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'Method not allowed' : 'Not found' })

    try {
      const ctx = { req, res, params: match.params, query: url.searchParams, user: null, raw: '', body: null }
      if (match.access !== 'public') {
        ctx.user = currentUser(req)
        if (!ctx.user) throw new AppError('Sign in required', 401)
        req.stipendUser = ctx.user.id
        if (match.access === 'admin' && ctx.user.role !== 'admin') throw new AppError('Admins only', 403)
        if (req.method !== 'GET' && !sameOrigin(req)) throw new AppError('Cross-site request blocked', 403)
      } else if (url.pathname.startsWith('/api/auth/') && req.method !== 'GET' && !sameOrigin(req)) {
        throw new AppError('Cross-site request blocked', 403)
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        ctx.raw = await readRaw(req, match.access === 'public' ? PUBLIC_BODY_LIMIT : APP_BODY_LIMIT)
        ctx.body = parseMaybeJson(ctx.raw)
      }
      let result
      try {
        result = await match.handler(ctx)
      } catch (err) {
        if (match.access === 'admin' && req.method !== 'GET') audit(ctx, `${req.method} ${match.path}`, { outcome: `error ${err.status || 500}` })
        throw err
      }
      if (match.access === 'admin' && req.method !== 'GET') audit(ctx, `${req.method} ${match.path}`)
      if (!res.writableEnded && !res.headersSent && result !== undefined) send(res, 200, result ?? { ok: true })
    } catch (err) {
      if (res.headersSent) return res.end()
      if (err instanceof AppError) return send(res, err.status, { error: err.message, details: err.details })
      if (err instanceof LithicError) {
        return send(res, err.status === 404 || err.status === 409 || err.status === 422 || err.status === 400 ? err.status : 502, {
          error: `Lithic: ${err.message}`,
          lithicStatus: err.status,
          details: err.payload,
        })
      }
      log.error?.('unhandled error', { reqId, path: url.pathname, err })
      send(res, err.status || 500, { error: err.message || 'Internal error', reqId })
    }
  }

  return {
    handle,
    db,
    service,
    close() {
      for (const handle of intervals) clearInterval(handle)
      db.close()
    },
    get firstRunCredentials() {
      return credentials
    },
  }
}

const SECRET_KEYS = /password|secret|base64|content|token|otp/i

/** Strip secrets and bulky payloads before writing request bodies to the audit log. */
function sanitize(body) {
  if (!body || typeof body !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]'
    else if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v
    else if (Array.isArray(v)) out[k] = v.length > 20 ? `[${v.length} items]` : v
    else out[k] = v
  }
  return out
}

/** Domain functions throw plain errors with a status; surface them as API errors. */
function wrapDomain(fn) {
  try {
    return fn()
  } catch (err) {
    if (err.status && !(err instanceof AppError)) throw new AppError(err.message, err.status)
    throw err
  }
}

function wantsXml(req) {
  return /application\/xml|text\/xml/.test(String(req.headers.accept || ''))
}

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return !origin
  try {
    const o = new URL(origin)
    const host = req.headers['x-forwarded-host'] || req.headers.host
    return o.host === host
  } catch {
    return false
  }
}

function isSecure(req, env) {
  return env.STIPEND_SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https'
}

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendRaw(res, status, body, type) {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.end(body)
  return undefined
}

function parseMaybeJson(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new AppError('Request body too large', 413))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

export function printCredentials(credentials, log = console) {
  if (!credentials?.length) return
  const lines = credentials.map((c) => `  ${c.role.padEnd(10)} ${c.email}  ${c.password}`)
  log.log(['', '  Stipend first-run logins (shown once, change after sign-in):', ...lines, ''].join('\n'))
}

export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
