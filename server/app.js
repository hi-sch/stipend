import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createLithic, isUuid, LithicError } from './lithicApi.js'
import { AppError, createLithicService } from './lithicService.js'
import { seedDatabase } from './seed.js'
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
  cashStateFor,
  cashUsageFor,
  createCashRule,
  decideCash,
  deleteCashRule,
  listCashRules,
  updateCashRule,
  withCash,
  id,
  isDuplicateCredit,
  recallCredit,
  resolveBeneficiary,
  virtualIbanFor,
} from './domain.js'
import { verifyHmac, verifyLithicWebhook } from './hmacNode.js'
import { buildCamt029, buildPain002, parseCamt056, parsePain001 } from '../src/lib/pain001.js'
import { defaultCountriesFor } from '../src/data/agencies.js'
import { loggerFromEnv } from './log.js'
import { createMailer, deliverOutbox, requeueStuck } from './mailer.js'
import { createXsdValidator } from './xsd.js'
import { registerResponderRoutes } from './responders.js'
import { registerLedgerRoutes } from './ledgerRoutes.js'
import { registerCardholderRoutes } from './cardholderRoutes.js'
import { appSettings, serverConfig, settingSources, validateSettings } from './settings.js'
import { createPool } from './db/pool.js'
import { configureSecretBox, secretBox } from './db/secrets.js'
import { migrate } from './db/migrate.js'
import { createSessionStore } from './db/sessions.js'
import { createVersionStream, bumpVersion, currentVersion } from './db/version.js'
import { appendAudit, auditList, verifyAuditChain } from './db/audit.js'
import { applyAppSettings, getMeta, getProgramSettings, loadSettingsState, patchMeta } from './db/meta.js'
import { openBreaks, resolveBreak, runReconciliation } from './db/recon.js'
import { applyApproved, decide as decideApproval, expireStale, getApproval, listPending, needsApproval, requestApproval, SENSITIVE_ACTIONS } from './db/approvals.js'
import { createOidc, OIDC_COOKIE } from './oidc.js'
import {
  cardholdersForConsole,
  creditsFor,
  disputesFor,
  envelopesFor,
  getCardholder,
  getCredit,
  listCardholders,
  listConnections,
  transactionsFor,
} from './db/repo.js'

const PUBLIC_BODY_LIMIT = 1024 * 1024
const APP_BODY_LIMIT = 12 * 1024 * 1024

const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const startedAt = Date.now()

/**
 * The API.
 *
 * createApp is async because the database is: it connects, migrates and seeds before it
 * will answer anything. A pod that cannot reach Postgres fails to start rather than
 * serving errors, and its readiness probe keeps it out of the Service until it can.
 */
export async function createApp({
  env = {},
  lithic: lithicOverride,
  log = loggerFromEnv(env),
  mailer = createMailer(env),
  timers = true,
  migrate: runMigrations = true,
  seed: runSeed = true,
} = {}) {
  // Before anything reads or writes a secret, and from this env rather than process.env:
  // standalone.js merges .env over the process environment and hands the result here.
  configureSecretBox(env, log)

  const db = createPool({ url: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX) || 10, log })

  if (runMigrations) await migrate({ db, log })

  let credentials = []
  if (runSeed) {
    const seeded = await db.tx((c) => seedDatabase({ client: c, env, log }))
    credentials = seeded.credentials
  }

  const settings = async () => appSettings(await loadSettingsState(db.pool), env)
  const mailOptions = async () => {
    const s = await settings()
    return { publicUrl: s.publicUrl || undefined, from: s.mailFrom }
  }

  // Two-operator approval for sensitive writes. See the dispatcher for why this is opt-in.
  const approvalsRequired = env.STIPEND_REQUIRE_APPROVAL === '1'

  const environment = env.LITHIC_ENV === 'production' ? 'production' : 'sandbox'
  const lithic = lithicOverride || createLithic({ apiKey: env.LITHIC_API_KEY || '', environment })
  const service = createLithicService({ lithic, db, env })
  const sessions = createSessionStore(db)
  const oidc = createOidc({ env, log })
  const xsd = createXsdValidator({ log })
  const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 8 })
  // Spraying one common password across many accounts never repeats an address-and-email
  // pair, so the limiter above never fires on it. This one counts attempts from a source
  // whatever account they name.
  const loginSourceLimiter = createRateLimiter({ windowMs: 60_000, max: 30 })
  const publicLimiters = new Map(Object.entries(PUBLIC_RATE_LIMITS).map(([path, limit]) => [path, createRateLimiter(limit)]))
  const syncThrottle = new Map()
  const routes = []

  /**
   * The address a request came from.
   *
   * Behind an ingress, req.socket.remoteAddress is the ingress controller's own pod
   * address, identical for every external client — which made the login limiter's key
   * effectively per-email, so password spraying across accounts was not limited at all.
   *
   * The ingress appends the address it saw to X-Forwarded-For, so the rightmost entry is
   * the real client; everything to its left was sent by the client and may say anything.
   *
   * Off unless STIPEND_TRUST_PROXY is set, because with no proxy in front the socket
   * address is the truth and honouring the header would let anyone forge an address and
   * step around every limit here.
   */
  const trustProxy = env.STIPEND_TRUST_PROXY === '1'
  function clientIp(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      if (forwarded.length) return forwarded[forwarded.length - 1]
    }
    return req.socket?.remoteAddress || 'unknown'
  }

  const versions = createVersionStream({ db, log })
  await versions.start()

  // Refresh Lithic reachability and ASA enrollment on start, so the console never shows a stale "idle".
  if (lithic.configured) service.status().catch(() => null)

  // Mail claimed by a pod that was killed mid-send is returned to the queue.
  requeueStuck({ db }).catch((err) => log.warn?.('could not requeue stuck mail', { err }))

  const intervals = []
  if (timers) {
    const every = (ms, fn) => {
      const handle = setInterval(() => Promise.resolve().then(fn).catch((err) => log.error?.('background job failed', { err })), ms)
      handle.unref?.()
      intervals.push(handle)
    }
    every(15 * 60 * 1000, () => sessions.purgeExpired())
    every(15 * 60 * 1000, () => expireStale(db.pool))
    every(15000, async () => deliverOutbox({ db, mailer, log, ...(await mailOptions()) }))
    // Reconciliation runs on a schedule as well as on demand; breaks wait for an operator.
    every(60 * 60 * 1000, () => runReconciliation({ db, log }))
  }

  /** Every operator write and every sign-in lands in the audit chain. */
  async function audit(ctx, action, { outcome = 'ok', target, details } = {}) {
    try {
      await appendAudit(db, {
        actor: ctx.user?.email || ctx.actor || 'anonymous',
        action,
        target: target ?? (Object.keys(ctx.params || {}).length ? JSON.stringify(ctx.params) : null),
        outcome,
        details: details === undefined ? sanitize(ctx.body) : details,
        ip: ctx.req?.socket?.remoteAddress || null,
      })
    } catch (err) {
      log.error?.('audit write failed', { err })
    }
  }

  const route = (method, path, access, handler, options = {}) =>
    routes.push({ method, path, parts: path.split('/').filter(Boolean), access, handler, approval: options.approval })

  // ---------------- helpers ----------------

  async function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const session = await sessions.get(token)
    if (!session) return null
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND disabled_at IS NULL', [session.userId])
    if (!rows.length) return null
    const u = rows[0]
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      cardholderId: u.cardholder_id,
      passwordHash: u.password_hash,
      mustChangePassword: u.must_change_password,
      federated: Boolean(u.oidc_subject),
      sessionToken: token,
    }
  }

  function publicUser(user) {
    if (!user) return null
    const { passwordHash, sessionToken, ...rest } = user
    return rest
  }

  async function holderIdFor(ctx) {
    if (ctx.user.role === 'cardholder') return ctx.user.cardholderId
    const requested = ctx.query.get('cardholderId') || ctx.body?.cardholderId || ctx.req.headers['x-stipend-cardholder']
    const holderId = requested || (await listCardholders(db.pool))[0]?.id
    if (!(await getCardholder(db.pool, holderId))) throw new AppError('Unknown cardholder', 404)
    return holderId
  }

  /** What cardholders may see about the program running their card. */
  async function programInfo() {
    const { programName, organisation, supportEmail, supportPhone } = await settings()
    return { programName, organisation, supportEmail, supportPhone }
  }

  /**
   * The payload the apps read. Its shape is deliberately unchanged from the document
   * version: the frontend and its contract are untouched by the move to Postgres.
   */
  async function scopeState(user, holderId) {
    const mask = (conn) => {
      const { hmacSecret, ...rest } = conn
      return { ...rest, hmacSecretPreview: hmacSecret ? `${hmacSecret.slice(0, 8)}…${hmacSecret.slice(-4)}` : null }
    }

    const [version, lithicState, program, holderRow, connections, envelopes, transactions, credits, disputes] = await Promise.all([
      currentVersion(db),
      getMeta(db.pool, 'lithic', {}),
      programInfo(),
      getCardholder(db.pool, holderId),
      listConnections(db.pool),
      envelopesFor(db.pool, holderId),
      transactionsFor(db.pool, holderId),
      creditsFor(db.pool, holderId),
      disputesFor(db.pool, holderId),
    ])

    const [holder, cashUsage, notifications, outbox, activeSessions, programSettings] = await Promise.all([
      withCash(db.pool, holderRow),
      cashUsageFor(db.pool, holderId),
      db.query('SELECT * FROM notifications WHERE cardholder_id = $1 ORDER BY created_at DESC', [holderId]),
      db.query('SELECT * FROM email_outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 100', [holderRow?.email ?? '']),
      sessions.countForUser(user.id),
      getProgramSettings(db.pool),
    ])

    const base = {
      version,
      environment,
      lithic: { ...lithicState, configured: lithic.configured, environment, asaSecretConfigured: Boolean(programSettings.asaSecret || env.LITHIC_ASA_SECRET) },
      user: publicUser(user),
      cardholder: holder,
      program,
      cashUsage,
      envelopes,
      transactions: transactions.map(({ asaResponse, ...t }) => t),
      credits,
      disputes,
      notifications: notifications.rows.map((n) => ({ id: n.id, holderId: n.cardholder_id, title: n.title, body: n.body, kind: n.kind, at: n.created_at, read: Boolean(n.read_at) })),
      emailOutbox: outbox.rows.map((m) => ({ id: m.id, to: m.to_address, subject: m.subject, body: m.body, at: m.created_at, status: String(m.status).toLowerCase(), attempts: m.attempts, error: m.last_error })),
      emailDelivery: mailer.configured,
      activeSessions,
    }

    if (user.role !== 'admin') {
      return {
        ...base,
        connections: connections
          .filter((c) => base.envelopes.some((e) => e.connectionId === c.id) || base.credits.some((cr) => cr.connectionId === c.id))
          .map((c) => ({ id: c.id, name: c.name, agency: c.agency, mccs: c.mccs, countries: c.countries, protocol: c.protocol, purpose: c.purpose })),
      }
    }

    const [operator, appSettingValues, allCardholders, rules, allCredits, allTransactions, allDisputes, cases, asaLog, webhooks, reports, allOutbox, allEnvelopes] =
      await Promise.all([
        getMeta(db.pool, 'operator', null),
        settings(),
        // One query, not two more per cardholder.
        cardholdersForConsole(db.pool),
        listCashRules(db.pool),
        // The name travels with the row. The console used to find it by searching a list of
        // every cardholder in the program, which is the only reason that list has to be sent
        // to every operator at all.
        db.query(`
          SELECT c.*, h.first_name AS holder_first_name, h.last_name AS holder_last_name
            FROM credits c LEFT JOIN cardholders h ON h.id = c.cardholder_id
           ORDER BY c.created_at DESC LIMIT 500`),
        db.query(`
          SELECT t.*, h.first_name AS holder_first_name, h.last_name AS holder_last_name
            FROM transactions t LEFT JOIN cardholders h ON h.id = t.cardholder_id
           ORDER BY t.created_at DESC LIMIT 500`),
        db.query('SELECT * FROM disputes ORDER BY created_at DESC LIMIT 200'),
        db.query(`
          SELECT k.*, h.first_name AS holder_first_name, h.last_name AS holder_last_name
            FROM cases k LEFT JOIN cardholders h ON h.id = k.cardholder_id
           ORDER BY k.created_at DESC LIMIT 500`),
        db.query('SELECT * FROM asa_log ORDER BY at DESC LIMIT 300'),
        db.query('SELECT * FROM webhooks ORDER BY received_at DESC LIMIT 100'),
        db.query('SELECT id, kind, connection_id, created_at FROM reports ORDER BY created_at DESC LIMIT 300'),
        db.query('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 100'),
        // Only what the Cases page needs to offer an envelope to allocate a stray refund
        // to: the envelopes of cardholders with a case still open, three columns of them.
        // Every envelope in the program, ten columns wide, was the second largest thing in
        // this payload and grew with the number of cardholders.
        db.query(`
          SELECT id, cardholder_id, connection_name
            FROM envelopes
           WHERE cardholder_id IN (SELECT cardholder_id FROM cases WHERE status <> 'CLOSED' AND cardholder_id IS NOT NULL)`),
      ])

    return {
      ...base,
      operator,
      appSettings: appSettingValues,
      connections: connections.map(mask),
      // cardholdersForConsole already returns cash, summary and cashUsage for every
      // cardholder, in one query with two LATERAL joins. Re-deriving them per row cost three
      // or four more round trips each — about two thousand queries for five hundred
      // cardholders — on every operator page load, and on every live update after a write.
      // repo.test.js asserts the single query and the old per-row path agree.
      //
      // What is sent is what the list pages read. The phone number, the IBAN, the Lithic
      // tokens, eleven of the fifteen card fields and who decided a cash request are read by
      // the detail page alone, which fetches them from /api/admin/cardholders/:id. They were
      // about half of every row, sent for every cardholder to every operator on every update.
      cardholders: allCardholders.map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        city: c.city,
        country: c.country,
        beneficiaryRef: c.beneficiaryRef,
        kyc: { status: c.kyc?.status },
        card: c.card?.token ? { token: c.card.token, lastFour: c.card.lastFour, state: c.card.state } : {},
        // reason and requestedAt are here because the Cases page shows a pending request
        // before anyone opens the cardholder.
        cash: {
          status: c.cash?.status ?? 'NONE',
          ruleId: c.cash?.ruleId,
          reason: c.cash?.reason,
          requestedAt: c.cash?.requestedAt,
          requestedCents: c.cash?.requestedCents,
          requestedPeriod: c.cash?.requestedPeriod,
        },
        cashUsage: c.cashUsage ? { usedCents: c.cashUsage.usedCents, limitCents: c.cashUsage.limitCents } : null,
        summary: c.summary,
      })),
      cashRules: await Promise.all(rules.map(async (r) => ({ ...r, memberIds: (await cashRuleMembers(db.pool, r.id)).map((h) => h.id) }))),
      allCredits: allCredits.rows.map((r) => ({ id: r.id, created: r.created_at, connectionId: r.connection_id, cardholderId: r.cardholder_id, cardholderName: r.holder_first_name ? `${r.holder_first_name} ${r.holder_last_name}` : null, envelopeId: r.envelope_id, amountCents: r.amount_cents, recalledCents: r.recalled_cents, endToEndId: r.end_to_end_id, protocol: r.protocol, remittance: r.remittance, status: r.status, lithicTransfer: r.lithic_transfer, recall: r.recall })),
      allTransactions: allTransactions.rows.map((r) => ({ id: r.id, cardholderId: r.cardholder_id, cardholderName: r.holder_first_name ? `${r.holder_first_name} ${r.holder_last_name}` : null, created: r.created_at, kind: r.kind, status: r.status, result: r.result, detailedResults: r.detailed_results, merchant: r.merchant, amountCents: r.amount_cents, envelopeId: r.envelope_id, cashCents: r.cash_cents, unallocatedCents: r.unallocated_cents, review: r.review, note: r.note, live: r.live })),
      allDisputes: allDisputes.rows.map((r) => ({ id: r.id, cardholderId: r.cardholder_id, transactionId: r.transaction_id, status: r.status, reason: r.reason, amountCents: r.amount_cents, merchant: r.merchant, created: r.created_at })),
      cases: cases.rows.map((r) => ({ id: r.id, at: r.created_at, cardholderId: r.cardholder_id, cardholderName: r.holder_first_name ? `${r.holder_first_name} ${r.holder_last_name}` : null, transactionId: r.transaction_id, kind: r.kind, title: r.title, merchant: r.merchant, mcc: r.mcc, amountCents: r.amount_cents, detailedResults: r.detailed_results, status: r.status, resolution: r.resolution })),
      asaLog: asaLog.rows.map((r) => ({ id: r.id, at: r.at, cardholderId: r.cardholder_id, merchant: r.merchant, mcc: r.mcc, amountCents: r.amount_cents, decision: r.decision, response: r.response, source: r.source })),
      webhooks: webhooks.rows.map((r) => ({ id: r.id, messageId: r.message_id, at: r.received_at, verified: r.verified, duplicate: r.duplicate, eventType: r.event_type, event: r.payload })),
      reports: reports.rows.map((r) => ({ id: r.id, kind: r.kind, connectionId: r.connection_id, createdAt: r.created_at })),
      allOutbox: allOutbox.rows.map((m) => ({ id: m.id, to: m.to_address, subject: m.subject, at: m.created_at, status: String(m.status).toLowerCase(), attempts: m.attempts, error: m.last_error })),
      allEnvelopes: allEnvelopes.rows.map((e) => ({ id: e.id, cardholderId: e.cardholder_id, connectionName: e.connection_name })),
      mail: { configured: mailer.configured },
    }
  }

  // ---------------- credits and recalls ----------------

  function afterCredit(credits) {
    const holders = new Set()
    for (const credit of credits) {
      holders.add(credit.cardholderId)
      getCardholder(db.pool, credit.cardholderId)
        .then((holder) =>
          service.disburse({ amountCents: credit.amountCents, memo: credit.remittance, accountToken: holder?.lithicAccount, externalId: credit.endToEndId }),
        )
        .then((transfer) => db.query('UPDATE credits SET lithic_transfer = $2::jsonb WHERE id = $1', [credit.id, JSON.stringify(transfer)]))
        .catch((err) => log.warn?.('book transfer failed', { creditId: credit.id, err }))
    }
    for (const holderId of holders) service.syncRules(holderId).catch(() => null)
  }

  /** Credit a batch of lines from one connection; returns per-line ISO statuses and a stored pain.002. */
  async function processCredits(connection, { msgId, pmtInfId, lines, protocol }) {
    const statuses = []
    const created = []

    // One transaction for the whole batch: a file is accepted or rejected as a unit, and a
    // duplicate inside the same file is caught by `seen` before the database sees it.
    await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM connections WHERE id = $1 FOR UPDATE', [connection.id])
      const conn = (await listConnections(c)).find((x) => x.id === rows[0].id)
      const seen = new Set()

      for (const line of lines) {
        const reject = (reason, detail) => statuses.push({ endToEndId: line.endToEndId, status: 'RJCT', reason, detail })

        if (line.errors?.length) { reject('FF01', line.errors.join('; ')); continue }
        if ((line.currency || 'EUR') !== 'EUR') { reject('AM11', `Currency ${line.currency} not supported`); continue }
        if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) { reject('AM12', 'Amount must be a positive number of cents'); continue }
        if (!line.endToEndId) { reject('FF01', 'EndToEndId is required'); continue }
        if (seen.has(line.endToEndId) || (await isDuplicateCredit(c, conn.id, line.endToEndId))) {
          reject('AM05', `EndToEndId ${line.endToEndId} was already credited`)
          continue
        }

        const holder = await resolveBeneficiary(c, { beneficiaryRef: line.beneficiaryRef, iban: line.creditorIban })
        if (!holder) { reject('BE06', 'Beneficiary reference or IBAN not known to Stipend'); continue }

        seen.add(line.endToEndId)
        created.push(
          await applyCredit(c, {
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
    await db.query(
      `INSERT INTO reports (id, kind, connection_id, content) VALUES ($1,'pain.002',$2,$3)`,
      [reportId, connection.id, report.xml],
    )

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

  async function processRecalls(connection, raw) {
    const parsed = parseCamt056(raw)
    if (parsed.errors.length && !parsed.cases.length) throw new AppError(parsed.errors.join('; '), 400)

    const results = []
    const reversals = []

    await db.tx(async (c) => {
      for (const item of parsed.cases) {
        const { rows } = await c.query('SELECT id FROM credits WHERE connection_id = $1 AND end_to_end_id = $2', [connection.id, item.originalEndToEndId])
        if (!rows.length) {
          results.push({ originalEndToEndId: item.originalEndToEndId, status: 'RJCR', reason: 'NOOR', detail: 'Original transaction not found' })
          continue
        }

        const credit = await getCredit(c, rows[0].id)
        const outcome = await recallCredit(c, { credit, reason: item.reason })
        results.push({ originalEndToEndId: item.originalEndToEndId, status: outcome.status, reason: outcome.reason, detail: outcome.detail, recalledCents: outcome.recalledCents })
        if (outcome.status === 'CNCL' && credit.lithicTransfer?.token) {
          reversals.push({ creditId: credit.id, token: credit.lithicTransfer.token, holderId: credit.cardholderId })
        }
      }
    })

    const xml = buildCamt029({ originalMsgId: parsed.msgId, results })
    const reportId = id('rpt')
    await db.query(`INSERT INTO reports (id, kind, connection_id, content) VALUES ($1,'camt.029',$2,$3)`, [reportId, connection.id, xml])

    for (const r of reversals) {
      service
        .reverseTransfer(r.token, 'Agency recall')
        .then((res) => db.query(`UPDATE credits SET recall = COALESCE(recall,'{}'::jsonb) || jsonb_build_object('reversal', $2::jsonb) WHERE id = $1`, [r.creditId, JSON.stringify(res)]))
        .catch(() => null)
      service.syncRules(r.holderId).catch(() => null)
    }

    return { results, xml, reportId }
  }

  async function connectionOrThrow(connectionId) {
    const conn = (await listConnections(db.pool)).find((c) => c.id === connectionId)
    if (!conn) throw new AppError('Unknown connection', 404)
    return conn
  }

  async function verifyConnectionSignature(ctx) {
    const conn = await connectionOrThrow(ctx.params.connectionId)
    const header = ctx.req.headers['x-stipend-signature'] || ctx.req.headers['x-hmac-sha256']
    if (!verifyHmac(conn.hmacSecret, ctx.raw, header)) throw new AppError('Invalid HMAC signature', 401)
    if (conn.status === 'paused') throw new AppError('Connection is paused', 409)
    return conn
  }

  async function lithicSecrets() {
    const s = await getProgramSettings(db.pool)
    return [env.LITHIC_WEBHOOK_SECRET, ...Object.values(s.webhookSecrets || {})].filter(Boolean)
  }

  function requireSandbox() {
    if (environment !== 'sandbox') throw new AppError('Simulations are only available in the Lithic sandbox.', 403)
  }

  // ---------------- health ----------------

  /**
   * Liveness deliberately does not touch the database. Restarting a pod does not fix a
   * database outage; it only removes capacity during one.
   */
  route('GET', '/api/health/live', 'public', (ctx) => {
    send(ctx.res, 200, { status: 'ok', version: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000) })
    return undefined
  })

  /** Readiness does check it, so a pod that cannot reach Postgres leaves the Service. */
  route('GET', '/api/health/ready', 'public', async (ctx) => {
    const ok = await db.healthy()
    send(ctx.res, ok ? 200 : 503, { status: ok ? 'ready' : 'not-ready', db: ok })
    return undefined
  })

  route('GET', '/api/health', 'public', async (ctx) => {
    const dbOk = await db.healthy()
    let version = null
    if (dbOk) version = await currentVersion(db).catch(() => null)

    const lithicState = dbOk ? await getMeta(db.pool, 'lithic', {}).catch(() => ({})) : {}
    const degraded = !dbOk || (lithic.configured && lithicState.status === 'error')

    send(ctx.res, dbOk ? 200 : 503, {
      status: !dbOk ? 'down' : degraded ? 'degraded' : 'ok',
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      db: {
        ok: dbOk,
        version,
        // Connections this process is holding. A pool that sits at its maximum with callers
        // waiting is the difference between "the database is slow" and "this process has
        // leaked its connections and nothing else can get one" — which is invisible from
        // outside, and expensive to work out after the fact.
        // `held` counts connections checked out right now and oldestMs how long the oldest
        // has been out. A held count that only grows, with an oldestMs in the hours, is a
        // leak — and the pool's own totals cannot show it, because a connection nobody gave
        // back is not idle as far as the pool is concerned.
        pool: { total: db.pool.totalCount, idle: db.pool.idleCount, waiting: db.pool.waitingCount, max: db.pool.options?.max ?? null, ...(db.heldStats?.() ?? {}) },
      },
      lithic: { configured: lithic.configured, environment, status: lithicState.status || 'unknown', checkedAt: lithicState.checkedAt || null },
      xsdValidation: xsd.available,
    })
    return undefined
  })

  // ---------------- public ----------------

  route('POST', '/api/asa', 'public', async (ctx) => {
    const programSettings = await getProgramSettings(db.pool)
    const secret = programSettings.asaSecret || env.LITHIC_ASA_SECRET
    if (secret) {
      const check = verifyLithicWebhook(secret, ctx.raw, ctx.req.headers)
      if (!check.ok) throw new AppError(`Invalid ASA signature (${check.reason})`, 401)
    } else if (environment === 'production') {
      throw new AppError('ASA secret not configured', 401)
    }
    try {
      return await db.tx((c) => authorizeAsa(c, ctx.body || {}, { source: 'asa' }))
    } catch (err) {
      log.error?.('ASA decision failed', { err })
      return { token: ctx.body?.token, result: 'UNAUTHORIZED_MERCHANT' }
    }
  })

  route('POST', '/api/hooks/credits/:connectionId', 'public', async (ctx) => {
    const conn = await verifyConnectionSignature(ctx)
    const parsed = parseCreditBody(ctx.raw, ctx.body)
    const preferXml = parsed.protocol === 'pain001' && wantsXml(ctx.req)

    if (parsed.fileErrors.length) {
      const lines = parsed.lines.length
        ? parsed.lines.map((l) => ({ ...l, errors: [...parsed.fileErrors, ...(l.errors || [])] }))
        : [{ endToEndId: '', errors: parsed.fileErrors }]
      return respondCredits(ctx, await processCredits(conn, { ...parsed, lines }), { preferXml })
    }
    return respondCredits(ctx, await processCredits(conn, parsed), { preferXml })
  })

  route('POST', '/api/hooks/recalls/:connectionId', 'public', async (ctx) => {
    const conn = await verifyConnectionSignature(ctx)
    const checked = xsd.validate(ctx.raw, 'camt.056.001.08')
    if (!checked.ok) throw new AppError(`camt.056 does not match the ISO 20022 schema: ${checked.errors.join('; ')}`, 400, { errors: checked.errors })

    const result = await processRecalls(conn, ctx.raw)
    if (wantsXml(ctx.req)) return sendRaw(ctx.res, 200, result.xml, 'application/xml')
    return { results: result.results, reportId: result.reportId }
  })

  route('POST', '/api/webhooks/lithic', 'public', async (ctx) => {
    const secrets = await lithicSecrets()
    let verified = false
    if (secrets.length) {
      verified = secrets.some((secret) => verifyLithicWebhook(secret, ctx.raw, ctx.req.headers).ok)
      if (!verified) throw new AppError('Invalid Lithic webhook signature', 401)
    } else if (environment === 'production') {
      throw new AppError('Webhook secret not configured', 401)
    }

    const messageId = ctx.req.headers['webhook-id'] || null

    // The unique index decides who is first. Two replicas receiving the same retry cannot
    // both conclude they are, which the old scan over recent webhooks could not guarantee.
    const { rows } = await db.query(
      `INSERT INTO webhooks (id, message_id, event_type, verified, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [id('whk'), messageId, ctx.body?.event_type || null, verified, JSON.stringify(ctx.body ?? {})],
    )
    const duplicate = messageId ? rows.length === 0 : false
    if (duplicate) await db.query('UPDATE webhooks SET duplicate = true WHERE message_id = $1', [messageId])

    if (!duplicate && ctx.body) {
      service.handleEvent(ctx.body).catch((err) => log.error?.('event handling failed', { eventType: ctx.body.event_type, err }))
    }
    return { ok: true, verified }
  })

  // ---------------- session ----------------

  route('POST', '/api/auth/login', 'public', async (ctx) => {
    const email = String(ctx.body?.email || '').trim().toLowerCase()
    const ip = clientIp(ctx.req)
    // Both: the first catches a brute force against one account, the second a spray across
    // many. Short-circuiting is deliberate — once the source is over its ceiling there is
    // no reason to keep counting per-account attempts from it.
    if (!loginSourceLimiter.allow(ip) || !loginLimiter.allow(`${ip}|${email}`)) {
      ctx.res.setHeader('Retry-After', '60')
      throw new AppError('Too many attempts. Wait a minute and try again.', 429)
    }

    const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = $1 AND disabled_at IS NULL', [email])
    const user = rows[0]
    const ok = user && user.password_hash && verifyPassword(String(ctx.body?.password || ''), user.password_hash)

    if (!ok) {
      await audit({ ...ctx, actor: email || 'anonymous' }, 'auth.login', { outcome: 'denied', details: null })
      throw new AppError('Email or password is incorrect.', 401)
    }

    const shaped = { id: user.id, email: user.email, name: user.name, role: user.role, cardholderId: user.cardholder_id, mustChangePassword: user.must_change_password }
    await audit({ ...ctx, user: shaped }, 'auth.login', { details: null })

    const token = await sessions.create(shaped, { ip, userAgent: ctx.req.headers['user-agent'] || null })
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    ctx.res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(ctx.req, env) }))
    return { user: shaped }
  })

  route('POST', '/api/auth/logout', 'public', async (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]
    if (token) await sessions.destroy(token)
    ctx.res.setHeader('Set-Cookie', clearSessionCookie())
    return { ok: true }
  })

  route('GET', '/api/auth/session', 'public', async (ctx) => ({ user: publicUser(await currentUser(ctx.req)) }))

  // ---------------- operator single sign-on ----------------

  route('GET', '/api/auth/oidc', 'public', async (ctx) => {
    const { publicUrl } = await settings()
    const redirectUri = env.OIDC_REDIRECT_URI || `${publicUrl || originOf(ctx.req)}/api/auth/oidc/callback`
    const { url, cookie } = await oidc.begin({ redirectUri, returnTo: ctx.query.get('returnTo') || '/' })

    ctx.res.setHeader('Set-Cookie', `${OIDC_COOKIE}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${isSecure(ctx.req, env) ? '; Secure' : ''}`)
    ctx.res.statusCode = 302
    ctx.res.setHeader('Location', url)
    ctx.res.end()
    return undefined
  })

  route('GET', '/api/auth/oidc/callback', 'public', async (ctx) => {
    const { publicUrl } = await settings()
    const redirectUri = env.OIDC_REDIRECT_URI || `${publicUrl || originOf(ctx.req)}/api/auth/oidc/callback`
    const cookieValue = parseCookies(ctx.req.headers.cookie)[OIDC_COOKIE]

    let identity
    try {
      identity = await oidc.complete({ query: ctx.query, cookieValue, redirectUri })
    } catch (err) {
      await audit({ ...ctx, actor: 'oidc' }, 'auth.oidc', { outcome: 'denied', details: { error: err.message } })
      throw err
    }

    // An operator is matched on the issuer and subject, and adopted by email the first time
    // they sign in so an account created by hand does not become a duplicate.
    const user = await db.tx(async (c) => {
      const bySubject = await c.query('SELECT * FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2', [identity.issuer, identity.subject])
      if (bySubject.rows.length) return bySubject.rows[0]

      const byEmail = await c.query('SELECT * FROM users WHERE lower(email) = $1', [identity.email])
      if (byEmail.rows.length) {
        const existing = byEmail.rows[0]
        if (existing.role !== 'admin') throw new AppError('This address belongs to a cardholder, who signs in with a password.', 403)
        const linked = await c.query(
          `UPDATE users SET oidc_issuer = $2, oidc_subject = $3, name = COALESCE(NULLIF($4,''), name), must_change_password = false
            WHERE id = $1 RETURNING *`,
          [existing.id, identity.issuer, identity.subject, identity.name],
        )
        return linked.rows[0]
      }

      const created = await c.query(
        `INSERT INTO users (id, email, name, role, oidc_issuer, oidc_subject)
         VALUES ($1,$2,$3,'admin',$4,$5) RETURNING *`,
        [id('usr'), identity.email, identity.name, identity.issuer, identity.subject],
      )
      return created.rows[0]
    })

    if (user.disabled_at) throw new AppError('This account is disabled.', 403)

    const shaped = { id: user.id, email: user.email, name: user.name, role: user.role, cardholderId: user.cardholder_id }
    await audit({ ...ctx, user: shaped }, 'auth.oidc', { details: { issuer: identity.issuer } })

    const token = await sessions.create(shaped, { ip: ctx.req.socket?.remoteAddress, userAgent: ctx.req.headers['user-agent'] || null })
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])

    ctx.res.setHeader('Set-Cookie', [
      sessionCookie(token, { secure: isSecure(ctx.req, env) }),
      `${OIDC_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    ])
    ctx.res.statusCode = 302
    ctx.res.setHeader('Location', identity.returnTo || '/')
    ctx.res.end()
    return undefined
  })

  route('GET', '/api/auth/oidc/config', 'public', () => ({ enabled: oidc.enabled, issuer: oidc.enabled ? oidc.issuer : null }))

  route('POST', '/api/auth/password', 'user', async (ctx) => {
    const { currentPassword, newPassword } = ctx.body || {}
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [ctx.user.id])
    const user = rows[0]
    if (!user.password_hash) throw new AppError('This account signs in through your identity provider.', 409)
    if (!verifyPassword(String(currentPassword || ''), user.password_hash)) throw new AppError('Current password is incorrect.', 401)

    const problem = passwordProblem(newPassword)
    if (problem) throw new AppError(problem)

    await db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [ctx.user.id, hashPassword(newPassword)])
    await sessions.destroyUser(ctx.user.id, ctx.user.sessionToken)
    await audit(ctx, 'auth.password_changed', { details: null })
    return { ok: true }
  })

  // ---------------- app state ----------------

  route('GET', '/api/app/state', 'user', async (ctx) => scopeState(ctx.user, await holderIdFor(ctx)))

  route('GET', '/api/app/stream', 'user', async (ctx) => {
    const { req, res } = ctx
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
    res.write(`event: version\ndata: ${await currentVersion(db)}\n\n`)

    const unsubscribe = versions.subscribe((version) => res.write(`event: version\ndata: ${version}\n\n`))
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    return undefined
  })

  // ---------------- cardholder (own card; admins act on ?cardholderId) ----------------

  // Signing other devices out is about the session, not the card, so it stays here rather
  // than moving with the cardholder routes.
  route('POST', '/api/auth/sessions/revoke-others', 'user', async (ctx) => {
    await sessions.destroyUser(ctx.user.id, ctx.user.sessionToken)
    await audit(ctx, 'auth.sessions_revoked', { details: null })
    return { activeSessions: await sessions.countForUser(ctx.user.id) }
  })

  registerCardholderRoutes({
    route,
    db,
    service,
    lithic,
    env,
    environment,
    audit,
    holderIdFor,
    requireSandbox,
    syncThrottle,
    wrapDomain,
    originOf,
    AppError,
  })


  // ---------------- admin ----------------

  route('POST', '/api/admin/lithic/status', 'admin', () => service.status())
  route('POST', '/api/admin/sync', 'admin', () => service.syncTransactions())

  /**
   * Put the demo program back.
   *
   * Cardholders, connections and everything hanging off them are removed and re-seeded.
   * Operator logins, program settings and the stored Lithic secrets are kept, so whoever
   * pressed the button stays signed in.
   *
   * Delete order is not arbitrary: ledger_accounts references connections with ON DELETE
   * RESTRICT, so the journal goes first or the whole reset fails.
   */
  route('POST', '/api/admin/reset', 'admin', async (ctx) => {
    const credentials = await db.tx(async (c) => {
      await c.query('DELETE FROM journal_lines')
      await c.query('DELETE FROM journal_entries')
      await c.query('DELETE FROM ledger_accounts')
      await c.query('DELETE FROM recon_runs')
      // Approvals are kept, like the audit chain: they record what operators decided, which
      // is not program data and is not the demo's to throw away. It also has to be this way
      // now that reset itself needs approval — the request being carried out is a row in
      // this table, and the caller is holding a lock on it while this runs.
      await c.query('DELETE FROM cases')
      // Cascades to each cardholder's users, envelopes, transactions, credits, disputes,
      // notifications and cash membership.
      await c.query('DELETE FROM cardholders')
      await c.query('DELETE FROM cash_rules')
      await c.query('DELETE FROM connections')
      await c.query('DELETE FROM reports')
      await c.query('DELETE FROM webhooks')
      await c.query('DELETE FROM asa_log')
      await c.query('DELETE FROM responder_log')
      await c.query('DELETE FROM email_outbox')

      const seeded = await seedDatabase({ client: c, env, log })
      return seeded.credentials
    })

    await audit(ctx, 'admin.reset', { details: null })
    // The cardholder's temporary password is worth showing once; the operator's own login
    // was kept and is unchanged.
    return { ok: true, credentials: credentials.filter((row) => row.role === 'cardholder') }
  }, { approval: 'admin.reset' })

  route('POST', '/api/admin/connections', 'admin', async (ctx) => {
    const b = ctx.body || {}
    if (!b.name || !Array.isArray(b.mccs) || !b.mccs.length) throw new AppError('Name and at least one MCC are required.')

    const existing = await listConnections(db.pool)
    const connId = b.id && !existing.some((c) => c.id === b.id) ? b.id : id('conn')
    const secret = `whk_${randomBytes(24).toString('base64url')}`
    const defaults = await settings()

    await db.query(
      `INSERT INTO connections (id, name, country, agency, system, protocol, purpose, mccs, countries,
                                daily_limit_cents, cash_allowed, status, hook_path, hmac_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sandbox',$12,$13)`,
      [
        connId,
        b.name,
        b.country ?? null,
        b.agency ?? null,
        b.system || 'pain.001',
        b.protocol || 'pain001',
        b.purpose || 'SSBE',
        b.mccs,
        Array.isArray(b.countries) ? b.countries : defaultCountriesFor(b.country),
        positiveInt(b.dailyLimitCents) ?? defaults.defaultDailyLimitCents,
        Boolean(b.cashAllowed),
        `/api/hooks/credits/${connId}`,
        secretBox().seal(secret),
      ],
    )
    // Shown to the operator once, in clear; what is stored is sealed.
    return { id: connId, hmacSecret: secret }
  })

  route('PATCH', '/api/admin/connections/:id', 'admin', async (ctx) => {
    const b = ctx.body || {}
    const defaults = await settings()

    const affected = await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM connections WHERE id = $1 FOR UPDATE', [ctx.params.id])
      if (!rows.length) throw new AppError('Unknown connection', 404)

      const sets = []
      const args = [ctx.params.id]
      const put = (column, value) => {
        args.push(value)
        sets.push(`${column} = $${args.length}`)
      }

      for (const key of ['name', 'agency', 'protocol', 'purpose', 'status', 'system']) {
        if (typeof b[key] === 'string') put(key === 'name' ? 'name' : key, b[key])
      }
      if (Array.isArray(b.mccs)) put('mccs', b.mccs)
      if (Array.isArray(b.countries)) put('countries', b.countries)
      if (b.dailyLimitCents !== undefined) put('daily_limit_cents', positiveInt(b.dailyLimitCents) ?? defaults.defaultDailyLimitCents)
      if (b.cashAllowed !== undefined) put('cash_allowed', Boolean(b.cashAllowed))

      if (sets.length) await c.query(`UPDATE connections SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, args)

      // A policy change reaches money already on the card.
      const { rows: touched } = await c.query(
        `UPDATE envelopes e
            SET connection_name = c.name, mccs = c.mccs, countries = c.countries
           FROM connections c
          WHERE c.id = e.connection_id AND e.connection_id = $1
          RETURNING e.cardholder_id`,
        [ctx.params.id],
      )
      return [...new Set(touched.map((r) => r.cardholder_id))]
    })

    for (const holderId of affected) service.syncRules(holderId).catch(() => null)
    return { ok: true }
  })

  route(
    'DELETE',
    '/api/admin/connections/:id',
    'admin',
    async (ctx) => {
      const affected = await db.tx(async (c) => {
        const { rows } = await c.query('SELECT cardholder_id FROM envelopes WHERE connection_id = $1', [ctx.params.id])
        await c.query('DELETE FROM envelopes WHERE connection_id = $1', [ctx.params.id])
        await c.query('DELETE FROM connections WHERE id = $1', [ctx.params.id])
        return [...new Set(rows.map((r) => r.cardholder_id))]
      })
      for (const holderId of affected) service.syncRules(holderId).catch(() => null)
      return { ok: true }
    },
    { approval: 'connection.delete' },
  )

  route('POST', '/api/admin/connections/:id/secret', 'admin', async (ctx) => {
    const rotate = Boolean(ctx.body?.rotate)
    const { rows } = await db.query(
      `UPDATE connections
          SET hmac_secret = CASE WHEN $2::boolean THEN $3 ELSE hmac_secret END, updated_at = now()
        WHERE id = $1
        RETURNING hmac_secret`,
      [ctx.params.id, rotate, secretBox().seal(`whk_${randomBytes(24).toString('base64url')}`)],
    )
    if (!rows.length) throw new AppError('Unknown connection', 404)
    return { hmacSecret: secretBox().open(rows[0].hmac_secret) }
  })

  route('POST', '/api/admin/connections/:id/files', 'admin', async (ctx) => {
    const conn = await connectionOrThrow(ctx.params.id)
    const content = String(ctx.body?.content || '')

    if (/FIToFIPmtCxlReq/.test(content)) {
      const checked = xsd.validate(content, 'camt.056.001.08')
      if (!checked.ok) throw new AppError(`camt.056 does not match the ISO 20022 schema: ${checked.errors.join('; ')}`, 400, { errors: checked.errors })
      return { kind: 'camt.056', ...(await processRecalls(conn, content)) }
    }

    const parsed = parseCreditBody(content, content.trim().startsWith('{') ? JSON.parse(content) : null)
    const lines = parsed.fileErrors.length ? parsed.lines.map((l) => ({ ...l, errors: [...parsed.fileErrors, ...(l.errors || [])] })) : parsed.lines
    const result = await processCredits(conn, { ...parsed, lines: lines.length ? lines : [{ endToEndId: '', errors: parsed.fileErrors }], protocol: parsed.protocol })
    return { kind: 'pain.001', groupStatus: result.groupStatus, statuses: result.statuses, reportId: result.reportId }
  })

  route(
    'POST',
    '/api/admin/credits/:id/recall',
    'admin',
    async (ctx) => {
      const credit = await getCredit(db.pool, ctx.params.id)
      if (!credit) throw new AppError('Unknown credit', 404)
      const conn = (await listConnections(db.pool)).find((c) => c.id === credit.connectionId)
      if (!conn) throw new AppError('Connection no longer exists', 409)

      const reason = String(ctx.body?.reason || 'CUST').replace(/[^A-Z0-9]/g, '').slice(0, 4)
      const xml = `<Document><FIToFIPmtCxlReq><Assgnmt><Id>ADMIN-${credit.id}</Id></Assgnmt><Undrlyg><TxInf><OrgnlEndToEndId>${credit.endToEndId}</OrgnlEndToEndId><CxlRsnInf><Rsn><Cd>${reason}</Cd></Rsn></CxlRsnInf></TxInf></Undrlyg></FIToFIPmtCxlReq></Document>`
      return processRecalls(conn, xml)
    },
    { approval: 'credit.recall' },
  )

  route('GET', '/api/admin/reports/:id', 'admin', async (ctx) => {
    const { rows } = await db.query('SELECT * FROM reports WHERE id = $1', [ctx.params.id])
    if (!rows.length) throw new AppError('Unknown report', 404)
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${rows[0].kind}-${rows[0].id}.xml"`)
    return sendRaw(ctx.res, 200, rows[0].content, 'application/xml')
  })

  route('POST', '/api/admin/cardholders', 'admin', async (ctx) => {
    const b = ctx.body || {}
    for (const key of ['firstName', 'lastName', 'email', 'city']) if (!String(b[key] || '').trim()) throw new AppError(`${key} is required`)

    const email = b.email.trim().toLowerCase()
    const beneficiaryRef = String(b.beneficiaryRef || '').trim() || `STP-${randomBytes(4).toString('hex').toUpperCase()}`
    const holderId = id('ch')
    const password = generatePassword()

    try {
      await db.tx(async (c) => {
        await c.query(
          `INSERT INTO cardholders (id, first_name, last_name, email, phone, city, country, beneficiary_ref, iban, prefs, kyc, card)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"emailAlerts":false}'::jsonb,'{"status":"NOT_SUBMITTED"}'::jsonb,$10::jsonb)`,
          [
            holderId,
            b.firstName.trim(),
            b.lastName.trim(),
            email,
            String(b.phone || '').trim(),
            b.city.trim(),
            b.country || 'DE',
            beneficiaryRef,
            virtualIbanFor(holderId),
            JSON.stringify({ token: null, type: 'VIRTUAL', state: 'OPEN', lastFour: null }),
          ],
        )
        await c.query(
          `INSERT INTO users (id, email, name, role, cardholder_id, password_hash, must_change_password)
           VALUES ($1,$2,$3,'cardholder',$4,$5,true)`,
          [id('usr'), email, `${b.firstName.trim()} ${b.lastName.trim()}`, holderId, hashPassword(password)],
        )
      })
    } catch (err) {
      if (err.code === '23505') throw new AppError('A user or beneficiary reference with these details already exists.', 409)
      throw err
    }

    let issueError = null
    if (lithic.configured && b.issueCard !== false) {
      await service.issueCard(holderId).catch((err) => {
        issueError = err.message
      })
    }
    return { id: holderId, temporaryPassword: password, issueError }
  })

  /**
   * One cardholder, in full.
   *
   * The operator list carries only what the list pages show. Everything else — the phone
   * number, the IBAN, the Lithic tokens, the rest of the card, who decided the cash request
   * and when — is read by the detail page alone, so it is fetched when that page is opened
   * rather than sent for every cardholder to every operator on every update.
   */
  route('GET', '/api/admin/cardholders/:id', 'admin', async (ctx) => {
    const holder = await getCardholder(db.pool, ctx.params.id)
    if (!holder) throw new AppError('Unknown cardholder', 404)

    const [detailed, cashUsage, login] = await Promise.all([
      withCash(db.pool, holder),
      cashUsageFor(db.pool, holder.id),
      db.query('SELECT email, must_change_password FROM users WHERE cardholder_id = $1', [holder.id]),
    ])

    return {
      ...detailed,
      cashUsage,
      // The detail page was finding this in a list of every user in the program.
      login: login.rows[0] ? { email: login.rows[0].email, mustChangePassword: login.rows[0].must_change_password } : null,
    }
  })

  route('PATCH', '/api/admin/cardholders/:id', 'admin', async (ctx) => {
    await service.updateAccountHolder(ctx.params.id, ctx.body || {})
    return { ok: true }
  })

  route(
    'DELETE',
    '/api/admin/cardholders/:id',
    'admin',
    async (ctx) => {
      const holder = await getCardholder(db.pool, ctx.params.id)
      if (!holder) throw new AppError('Unknown cardholder', 404)
      if (isUuid(holder.card?.token)) await service.setCardState(holder.id, 'CLOSED')

      const cash = await cashStateFor(db.pool, holder.id)

      await db.tx(async (c) => {
        // journal_lines references ledger_accounts with ON DELETE RESTRICT, so the journal
        // has to go before the cascade reaches this cardholder's accounts. Whole entries
        // are removed, not just their lines: a credit books against the cardholder's
        // envelope and against the connection's shared funding account, and leaving half
        // an entry behind would trip the balance trigger.
        await c.query(
          `DELETE FROM journal_lines
            WHERE entry_id IN (
              SELECT l.entry_id FROM journal_lines l
                JOIN ledger_accounts a ON a.id = l.account_id
               WHERE a.cardholder_id = $1
            )`,
          [holder.id],
        )
        await c.query('DELETE FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)')
        await c.query('DELETE FROM ledger_accounts WHERE cardholder_id = $1', [holder.id])
        // Cascades take the users, envelopes, transactions, credits and cash membership.
        await c.query('DELETE FROM cardholders WHERE id = $1', [holder.id])
      })
      if (cash.status === 'APPROVED') service.scheduleCashSync()
      return { ok: true }
    },
    { approval: 'cardholder.delete' },
  )

  route('POST', '/api/admin/cardholders/:id/password', 'admin', async (ctx) => {
    const password = generatePassword()
    const { rows } = await db.query(
      'UPDATE users SET password_hash = $2, must_change_password = true WHERE cardholder_id = $1 RETURNING id',
      [ctx.params.id, hashPassword(password)],
    )
    if (!rows.length) throw new AppError('No login for this cardholder', 404)
    await sessions.destroyUser(rows[0].id)
    return { temporaryPassword: password }
  })

  route('POST', '/api/admin/cardholders/:id/issue', 'admin', (ctx) => service.issueCard(ctx.params.id))

  /** Cash changes touch each cardholder's MCC allowlist and the program-wide cash rules on Lithic. */
  function resyncCash(holderIds) {
    for (const holderId of holderIds) service.syncRules(holderId).catch((err) => log.warn?.('rule sync failed', { cardholderId: holderId, err }))
    service.scheduleCashSync()
  }

  route(
    'POST',
    '/api/admin/cardholders/:id/cash',
    'admin',
    async (ctx) => {
      const b = ctx.body || {}
      const cash = await wrapDomain(() =>
        db.tx((c) => decideCash(c, ctx.params.id, { decision: b.decision, ruleId: b.ruleId, note: b.note, actor: ctx.user.email })),
      )
      resyncCash([ctx.params.id])
      return cash
    },
    { approval: 'cash.decide' },
  )

  route('POST', '/api/admin/cash-rules', 'admin', async (ctx) => {
    const b = ctx.body || {}
    return wrapDomain(() => db.tx((c) => createCashRule(c, { name: b.name, limitCents: Number(b.limitCents), period: b.period })))
  }, { approval: 'cash.rule.create' })

  route('PATCH', '/api/admin/cash-rules/:id', 'admin', async (ctx) => {
    const b = ctx.body || {}
    const fields = {}
    if (b.name !== undefined) fields.name = b.name
    if (b.limitCents !== undefined) fields.limitCents = Number(b.limitCents)
    if (b.period !== undefined) fields.period = b.period

    const rule = await wrapDomain(() => db.tx((c) => updateCashRule(c, ctx.params.id, fields)))
    service.scheduleCashSync()
    return rule
  }, { approval: 'cash.rule.update' })

  route('DELETE', '/api/admin/cash-rules/:id', 'admin', async (ctx) => {
    await wrapDomain(() => db.tx((c) => deleteCashRule(c, ctx.params.id)))
    service.scheduleCashSync()
    return { ok: true }
  }, { approval: 'cash.rule.delete' })

  /** Bulk: add cardholders to a rule (ruleId) or remove them from cash entirely (ruleId null). */
  route('POST', '/api/admin/cash-rules/assign', 'admin', async (ctx) => {
    const b = ctx.body || {}
    const ids = [...new Set(Array.isArray(b.cardholderIds) ? b.cardholderIds.map(String) : [])]
    if (!ids.length) throw new AppError('Select at least one cardholder.')

    const changed = await wrapDomain(() =>
      db.tx(async (c) => {
        for (const holderId of ids) {
          if (!(await getCardholder(c, holderId))) throw Object.assign(new Error(`Unknown cardholder ${holderId}`), { status: 404 })
        }
        const touched = []
        for (const holderId of ids) {
          const current = await cashStateFor(c, holderId)
          if (b.ruleId) {
            if (current.status === 'APPROVED' && current.ruleId === b.ruleId) continue
            await decideCash(c, holderId, { decision: 'APPROVE', ruleId: b.ruleId, note: b.note, actor: ctx.user.email })
          } else {
            if (current.status !== 'APPROVED') continue
            await decideCash(c, holderId, { decision: 'REVOKE', note: b.note, actor: ctx.user.email })
          }
          touched.push(holderId)
        }
        return touched
      }),
    )

    resyncCash(changed)
    return { changed }
  }, { approval: 'cash.rule.assign' })

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

  route('GET', '/api/admin/rules', 'admin', async (ctx) => {
    const holderId = ctx.query.get('cardholderId')
    const token = holderId ? (await getCardholder(db.pool, holderId))?.card?.token : undefined
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
    const programSettings = await getProgramSettings(db.pool)
    const secret = programSettings.asaSecret || env.LITHIC_ASA_SECRET
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

  // Lithic Fraud Command. The service reports the feature as unavailable rather than
  // throwing when the program is not enrolled, so the console can say so plainly.
  route('GET', '/api/admin/monitoring', 'admin', () => service.monitoringCases())
  route('PATCH', '/api/admin/monitoring/:token', 'admin', (ctx) => service.updateMonitoringCase(ctx.params.token, { status: ctx.body?.status }))

  // ---------------- the journal behind the envelopes ----------------

  route('GET', '/api/admin/journal', 'admin', async (ctx) => {
    const { rows } = await db.query(
      `SELECT e.id, e.idempotency_key, e.at, e.kind, e.source, e.transaction_id, e.credit_id, e.cardholder_id, e.memo,
              json_agg(json_build_object('account', l.account_id, 'direction', l.direction, 'amountCents', l.amount_cents) ORDER BY l.id) AS lines
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
        WHERE ($1::text IS NULL OR e.cardholder_id = $1)
          AND ($2::text IS NULL OR e.transaction_id = $2)
        GROUP BY e.id
        ORDER BY e.at DESC
        LIMIT 200`,
      [ctx.query.get('cardholderId') || null, ctx.query.get('transactionId') || null],
    )
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      source: r.source,
      transactionId: r.transaction_id,
      creditId: r.credit_id,
      cardholderId: r.cardholder_id,
      memo: r.memo,
      lines: r.lines,
    }))
  })

  // ---------------- reconciliation ----------------

  route('GET', '/api/admin/reconciliation', 'admin', async () => {
    const { rows } = await db.query('SELECT * FROM recon_runs ORDER BY started_at DESC LIMIT 20')
    return {
      runs: rows.map((r) => ({ id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, checked: r.checked, breaks: r.break_count, summary: r.summary, error: r.error })),
      open: await openBreaks(db.pool),
    }
  })

  route('POST', '/api/admin/reconciliation', 'admin', async (ctx) =>
    runReconciliation({
      db,
      log,
      cardholderId: ctx.body?.cardholderId || null,
      // Lithic is only compared against when a key is configured; otherwise the run proves
      // the books against themselves and says so.
      fetchLithicTransactions: lithic.configured
        ? async ({ cardholderId }) => {
            const holders = cardholderId ? [await getCardholder(db.pool, cardholderId)] : await listCardholders(db.pool)
            const out = []
            for (const holder of holders) {
              if (!isUuid(holder?.card?.token)) continue
              const data = await lithic.get(`/v1/transactions?card_token=${holder.card.token}&page_size=100`).catch(() => ({ data: [] }))
              for (const txn of data.data || []) {
                out.push({ id: txn.token, cardholderId: holder.id, amountCents: Math.abs(txn.amounts?.settlement?.amount ?? txn.amounts?.cardholder?.amount ?? 0), status: txn.status, merchant: { descriptor: txn.merchant?.descriptor } })
              }
            }
            return out
          }
        : null,
    }),
  )

  route('POST', '/api/admin/reconciliation/breaks/:id', 'admin', (ctx) =>
    resolveBreak(db.pool, { id: ctx.params.id, status: ctx.body?.status, actor: ctx.user.email, resolution: ctx.body?.resolution }),
  )

  // ---------------- approvals ----------------

  route('GET', '/api/admin/approvals', 'admin', () => listPending(db.pool))

  route('POST', '/api/admin/approvals/:id/decide', 'admin', async (ctx) => {
    const approval = await wrapDomain(() =>
      db.tx((c) => decideApproval(c, { id: ctx.params.id, decision: ctx.body?.decision, decidedBy: ctx.user.email, note: ctx.body?.note })),
    )
    await audit(ctx, `approval.${String(ctx.body?.decision || '').toLowerCase()}`, { target: approval.id, details: { action: approval.action } })
    return approval
  })

  /** Carry out a request a second operator approved, with the payload that was parked. */
  route('POST', '/api/admin/approvals/:id/apply', 'admin', async (ctx) => {
    const approval = await getApproval(db.pool, ctx.params.id)
    if (!approval) throw new AppError('Unknown approval request', 404)

    const target = routes.find((r) => r.approval === approval.action && r.method === approval.payload.method && r.path === approval.payload.path)
    if (!target) throw new AppError('The route this request was made for no longer exists.', 409)

    const applied = await wrapDomain(() =>
      applyApproved(db, {
        id: approval.id,
        // The handler manages its own transactions, so it is invoked with the parked
        // request rather than being handed this one's client.
        apply: async () =>
          target.handler({
            req: ctx.req,
            res: ctx.res,
            params: approval.payload.params || {},
            query: new URLSearchParams(approval.payload.query || ''),
            user: ctx.user,
            body: approval.payload.body ?? null,
            raw: '',
          }),
      }),
    )

    await audit(ctx, 'approval.applied', { target: approval.id, details: { action: approval.action } })
    return applied.result ?? { ok: true }
  })

  // ---------------- cases, allocation, audit ----------------

  route('PATCH', '/api/admin/cases/:id', 'admin', async (ctx) => {
    const sets = []
    const args = [ctx.params.id]
    if (['OPEN', 'IN_REVIEW', 'CLOSED'].includes(ctx.body?.status)) {
      args.push(ctx.body.status)
      sets.push(`status = $${args.length}`)
    }
    if (typeof ctx.body?.note === 'string') {
      args.push(ctx.body.note.slice(0, 2000))
      sets.push(`resolution = $${args.length}`)
    }
    if (!sets.length) throw new AppError('Nothing to change.')

    const { rows } = await db.query(`UPDATE cases SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, args)
    if (!rows.length) throw new AppError('Unknown case', 404)
    return rows[0]
  })

  route('GET', '/api/admin/disputes/managed', 'admin', () => service.managedDisputes())

  route('POST', '/api/admin/transactions/:id/allocate', 'admin', async (ctx) => {
    const txn = await wrapDomain(() =>
      db.tx((c) => allocateTransaction(c, { transactionId: ctx.params.id, envelopeId: ctx.body?.envelopeId, actor: ctx.user.email })),
    )
    service.syncRules(txn.cardholderId).catch(() => null)
    return txn
  })

  route('GET', '/api/admin/audit', 'admin', (ctx) =>
    auditList(db, {
      limit: ctx.query.get('limit') || 100,
      before: ctx.query.get('before') || undefined,
      actor: ctx.query.get('actor') || undefined,
      action: ctx.query.get('action') || undefined,
    }),
  )

  /** Prove the audit log has not been rewritten, and name the first entry that fails. */
  route('GET', '/api/admin/audit/verify', 'admin', () => verifyAuditChain(db))

  route('POST', '/api/admin/outbox/deliver', 'admin', async () => deliverOutbox({ db, mailer, log, ...(await mailOptions()) }))
  route('POST', '/api/admin/disputes/:id/refresh', 'admin', (ctx) => service.refreshDispute(ctx.params.id))

  // ---------------- settings ----------------

  route('GET', '/api/admin/settings', 'admin', async () => {
    const state = await loadSettingsState(db.pool)
    const programSettings = state.settings || {}
    const { rows: backupInfo } = await db.query(
      `SELECT pg_database_size(current_database()) AS size, current_setting('server_version') AS version`,
    )

    return {
      values: appSettings(state, env),
      sources: settingSources(state, env),
      server: serverConfig(env),
      stored: {
        asaSecret: Boolean(programSettings.asaSecret),
        threeDsSecret: Boolean(programSettings.threeDsSecret),
        tokenizationSecret: Boolean(programSettings.tokenizationSecret),
        webhookSecrets: Object.keys(programSettings.webhookSecrets || {}).length,
      },
      lithic: { configured: lithic.configured, environment },
      mail: { configured: mailer.configured },
      sso: oidc.describe(),
      approvals: { required: approvalsRequired, actions: approvalsRequired ? [...SENSITIVE_ACTIONS] : [] },
      // Whether the stored secrets are encrypted at rest, so an operator can see that they
      // are not rather than having to assume.
      encryption: { enabled: secretBox().configured },
      // Backups belong to the database now: CloudNativePG takes base backups and streams
      // WAL, rather than the application copying a file next to itself.
      storage: { engine: 'postgres', serverVersion: backupInfo[0].version, sizeBytes: Number(backupInfo[0].size), backups: 'managed by the database' },
    }
  })

  route('PATCH', '/api/admin/settings', 'admin', async (ctx) => {
    const patch = await wrapDomain(() => validateSettings(ctx.body || {}))
    return db.tx(async (c) => {
      await applyAppSettings(c, patch)
      if ('organisation' in patch) {
        const operator = await getMeta(c, 'operator', null)
        if (operator) await patchMeta(c, 'operator', { ...operator, org: patch.organisation || '' })
      }
      return appSettings(await loadSettingsState(c), env)
    })
  }, { approval: 'settings.update' })

  route('POST', '/api/admin/settings/test-email', 'admin', async (ctx) => {
    if (!mailer.configured) throw new AppError('Email is not configured. Set SMTP_URL in .env and restart.', 409)
    const { programName, mailFrom, publicUrl } = await settings()
    await mailer.send({
      to: ctx.user.email,
      from: mailFrom,
      subject: `${programName}: test email`,
      text: `Email delivery from ${programName} works.${publicUrl ? `\n${publicUrl}` : ''}`,
    })
    return { sentTo: ctx.user.email }
  })

  route('PATCH', '/api/admin/profile', 'admin', async (ctx) => {
    const name = String(ctx.body?.name || '').trim()
    if (!name || name.length > 80) throw new AppError('Name must be 1 to 80 characters.')
    const { rows } = await db.query('UPDATE users SET name = $2 WHERE id = $1 RETURNING *', [ctx.user.id, name])
    return { id: rows[0].id, email: rows[0].email, name: rows[0].name, role: rows[0].role }
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
      if (url.pathname.startsWith('/api/health')) return
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

    // Checked before the body is read: an unsigned flood should cost a map lookup, not a
    // megabyte of buffering and a database round trip. Keyed on the registered path, so
    // every connection's hook shares one ceiling rather than each getting its own.
    const limiter = publicLimiters.get(match.path)
    if (limiter && !limiter.allow(clientIp(req))) {
      res.setHeader('Retry-After', '60')
      return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' })
    }

    try {
      const ctx = { req, res, params: match.params, query: url.searchParams, user: null, raw: '', body: null }

      if (match.access !== 'public') {
        ctx.user = await currentUser(req)
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

      // A sensitive action is parked for a second operator rather than carried out. The
      // route layer refuses to run the handler at all, so forgetting the check in a handler
      // cannot bypass it.
      //
      // Off unless the program asks for it: approvals_four_eyes forbids approving your own
      // request, so with a single operator this would make cash rules and settings
      // permanently unchangeable. A program turns it on once it has two operators.
      if (approvalsRequired && match.approval && needsApproval(match.approval)) {
        const parked = await requestApproval(db.pool, {
          action: match.approval,
          target: Object.keys(match.params).length ? JSON.stringify(match.params) : null,
          payload: { method: match.method, path: match.path, params: match.params, query: url.searchParams.toString(), body: ctx.body },
          requestedBy: ctx.user.email,
        })
        await audit(ctx, 'approval.requested', { target: parked.id, details: { action: match.approval } })
        return send(res, 202, {
          approvalRequired: true,
          approvalId: parked.id,
          action: parked.action,
          message: 'This change needs a second operator to approve it.',
        })
      }

      let result
      try {
        result = await match.handler(ctx)
      } catch (err) {
        if (match.access === 'admin' && req.method !== 'GET') await audit(ctx, `${req.method} ${match.path}`, { outcome: `error ${err.status || 500}` })
        throw err
      }

      if (match.access === 'admin' && req.method !== 'GET') await audit(ctx, `${req.method} ${match.path}`)

      // Tell every browser, on every replica, that something changed.
      if (!['GET', 'HEAD'].includes(req.method) && res.statusCode < 400) {
        await db.tx((c) => bumpVersion(c)).catch((err) => log.warn?.('version bump failed', { err: err.message }))
      }

      if (!res.writableEnded && !res.headersSent && result !== undefined) send(res, 200, result ?? { ok: true })
    } catch (err) {
      if (res.headersSent) return res.end()
      if (err instanceof AppError) return send(res, err.status, { error: err.message, details: err.details })
      if (err instanceof LithicError) {
        return send(res, [400, 404, 409, 422].includes(err.status) ? err.status : 502, {
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
    oidc,
    async close() {
      for (const handle of intervals) clearInterval(handle)
      await versions.stop()
      await db.end()
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
async function wrapDomain(fn) {
  try {
    return await fn()
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

/**
 * Flood ceilings for the endpoints that accept unauthenticated requests.
 *
 * Every one of them verifies an HMAC signature before doing any work, so these are not an
 * authorization control — nothing here decides who may move money. They cap what an
 * unsigned flood can cost in body reads and database round trips before it is rejected.
 * The hooks are the expensive case: verifying a connection signature loads every
 * connection first, so a request that fails the check has already cost a query.
 *
 * Per replica, and — unless STIPEND_TRUST_PROXY is set — keyed on the ingress address that
 * every external request shares. Both push the effective ceiling up, so these sit far above
 * any real volume rather than close to it.
 *
 * Exported so a test can assert each key is a path that is actually registered: a typo here
 * fails open, and silently.
 */
export const PUBLIC_RATE_LIMITS = {
  // Lithic calls this for every card authorization. A 429 reads to Lithic as a failed
  // authorization, which declines a real cardholder's card, so this ceiling exists only to
  // stop a flood and must never shape normal traffic.
  '/api/asa': { windowMs: 60_000, max: 1200 },
  '/api/webhooks/lithic': { windowMs: 60_000, max: 600 },
  '/api/responders/three-ds': { windowMs: 60_000, max: 600 },
  '/api/responders/tokenization': { windowMs: 60_000, max: 600 },
  '/api/hooks/credits/:connectionId': { windowMs: 60_000, max: 120 },
  '/api/hooks/recalls/:connectionId': { windowMs: 60_000, max: 120 },
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
