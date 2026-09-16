import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appSettings, applySettings, serverConfig, settingSources, validateSettings } from './settings.js'

test('settings fall back from saved value to environment to default', () => {
  const env = { PUBLIC_URL: 'https://env.example.org', MAIL_FROM: 'Env <env@example.org>' }
  const state = { operator: { org: 'Senatsverwaltung Berlin' }, settings: { app: { mailFrom: 'Saved <saved@example.org>' } } }
  const values = appSettings(state, env)
  assert.equal(values.publicUrl, 'https://env.example.org')
  assert.equal(values.mailFrom, 'Saved <saved@example.org>')
  assert.equal(values.defaultDailyLimitCents, 15000)
  assert.equal(values.organisation, 'Senatsverwaltung Berlin')
  assert.deepEqual(
    { publicUrl: settingSources(state, env).publicUrl, mailFrom: settingSources(state, env).mailFrom, programName: settingSources(state, env).programName },
    { publicUrl: 'env', mailFrom: 'saved', programName: 'default' },
  )
  applySettings(state, { mailFrom: null })
  assert.equal(appSettings(state, env).mailFrom, 'Env <env@example.org>')
})

test('settings validation normalises and rejects bad input', () => {
  assert.deepEqual(validateSettings({ publicUrl: 'https://stipend.example.org/', supportEmail: ' help@example.org ' }), {
    publicUrl: 'https://stipend.example.org',
    supportEmail: 'help@example.org',
  })
  assert.deepEqual(validateSettings({ mailFrom: 'Stipend <no-reply@example.org>', supportPhone: null }), { mailFrom: 'Stipend <no-reply@example.org>', supportPhone: null })
  for (const bad of [
    { publicUrl: 'ftp://x.example' },
    { publicUrl: 'https://user:pw@x.example' },
    { supportEmail: 'nope' },
    { defaultDailyLimitCents: 5 },
    { cardSpendLimitDuration: 'WEEKLY' },
    { programName: '' },
    { apiKey: 'x' },
  ]) {
    assert.throws(() => validateSettings(bad), (err) => err.status === 400, JSON.stringify(bad))
  }
})

test('server configuration never reports secret values', () => {
  const rows = serverConfig({ LITHIC_API_KEY: 'sk_live_secret', SMTP_URL: 'smtps://u:p@mail', LITHIC_ENV: 'sandbox' })
  const key = rows.find((r) => r.key === 'LITHIC_API_KEY')
  assert.deepEqual([key.set, key.value, key.required], [true, null, true])
  assert.equal(rows.find((r) => r.key === 'SMTP_URL').value, null)
  assert.equal(rows.find((r) => r.key === 'LITHIC_ENV').value, 'sandbox')
  assert.ok(!JSON.stringify(rows).includes('secret') || !JSON.stringify(rows).includes('sk_live'))
  assert.ok(!JSON.stringify(rows).includes('u:p@'))
})
