import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { createApp } from './app.js'
import { samplePain001, sampleCamt056 } from '../src/lib/pain001.js'

const CARD = '11111111-1111-4111-8111-111111111111'
let dir, app, server, base
const sentMail = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stipend-'))
  app = createApp({
    env: { STIPEND_ADMIN_PASSWORD: 'admin-password-1', STIPEND_CARDHOLDER_PASSWORD: 'holder-password-1' },
    dataFile: join(dir, 'db.sqlite'),
    log: { error() {}, warn() {}, info() {} },
    timers: false,
    mailer: { configured: true, send: async (mail) => sentMail.push(mail) },
  })
  server = createServer((req, res) => app.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  app.close()
  rmSync(dir, { recursive: true, force: true })
})

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  return { status: res.status, cookie }
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

test('login, roles and scoping', async () => {
  assert.equal((await login('ops@stipend.demo', 'nope')).status, 401)
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  assert.equal(admin.status, 200)
  assert.equal((await call(null, 'GET', '/api/app/state')).status, 401)
  const mine = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(mine.status, 200)
  assert.equal(mine.data.cardholders, undefined)
  assert.ok(mine.data.envelopes.length)
  assert.equal(JSON.stringify(mine.data).includes('hmacSecret"'), false)
  assert.equal((await call(holder.cookie, 'GET', '/api/admin/asa')).status, 403)
  const all = await call(admin.cookie, 'GET', '/api/app/state')
  assert.ok(all.data.cardholders.length)
  assert.equal(JSON.stringify(all.data).includes('passwordHash'), false)
  assert.equal((await call(admin.cookie, 'POST', '/api/me/notifications/read', {}, { Origin: 'https://evil.example' })).status, 403)
})

test('credit hooks: beneficiary match, duplicates, batches, recalls', async () => {
  const conn = app.db.read().connections.find((c) => c.id === 'de-jobcenter')
  const lena = app.db.read().cardholders.find((c) => c.id === 'ch_lena')
  const envBefore = app.db.read().envelopes.find((e) => e.connectionId === conn.id && e.cardholderId === lena.id).balanceCents

  const json = JSON.stringify({ amount: 2500, end_to_end_id: 'IT-1', beneficiary_ref: lena.beneficiaryRef })
  const ok = await signed(conn, json, `/api/hooks/credits/${conn.id}`)
  assert.equal(ok.status, 200)
  assert.equal(app.db.read().envelopes.find((e) => e.connectionId === conn.id && e.cardholderId === lena.id).balanceCents, envBefore + 2500)
  assert.equal((await signed(conn, json, `/api/hooks/credits/${conn.id}`)).status, 409)
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
  assert.equal(app.db.read().credits.find((c) => c.endToEndId === 'IT-B1').status, 'RECALLED')
})

test('ASA, webhooks and local purchases move envelopes', async () => {
  app.db.mutate((s) => {
    s.cardholders.find((c) => c.id === 'ch_lena').card.token = CARD
  })
  const env = () => app.db.read().envelopes.find((e) => e.id === 'env_gkv').balanceCents
  const start = env()
  const asa = await call(null, 'POST', '/api/asa', { token: '33333333-3333-4333-8333-333333333333', amount: 500, card: { token: CARD }, merchant: { mcc: '5912', country: 'DEU', descriptor: 'Apotheke' } })
  assert.equal(asa.data.result, 'APPROVED')
  assert.equal(env(), start - 500)

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
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(env(), start)

  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const declined = await call(holder.cookie, 'POST', '/api/me/purchases', { amountCents: 900, mcc: '7995', merchant: 'Casino' })
  assert.equal(declined.status, 200)
  assert.equal(declined.data.status, 'DECLINED')
})

test('admin creates a cardholder with a one-time password', async () => {
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  const created = await call(admin.cookie, 'POST', '/api/admin/cardholders', { firstName: 'Ada', lastName: 'Test', email: 'ada@example.test', city: 'Paris', country: 'FR' })
  assert.equal(created.status, 200)
  const ada = await login('ada@example.test', created.data.temporaryPassword)
  assert.equal(ada.status, 200)
  const session = await call(ada.cookie, 'GET', '/api/auth/session')
  assert.equal(session.data.user.mustChangePassword, true)
  const changed = await call(ada.cookie, 'POST', '/api/auth/password', { currentPassword: created.data.temporaryPassword, newPassword: 'a-new-password-99' })
  assert.equal(changed.status, 200)
})

test('sessions survive a restart, admin writes are audited, health is public', async () => {
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  await call(admin.cookie, 'POST', '/api/admin/connections/de-gkv/secret', { rotate: false })
  const log = await call(admin.cookie, 'GET', '/api/admin/audit')
  const entry = log.data.find((row) => row.action === 'POST /api/admin/connections/:id/secret')
  assert.ok(entry)
  assert.equal(entry.actor, 'ops@stipend.demo')
  assert.ok(log.data.some((row) => row.action === 'auth.login' && row.outcome === 'ok'))

  const restarted = createApp({ env: {}, dataFile: join(dir, 'db.sqlite'), log: { error() {}, warn() {}, info() {} }, timers: false })
  const other = createServer((req, res) => restarted.handle(req, res))
  await new Promise((r) => other.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${other.address().port}/api/auth/session`, { headers: { Cookie: admin.cookie } })
  assert.equal((await res.json()).user.email, 'ops@stipend.demo')
  const health = await fetch(`http://127.0.0.1:${other.address().port}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).db.ok, true)
  other.close()
  restarted.close()
})

test('queued notification email is delivered through the mailer', async () => {
  const { deliverOutbox } = await import('./mailer.js')
  app.db.mutate((s) => {
    s.cardholders.find((c) => c.id === 'ch_lena').prefs = { emailAlerts: true }
  })
  const conn = app.db.read().connections.find((c) => c.id === 'de-gkv')
  const lena = app.db.read().cardholders.find((c) => c.id === 'ch_lena')
  const body = JSON.stringify({ amount: 111, end_to_end_id: 'MAIL-1', beneficiary_ref: lena.beneficiaryRef })
  assert.equal((await signed(conn, body, `/api/hooks/credits/${conn.id}`)).status, 200)
  const result = await deliverOutbox({ db: app.db, mailer: { configured: true, send: async (m) => sentMail.push(m) } })
  assert.ok(result.sent >= 1)
  assert.ok(sentMail.some((m) => m.to === lena.email))
  assert.equal(app.db.read().emailOutbox.find((m) => m.status === 'queued'), undefined)
})

test('cardholder requests cash; operator adds them to a cash rule; limit shows in the app', async () => {
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  const requested = await call(holder.cookie, 'POST', '/api/me/cash-request', { amountCents: 5000, period: 'MONTH', reason: 'Laundromat' })
  assert.equal(requested.status, 200)
  assert.equal(requested.data.status, 'REQUESTED')
  assert.equal((await call(holder.cookie, 'POST', '/api/me/cash-request', { amountCents: 5000, period: 'MONTH' })).status, 409)

  const adminState = await call(admin.cookie, 'GET', '/api/app/state')
  const seeded = adminState.data.cashRules.find((r) => r.id === 'cash_100_month')
  assert.equal(seeded.limitCents, 10000)
  const created = await call(admin.cookie, 'POST', '/api/admin/cash-rules', { name: 'Cash 40 per week', limitCents: 4000, period: 'WEEK' })
  assert.equal(created.status, 200)
  assert.equal((await call(admin.cookie, 'POST', '/api/admin/cash-rules', { name: '', limitCents: 4000, period: 'WEEK' })).status, 400)

  const assigned = await call(admin.cookie, 'POST', '/api/admin/cash-rules/assign', { ruleId: created.data.id, cardholderIds: ['ch_lena'] })
  assert.deepEqual(assigned.data.changed, ['ch_lena'])
  let state = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(state.data.cardholder.cash.status, 'APPROVED')
  assert.equal(state.data.cardholder.cash.limitCents, 4000)
  assert.equal(state.data.cashUsage.period, 'WEEK')
  assert.equal(state.data.cashRules, undefined)

  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/cash-rules/${created.data.id}`)).status, 409)
  await call(admin.cookie, 'PATCH', `/api/admin/cash-rules/${created.data.id}`, { limitCents: 6000 })
  state = await call(holder.cookie, 'GET', '/api/app/state')
  assert.equal(state.data.cashUsage.limitCents, 6000)

  const removed = await call(admin.cookie, 'POST', '/api/admin/cash-rules/assign', { ruleId: null, cardholderIds: ['ch_lena'] })
  assert.deepEqual(removed.data.changed, ['ch_lena'])
  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/cash-rules/${created.data.id}`)).status, 200)
  const audit = await call(admin.cookie, 'GET', '/api/admin/audit?action=cash')
  assert.ok(audit.data.some((row) => row.action === 'POST /api/admin/cash-rules/assign'))
})

test('operators manage program settings; secrets stay hidden; cardholders see support contact', async () => {
  const holder = await login('lena.vogt@example.de', 'holder-password-1')
  const admin = await login('ops@stipend.demo', 'admin-password-1')
  assert.equal((await call(holder.cookie, 'GET', '/api/admin/settings')).status, 403)

  const initial = await call(admin.cookie, 'GET', '/api/admin/settings')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.values.defaultDailyLimitCents, 15000)
  assert.equal(initial.data.server.find((r) => r.key === 'STIPEND_ADMIN_PASSWORD').value, null)
  assert.ok(!JSON.stringify(initial.data).includes('admin-password-1'))

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
  assert.deepEqual(holderState.data.program, { programName: 'Stipend Berlin', organisation: 'Senatsverwaltung Berlin', supportEmail: 'hilfe@stipend.example.org', supportPhone: '' })
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

test('cardholder updates contact details, alert types and signs out other devices', async () => {
  const first = await login('lena.vogt@example.de', 'holder-password-1')
  const second = await login('lena.vogt@example.de', 'holder-password-1')
  let state = await call(first.cookie, 'GET', '/api/app/state')
  assert.ok(state.data.activeSessions >= 2)

  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { phone: 'call me' })).status, 400)
  const phone = await call(first.cookie, 'PATCH', '/api/me/profile', { phone: '+49 30 555 0199' })
  assert.equal(phone.status, 200)
  assert.equal(phone.data.phone, '+49 30 555 0199')
  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.neu@example.de', currentPassword: 'wrong' })).status, 401)
  assert.equal((await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'ops@stipend.demo', currentPassword: 'holder-password-1' })).status, 409)
  const email = await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.neu@example.de', currentPassword: 'holder-password-1' })
  assert.equal(email.data.email, 'lena.neu@example.de')
  assert.equal((await login('lena.neu@example.de', 'holder-password-1')).status, 200)

  assert.equal((await call(first.cookie, 'PATCH', '/api/me/prefs', { emailMuted: ['nope'] })).status, 400)
  const prefs = await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: true, emailMuted: ['card', 'cash'] })
  assert.deepEqual(prefs.data, { emailAlerts: true, emailMuted: ['card', 'cash'] })
  const onlyToggle = await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: false })
  assert.deepEqual(onlyToggle.data.emailMuted, ['card', 'cash'])

  const revoked = await call(first.cookie, 'POST', '/api/auth/sessions/revoke-others')
  assert.equal(revoked.data.activeSessions, 1)
  assert.equal((await call(second.cookie, 'GET', '/api/app/state')).status, 401)

  await call(first.cookie, 'PATCH', '/api/me/profile', { email: 'lena.vogt@example.de', currentPassword: 'holder-password-1' })
  await call(first.cookie, 'PATCH', '/api/me/prefs', { emailAlerts: false, emailMuted: [] })
})
