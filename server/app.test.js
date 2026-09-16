import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createApp } from './app.js'
import { hashPassword } from './accounts.js'
import { secretBox } from './db/secrets.js'
import { samplePain001, sampleCamt056 } from '../src/lib/pain001.js'

const CARD = '11111111-1111-4111-8111-111111111111'
const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL is not set'

let app, server, base, testUrl, dbName
const sentMail = []

/**
 * These tests own their database.
 *
 * They assert on the seeded demo program (Lena, the Jobcenter connection, the standard
 * cash allowance), so they need a database nobody else is writing to. Each run creates one
 * and drops it afterwards.
 */
async function createTestDatabase() {
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  dbName = `stipend_apptest_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()
  return url.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
}

async function dropTestDatabase() {
  if (!dbName) return
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await admin.end()
}

before(async () => {
  if (skip) return
  testUrl = await createTestDatabase()
  app = await createApp({
    env: {
      DATABASE_URL: testUrl,
      STIPEND_ADMIN_PASSWORD: 'admin-password-1',
      STIPEND_CARDHOLDER_PASSWORD: 'holder-password-1',
      // Test files run concurrently and every one of them wants connections. The default
      // pool of ten per app, times the apps this file builds, is most of a default
      // max_connections on its own.
      DATABASE_POOL_MAX: '4',
      // Set here so the suite exercises encryption rather than the passthrough it falls
      // back to when no key is configured.
      STIPEND_SECRET_KEY: 'a-test-passphrase-long-enough-to-use',
    },
    log: { error() {}, warn() {}, info() {} },
    timers: false,
    mailer: { configured: true, send: async (mail) => sentMail.push(mail) },
  })
  server = createServer((req, res) => app.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server?.close()
  await app?.close()
  await dropTestDatabase()
})

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  return { status: res.status, cookie }
}

/**
 * One operator session, reused.
 *
 * Signing in is rate limited to eight attempts a minute per address, and the whole file
 * runs in under two seconds, so every login in it falls inside one window. Authenticating
 * per test ran into that limit and looked like a broken endpoint. Tests that are about
 * signing in still call login() directly.
 */
let adminSession = null
async function adminSession_() {
  if (!adminSession?.cookie) adminSession = await login('ops@stipend.demo', 'admin-password-1')
  return adminSession
}

async function call(cookie, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

function signed(conn, raw, path) {
  const sig = createHmac('sha256', conn.hmacSecret).update(raw).digest('hex')
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Stipend-Signature': `sha256=${sig}` }, body: raw })
}

// The store is no longer reachable as a document, so the tests read rows. The HMAC secret
// is sealed in the column, so it comes back through the same path the server uses rather
// than straight out of the row — signing with the sealed text would just fail the
// signature check and look like a server bug.
const connection = async (id) => {
  const { rows } = await app.db.query('SELECT * FROM connections WHERE id = $1', [id])
  return { ...rows[0], hmacSecret: secretBox().open(rows[0].hmac_secret) }
}
const cardholder = async (id) => (await app.db.query('SELECT * FROM cardholders WHERE id = $1', [id])).rows[0]
const envelopeBalance = async (connectionId, cardholderId) =>
  (await app.db.query('SELECT balance_cents FROM envelopes WHERE connection_id = $1 AND cardholder_id = $2', [connectionId, cardholderId])).rows[0]?.balance_cents

test('login, roles and scoping', { skip }, async () => {
  assert.equal((await login('ops@stipend.demo', 'nope')).status, 401)
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  assert.equal(admin.status, 200)

  assert.equal((await call(null, 'GET', '/api/app/state')).status, 401)

  const mine = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(mine.status, 200)
  assert.equal(mine.data.cardholders, undefined, 'a cardholder never sees the operator view')
  assert.ok(mine.data.envelopes.length)
  assert.equal(JSON.stringify(mine.data).includes('hmacSecret"'), false)
  assert.equal((await call(holder.cookie, 'GET', '/api/admin/asa')).status, 403)

  const all = await call(admin.cookie, 'GET', '/api/app/state')
  assert.ok(all.data.cardholders.length)
  assert.equal(JSON.stringify(all.data).includes('passwordHash'), false)

  assert.equal((await call(admin.cookie, 'POST', '/api/me/notifications/read', {}, { Origin: 'https://evil.example' })).status, 403)
})

test('credit hooks: beneficiary match, duplicates, batches, recalls', { skip }, async () => {
  const conn = await connection('de-jobcenter')
  const lena = await cardholder('ch_lena')
  const before = await envelopeBalance(conn.id, lena.id)

  const json = JSON.stringify({ amount: 2500, end_to_end_id: 'IT-1', beneficiary_ref: lena.beneficiary_ref })
  assert.equal((await signed(conn, json, `/api/hooks/credits/${conn.id}`)).status, 200)
  assert.equal(await envelopeBalance(conn.id, lena.id), before + 2500)

  assert.equal((await signed(conn, json, `/api/hooks/credits/${conn.id}`)).status, 409, 'a replayed instruction is refused')
  assert.equal((await signed(conn, JSON.stringify({ amount: 100, end_to_end_id: 'IT-2', beneficiary_ref: 'nobody' }), `/api/hooks/credits/${conn.id}`)).status, 422)
  assert.equal((await signed({ hmacSecret: 'wrong' }, json, `/api/hooks/credits/${conn.id}`)).status, 401)

  const xml = samplePain001({
    connectionName: conn.name,
    transactions: [
      { amountCents: 1000, endToEndId: 'IT-B1', creditorIban: lena.iban },
      { amountCents: 2000, endToEndId: 'IT-B2', beneficiaryRef: 'unknown' },
    ],
  })
  const batch = await signed(conn, xml, `/api/hooks/credits/${conn.id}`)
  const body = await batch.json()
  assert.equal(body.groupStatus, 'PART')
  assert.deepEqual(body.statuses.map((s) => s.status), ['ACCP', 'RJCT'])

  const recall = await signed(conn, sampleCamt056({ endToEndId: 'IT-B1', amountCents: 1000 }), `/api/hooks/recalls/${conn.id}`)
  assert.equal((await recall.json()).results[0].status, 'CNCL')

  const { rows } = await app.db.query(`SELECT status FROM credits WHERE end_to_end_id = 'IT-B1'`)
  assert.equal(rows[0].status, 'RECALLED')
})

test('ASA, webhooks and local purchases move envelopes', { skip }, async () => {
  await app.db.query(`UPDATE cardholders SET card = card || $2::jsonb WHERE id = $1`, ['ch_lena', JSON.stringify({ token: CARD })])

  const balance = async () => (await app.db.query(`SELECT balance_cents FROM envelopes WHERE id = 'env_gkv'`)).rows[0].balance_cents
  const start = await balance()

  const asa = await call(null, 'POST', '/api/asa', {
    token: '33333333-3333-4333-8333-333333333333',
    amount: 500,
    card: { token: CARD },
    merchant: { mcc: '5912', country: 'DEU', descriptor: 'Apotheke' },
  })
  assert.equal(asa.data.result, 'APPROVED')
  assert.equal(await balance(), start - 500)

  const webhook = await call(null, 'POST', '/api/webhooks/lithic', {
    event_type: 'card_transaction.updated',
    payload: {
      token: '33333333-3333-4333-8333-333333333333',
      card_token: CARD,
      status: 'VOIDED',
      result: 'APPROVED',
      amounts: { hold: { amount: 0 } },
      merchant: { mcc: '5912', country: 'DEU', descriptor: 'Apotheke' },
      events: [{ type: 'AUTHORIZATION', amount: 500, result: 'APPROVED' }, { type: 'VOID', amount: 500, result: 'APPROVED' }],
    },
  })
  assert.equal(webhook.status, 200)

  // The event is handled off the request path, so give it a moment to land.
  for (let i = 0; i < 40 && (await balance()) !== start; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(await balance(), start, 'a reversal puts the money back')

  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const declined = await call(holder.cookie, 'POST', '/api/me/purchases', { amountCents: 900, mcc: '7995', merchant: 'Casino' })
  assert.equal(declined.status, 200)
  assert.equal(declined.data.status, 'DECLINED')
})

test('a replayed Lithic webhook is handled once', { skip }, async () => {
  const event = {
    event_type: 'card_transaction.updated',
    payload: { token: randomUUID(), card_token: CARD, status: 'PENDING', result: 'APPROVED', amounts: { hold: { amount: 100 } }, merchant: { mcc: '5912', country: 'DEU' }, events: [] },
  }
  const headers = { 'webhook-id': `msg_${randomUUID()}` }

  assert.equal((await call(null, 'POST', '/api/webhooks/lithic', event, headers)).status, 200)
  assert.equal((await call(null, 'POST', '/api/webhooks/lithic', event, headers)).status, 200)

  const { rows } = await app.db.query('SELECT count(*)::int AS n FROM webhooks WHERE message_id = $1', [headers['webhook-id']])
  assert.equal(rows[0].n, 1, 'the retry is deduplicated by the database, not by a scan')
})

test('admin creates a cardholder with a one-time password', { skip }, async () => {
  const admin = await adminSession_()
  const created = await call(admin.cookie, 'POST', '/api/admin/cardholders', { firstName: 'Ada', lastName: 'Test', email: 'ada@example.test', city: 'Paris', country: 'FR' })
  assert.equal(created.status, 200)

  const ada = await login('ada@example.test', created.data.temporaryPassword)
  assert.equal(ada.status, 200)

  const session = await call(ada.cookie, 'GET', '/api/auth/session')
  assert.equal(session.data.user.mustChangePassword, true)

  const changed = await call(ada.cookie, 'POST', '/api/auth/password', { currentPassword: created.data.temporaryPassword, newPassword: 'a-new-password-99' })
  assert.equal(changed.status, 200)
})

test('sessions survive a restart, admin writes are audited, health is public', { skip }, async () => {
  const admin = await adminSession_()
  await call(admin.cookie, 'POST', '/api/admin/connections/de-gkv/secret', { rotate: false })

  const log = await call(admin.cookie, 'GET', '/api/admin/audit')
  const entry = log.data.find((row) => row.action === 'POST /api/admin/connections/:id/secret')
  assert.ok(entry)
  assert.equal(entry.actor, 'ops@stipend.demo')
  assert.ok(log.data.some((row) => row.action === 'auth.login' && row.outcome === 'ok'))

  // The chain the audit log is written as verifies end to end.
  const verified = await call(admin.cookie, 'GET', '/api/admin/audit/verify')
  assert.equal(verified.data.ok, true, verified.data.reason || '')

  // A second process against the same database: sessions are rows, so they survive.
  // The same key: a second process against the same database cannot read its secrets
  // without it, which is exactly the constraint replicas live under.
  const restarted = await createApp({
    env: { DATABASE_URL: testUrl, STIPEND_SECRET_KEY: 'a-test-passphrase-long-enough-to-use' },
    log: { error() {}, warn() {}, info() {} },
    timers: false,
  })
  const other = createServer((req, res) => restarted.handle(req, res))
  await new Promise((r) => other.listen(0, '127.0.0.1', r))

  const res = await fetch(`http://127.0.0.1:${other.address().port}/api/auth/session`, { headers: { Cookie: admin.cookie } })
  assert.equal((await res.json()).user.email, 'ops@stipend.demo')

  const health = await fetch(`http://127.0.0.1:${other.address().port}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).db.ok, true)

  const live = await fetch(`http://127.0.0.1:${other.address().port}/api/health/live`)
  assert.equal(live.status, 200)
  const ready = await fetch(`http://127.0.0.1:${other.address().port}/api/health/ready`)
  assert.equal(ready.status, 200)
  assert.equal((await ready.json()).db, true)

  other.close()
  await restarted.close()
})

test('queued notification email is delivered through the mailer', { skip }, async () => {
  const { deliverOutbox } = await import('./mailer.js')
  await app.db.query(`UPDATE cardholders SET prefs = '{"emailAlerts":true}'::jsonb WHERE id = 'ch_lena'`)

  const conn = await connection('de-gkv')
  const lena = await cardholder('ch_lena')
  const body = JSON.stringify({ amount: 111, end_to_end_id: 'MAIL-1', beneficiary_ref: lena.beneficiary_ref })
  assert.equal((await signed(conn, body, `/api/hooks/credits/${conn.id}`)).status, 200)

  const result = await deliverOutbox({ db: app.db, mailer: { configured: true, send: async (m) => sentMail.push(m) } })
  assert.ok(result.sent >= 1)
  assert.ok(sentMail.some((m) => m.to === lena.email))

  const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM email_outbox WHERE status = 'QUEUED'`)
  assert.equal(rows[0].n, 0, 'nothing is left queued')
})

test('cardholder requests cash; operator adds them to a cash rule; limit shows in the app', { skip }, async () => {
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const admin = await adminSession_()

  const requested = await call(holder.cookie, 'POST', '/api/me/cash-request', { amountCents: 5000, period: 'MONTH', reason: 'Laundromat' })
  assert.equal(requested.status, 200)
  assert.equal(requested.data.status, 'REQUESTED')
  assert.equal((await call(holder.cookie, 'POST', '/api/me/cash-request', { amountCents: 5000, period: 'MONTH' })).status, 409)

  const adminState = await call(admin.cookie, 'GET', '/api/app/state')
  assert.equal(adminState.data.cashRules.find((r) => r.id === 'cash_100_month').limitCents, 10000)

  const created = await call(admin.cookie, 'POST', '/api/admin/cash-rules', { name: 'Cash 40 per week', limitCents: 4000, period: 'WEEK' })
  assert.equal(created.status, 200)
  assert.equal((await call(admin.cookie, 'POST', '/api/admin/cash-rules', { name: '', limitCents: 4000, period: 'WEEK' })).status, 400)

  const assigned = await call(admin.cookie, 'POST', '/api/admin/cash-rules/assign', { ruleId: created.data.id, cardholderIds: ['ch_lena'] })
  assert.deepEqual(assigned.data.changed, ['ch_lena'])

  let state = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(state.data.cardholder.cash.status, 'APPROVED')
  assert.equal(state.data.cardholder.cash.limitCents, 4000)
  assert.equal(state.data.cashUsage.period, 'WEEK')
  assert.equal(state.data.cashRules, undefined, 'cash rules are an operator concern')

  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/cash-rules/${created.data.id}`)).status, 409, 'a rule with members is not deleted')

  await call(admin.cookie, 'PATCH', `/api/admin/cash-rules/${created.data.id}`, { limitCents: 6000 })
  state = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(state.data.cashUsage.limitCents, 6000, 'a limit change reaches every member')

  const removed = await call(admin.cookie, 'POST', '/api/admin/cash-rules/assign', { ruleId: null, cardholderIds: ['ch_lena'] })
  assert.deepEqual(removed.data.changed, ['ch_lena'])
  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/cash-rules/${created.data.id}`)).status, 200)

  const audit = await call(admin.cookie, 'GET', '/api/admin/audit?action=cash')
  assert.ok(audit.data.some((row) => row.action === 'POST /api/admin/cash-rules/assign'))
})

test('two-operator approval parks a sensitive change until someone else approves it', { skip }, async () => {
  // A second process with approvals switched on, against the same database.
  const strict = await createApp({
    env: { DATABASE_URL: testUrl, STIPEND_REQUIRE_APPROVAL: '1', STIPEND_SECRET_KEY: 'a-test-passphrase-long-enough-to-use', DATABASE_POOL_MAX: '4' },
    log: { error() {}, warn() {}, info() {} },
    timers: false,
  })
  const strictServer = createServer((req, res) => strict.handle(req, res))
  await new Promise((r) => strictServer.listen(0, '127.0.0.1', r))
  const strictBase = `http://127.0.0.1:${strictServer.address().port}`

  const ask = async (cookie, method, path, body) => {
    const res = await fetch(`${strictBase}${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }

  try {
    const first = await fetch(`${strictBase}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ops@stipend.demo', password: 'admin-password-1' }) })
    const cookie = first.headers.get('set-cookie')?.split(';')[0]

    const parked = await ask(cookie, 'POST', '/api/admin/cash-rules', { name: 'Needs approval', limitCents: 5000, period: 'WEEK' })
    assert.equal(parked.status, 202)
    assert.equal(parked.data.approvalRequired, true)
    assert.equal(parked.data.action, 'cash.rule.create')

    // Nothing was created.
    const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM cash_rules WHERE name = 'Needs approval'`)
    assert.equal(rows[0].n, 0)

    // The operator who asked cannot approve their own request.
    const own = await ask(cookie, 'POST', `/api/admin/approvals/${parked.data.approvalId}/decide`, { decision: 'APPROVED' })
    assert.equal(own.status, 403)
  } finally {
    strictServer.close()
    await strict.close()
  }
})

test('operators manage program settings; secrets stay hidden; cardholders see support contact', { skip }, async () => {
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const admin = await adminSession_()
  assert.equal((await call(holder.cookie, 'GET', '/api/admin/settings')).status, 403)

  const initial = await call(admin.cookie, 'GET', '/api/admin/settings')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.values.defaultDailyLimitCents, 15000)
  assert.equal(initial.data.server.find((r) => r.key === 'STIPEND_ADMIN_PASSWORD').value, null)
  assert.ok(!JSON.stringify(initial.data).includes('admin-password-1'))
  assert.equal(initial.data.storage.engine, 'postgres')

  assert.equal((await call(admin.cookie, 'PATCH', '/api/admin/settings', { publicUrl: 'not a url' })).status, 400)

  const saved = await call(admin.cookie, 'PATCH', '/api/admin/settings', {
    programName: 'Stipend Berlin',
    supportEmail: 'hilfe@stipend.example.org',
    publicUrl: 'https://stipend.example.org/',
    defaultDailyLimitCents: 20000,
    mailFrom: 'Stipend Berlin <no-reply@stipend.example.org>',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.publicUrl, 'https://stipend.example.org')

  const holderState = await call(holder.cookie, 'GET', '/api/app/state')
  assert.deepEqual(holderState.data.program, {
    programName: 'Stipend Berlin',
    organisation: 'Senatsverwaltung Berlin',
    supportEmail: 'hilfe@stipend.example.org',
    supportPhone: '',
  })
  assert.equal(holderState.data.appSettings, undefined)

  const conn = await call(admin.cookie, 'POST', '/api/admin/connections', { name: 'Settings default cap', country: 'DE', mccs: ['5411'] })
  assert.equal(conn.status, 200)

  const adminState = await call(admin.cookie, 'GET', '/api/app/state')
  assert.equal(adminState.data.connections.find((c) => c.name === 'Settings default cap').dailyLimitCents, 20000)

  sentMail.length = 0
  const mail = await call(admin.cookie, 'POST', '/api/admin/settings/test-email')
  assert.equal(mail.status, 200)
  assert.equal(sentMail[0].to, 'ops@stipend.demo')
  assert.equal(sentMail[0].from, 'Stipend Berlin <no-reply@stipend.example.org>')

  const profile = await call(admin.cookie, 'PATCH', '/api/admin/profile', { name: 'Mira K.' })
  assert.equal(profile.data.name, 'Mira K.')

  await call(admin.cookie, 'PATCH', '/api/admin/settings', { programName: 'Stipend', supportEmail: null, publicUrl: null, defaultDailyLimitCents: null, mailFrom: null })
})

test('cardholder updates contact details, alert types and signs out other devices', { skip }, async () => {
  const first = await login('lena.vogt@example.de', 'holder-password-1')
  const second = await login('lena.vogt@example.de', 'holder-password-1')

  const state = await call(first.cookie, 'GET', '/api/app/state')
  assert.ok(state.data.activeSessions >= 2)

  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { phone: 'call me' })).status, 400)
  const phone = await call(first.cookie, 'PATCH', '/api/me/profile', { phone: '+49 30 555 0199' })
  assert.equal(phone.status, 200)
  assert.equal(phone.data.phone, '+49 30 555 0199')

  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.neu@example.de', currentPassword: 'wrong' })).status, 401)
  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'ops@stipend.demo', currentPassword: 'holder-password-1' })).status, 409)

  const email = await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.neu@example.de', currentPassword: 'holder-password-1' })
  assert.equal(email.data.email, 'lena.neu@example.de')
  assert.equal((await login('lena.neu@example.de', 'holder-password-1')).status, 200, 'the sign-in address follows the contact address')

  assert.equal((await call(first.cookie, 'PATCH', '/api/me/prefs', { emailMuted: ['nope'] })).status, 400)
  const prefs = await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: true, emailMuted: ['card', 'cash'] })
  assert.deepEqual(prefs.data, { emailAlerts: true, emailMuted: ['card', 'cash'] })

  const onlyToggle = await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: false })
  assert.deepEqual(onlyToggle.data.emailMuted, ['card', 'cash'], 'a partial update merges rather than replaces')

  const revoked = await call(first.cookie, 'POST', '/api/auth/sessions/revoke-others')
  assert.equal(revoked.data.activeSessions, 1)
  assert.equal((await call(second.cookie, 'GET', '/api/app/state')).status, 401)

  await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.vogt@example.de', currentPassword: 'holder-password-1' })
  await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: false, emailMuted: [] })
})

test('reset restores the demo program and keeps the operator signed in', { skip }, async () => {
  const admin = await adminSession_()

  // Something that is not part of the demo program, so its removal is visible.
  const extra = await call(admin.cookie, 'POST', '/api/admin/connections', { name: 'Temporary agency', country: 'DE', mccs: ['5411'] })
  assert.equal(extra.status, 200)

  const reset = await call(admin.cookie, 'POST', '/api/admin/reset', {})
  assert.equal(reset.status, 200, JSON.stringify(reset.data))

  // The operator who pressed the button is still signed in: their login was kept.
  const session = await call(admin.cookie, 'GET', '/api/auth/session')
  assert.equal(session.data.user.email, 'ops@stipend.demo')

  const state = await call(admin.cookie, 'GET', '/api/app/state')
  assert.equal(state.status, 200)
  assert.ok(state.data.cardholders.some((c) => c.id === 'ch_lena'), 'the demo cardholder is back')
  assert.ok(!state.data.connections.some((c) => c.name === 'Temporary agency'), 'what was added is gone')
  assert.ok(state.data.connections.length >= 6, 'the seeded connections are back')

  // The ledger was cleared with everything else, so the books still agree.
  const recon = await call(admin.cookie, 'POST', '/api/admin/reconciliation', {})
  assert.equal(recon.status, 200)
  assert.deepEqual(recon.data.breaks.filter((b) => b.kind === 'ENVELOPE_BALANCE'), [], 'envelopes agree with the journal after a reset')

  assert.ok(
    (await call(admin.cookie, 'GET', '/api/admin/audit?action=admin.reset')).data.some((row) => row.action === 'admin.reset'),
    'the reset is audited',
  )
})

test('connection secrets are encrypted at rest and still verify a signed hook', { skip }, async () => {
  const admin = await adminSession_()

  const created = await call(admin.cookie, 'POST', '/api/admin/connections', {
    name: 'Sealed agency',
    country: 'DE',
    mccs: ['5411'],
  })
  assert.equal(created.status, 200)
  const secret = created.data.hmacSecret
  assert.match(secret, /^whk_/, 'the operator is shown the secret in clear, once')

  // What is actually stored is sealed.
  const { rows } = await app.db.query('SELECT hmac_secret FROM connections WHERE id = $1', [created.data.id])
  assert.match(rows[0].hmac_secret, /^enc\.v1\./, 'the column does not hold the secret')
  assert.ok(!rows[0].hmac_secret.includes(secret), 'and does not contain it')

  // And the sealed value still authenticates a real signed request from an agency.
  const lena = await cardholder('ch_lena')
  const body = JSON.stringify({ amount: 4200, end_to_end_id: `SEALED-${randomUUID().slice(0, 8)}`, beneficiary_ref: lena.beneficiary_ref })
  const res = await signed({ hmacSecret: secret }, body, `/api/hooks/credits/${created.data.id}`)
  assert.equal(res.status, 200, 'a hook signed with the secret is accepted')

  // A rotation returns the new secret in clear and stores the new one sealed.
  const rotated = await call(admin.cookie, 'POST', `/api/admin/connections/${created.data.id}/secret`, { rotate: true })
  assert.match(rotated.data.hmacSecret, /^whk_/)
  assert.notEqual(rotated.data.hmacSecret, secret)

  const after = await app.db.query('SELECT hmac_secret FROM connections WHERE id = $1', [created.data.id])
  assert.match(after.rows[0].hmac_secret, /^enc\.v1\./)

  // The old secret no longer signs anything.
  const stale = await signed({ hmacSecret: secret }, body, `/api/hooks/credits/${created.data.id}`)
  assert.equal(stale.status, 401)
})

test('the admin console reports whether secrets are encrypted', { skip }, async () => {
  const admin = await adminSession_()
  const settings = await call(admin.cookie, 'GET', '/api/admin/settings')
  assert.equal(settings.data.encryption.enabled, true)
})

test('the operator payload carries envelopes for open cases, and only those', { skip }, async () => {
  // The Cases page offers an envelope to allocate a stray refund to, and builds that list
  // from allEnvelopes. Sending every envelope in the program to every operator was the
  // second largest thing in this payload and grew with the number of cardholders, so it is
  // scoped to cardholders with a case still open. Nothing covered that list before, which
  // means nothing would have noticed the dropdown going empty.
  const admin = await adminSession_()
  const { rows: mine } = await app.db.query(`SELECT id, connection_name FROM envelopes WHERE cardholder_id = 'ch_lena' ORDER BY id`)
  assert.ok(mine.length, 'the demo cardholder has envelopes to offer')

  const caseId = `case_alloc_${randomUUID().slice(0, 8)}`
  await app.db.query(`INSERT INTO cases (id, cardholder_id, title, status) VALUES ($1, 'ch_lena', 'Unmatched refund', 'OPEN')`, [caseId])

  try {
    const open = await call(admin.cookie, 'GET', '/api/app/state')
    const offered = open.data.allEnvelopes.filter((e) => e.cardholderId === 'ch_lena')
    assert.equal(offered.length, mine.length, 'every envelope of a cardholder with an open case is offered')

    // Exactly what the dropdown reads, and nothing else: it renders connectionName and
    // submits id. Anything more is bytes sent to every operator on every update.
    assert.deepEqual(Object.keys(offered[0]).sort(), ['cardholderId', 'connectionName', 'id'])
    assert.ok(offered.every((e) => e.connectionName))

    await app.db.query(`UPDATE cases SET status = 'CLOSED' WHERE id = $1`, [caseId])
    const closed = await call(admin.cookie, 'GET', '/api/app/state')
    assert.equal(
      closed.data.allEnvelopes.filter((e) => e.cardholderId === 'ch_lena').length,
      0,
      'once nothing is open for them, their envelopes are not sent at all',
    )
  } finally {
    await app.db.query('DELETE FROM cases WHERE id = $1', [caseId])
  }
})

test('one cardholder is fetched in full; the operator list carries only what lists show', { skip }, async () => {
  const admin = await adminSession_()

  const detail = await call(admin.cookie, 'GET', '/api/admin/cardholders/ch_lena')
  assert.equal(detail.status, 200)

  // The detail page reads all of these, and they are the reason a whole record exists.
  for (const key of ['phone', 'iban', 'ibanRef', 'dob', 'prefs', 'physical', 'lithicHolder', 'lithicAccount', 'createdAt']) {
    assert.ok(key in detail.data, `${key} is missing from the cardholder detail`)
  }
  assert.ok(detail.data.cash, 'the decided cash request comes with it')
  assert.equal(detail.data.login?.email, 'lena.vogt@example.de', 'the login it used to find in a list of every user')

  assert.equal((await call(admin.cookie, 'GET', '/api/admin/cardholders/nobody')).status, 404)

  const state = await call(admin.cookie, 'GET', '/api/app/state')
  const row = state.data.cardholders.find((c) => c.id === 'ch_lena')
  assert.ok(row, 'the cardholder is still in the operator list')

  // What the list pages read, and nothing beyond it. Asserting only the first half would
  // pass just as well against the untrimmed payload.
  assert.deepEqual(Object.keys(row).sort(), ['beneficiaryRef', 'card', 'cash', 'cashUsage', 'city', 'country', 'email', 'firstName', 'id', 'kyc', 'lastName', 'summary'])
  for (const key of ['phone', 'iban', 'lithicHolder', 'lithicAccount', 'prefs', 'dob', 'physical']) {
    assert.ok(!(key in row), `${key} is still being sent for every cardholder`)
  }

  // The Cases page shows a pending request before anyone opens the cardholder, so those
  // fields stay. Which of them are present depends on whether this cardholder has a request
  // at all — JSON drops the undefined ones — so this asserts the boundary rather than an
  // exact set, and still fails against the untrimmed payload.
  const allowedCash = ['reason', 'requestedAt', 'requestedCents', 'requestedPeriod', 'ruleId', 'status']
  assert.deepEqual(Object.keys(row.cash).filter((k) => !allowedCash.includes(k)), [], 'the list carries only the cash fields it shows')
  for (const key of ['decidedAt', 'decidedBy', 'note', 'limitCents', 'period', 'ruleName']) {
    assert.ok(!(key in row.cash), `cash.${key} belongs to the detail page`)
  }

  assert.equal(state.data.users, undefined, 'every user in the program is no longer sent to every operator')
})

test('the books reconcile after everything above', { skip }, async () => {
  const admin = await adminSession_()
  const run = await call(admin.cookie, 'POST', '/api/admin/reconciliation', {})

  assert.equal(run.status, 200)
  assert.deepEqual(
    run.data.breaks.filter((b) => b.kind === 'ENVELOPE_BALANCE'),
    [],
    'every envelope still agrees with the journal',
  )
})

/**
 * Last, because it wipes the program every test above depends on.
 *
 * Reset destroys every cardholder, connection, credit and transaction, so it needs a second
 * operator like the other sensitive actions. Carrying it out is the interesting part: the
 * reset runs in its own transaction while applyApproved holds a lock on the approvals row
 * authorising it, so a reset that deleted that table would block on its own approval until
 * the statement timeout. This test is mostly here to notice if that comes back.
 */
test('a program reset waits for a second operator, and is then carried out', { skip }, async () => {
  const strict = await createApp({
    env: { DATABASE_URL: testUrl, STIPEND_REQUIRE_APPROVAL: '1', STIPEND_SECRET_KEY: 'a-test-passphrase-long-enough-to-use', DATABASE_POOL_MAX: '4' },
    log: { error() {}, warn() {}, info() {} },
    timers: false,
  })
  const strictServer = createServer((req, res) => strict.handle(req, res))
  await new Promise((r) => strictServer.listen(0, '127.0.0.1', r))
  const strictBase = `http://127.0.0.1:${strictServer.address().port}`

  const signIn = async (email, password) => {
    const res = await fetch(`${strictBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    return res.headers.get('set-cookie')?.split(';')[0]
  }
  const ask = async (cookie, method, path, body) => {
    const res = await fetch(`${strictBase}${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: res.status, data: await res.json() }
  }

  try {
    // The demo program seeds one operator, and nobody may approve their own request.
    await app.db.query(
      `INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,'admin',$4) ON CONFLICT DO NOTHING`,
      ['usr_ops2', 'second@stipend.demo', 'Second Operator', hashPassword('admin-password-2')],
    )

    const asker = await signIn('ops@stipend.demo', 'admin-password-1')
    const approver = await signIn('second@stipend.demo', 'admin-password-2')
    assert.ok(asker && approver, 'both operators signed in')

    const parked = await ask(asker, 'POST', '/api/admin/reset')
    assert.equal(parked.status, 202)
    assert.equal(parked.data.approvalRequired, true)
    assert.equal(parked.data.action, 'admin.reset')

    const before = await app.db.query('SELECT count(*)::int AS n FROM cardholders')
    assert.ok(before.rows[0].n > 0, 'nothing was wiped while the request waits')

    const own = await ask(asker, 'POST', `/api/admin/approvals/${parked.data.approvalId}/decide`, { decision: 'APPROVED' })
    assert.equal(own.status, 403, 'the operator who asked cannot approve a reset either')

    const decided = await ask(approver, 'POST', `/api/admin/approvals/${parked.data.approvalId}/decide`, { decision: 'APPROVED' })
    assert.equal(decided.status, 200)

    const applied = await ask(approver, 'POST', `/api/admin/approvals/${parked.data.approvalId}/apply`)
    assert.equal(applied.status, 200, `apply failed: ${JSON.stringify(applied.data)}`)

    const after = await app.db.query('SELECT count(*)::int AS n FROM cardholders')
    assert.ok(after.rows[0].n > 0, 'the demo program was seeded again')

    const row = await app.db.query('SELECT status FROM approvals WHERE id = $1', [parked.data.approvalId])
    assert.equal(row.rows[0]?.status, 'APPLIED', 'the approval survived the reset it authorised')
  } finally {
    strictServer.close()
    await strict.close()
  }
})
