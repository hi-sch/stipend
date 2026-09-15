import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeSpend, spentToday, toAsaResponse, DAILY_LIMIT_CENTS } from './auth.js'

const envelopes = [
  {
    id: 'env_food',
    connectionName: 'Jobcenter',
    balanceCents: 5000,
    mccs: ['5411'],
    countries: ['DEU'],
    receivedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'env_rent',
    connectionName: 'Wohngeld',
    balanceCents: 20000,
    mccs: ['6513'],
    countries: ['DEU'],
    receivedAt: '2026-01-02T00:00:00Z',
  },
]

test('approves oldest matching envelope', () => {
  const d = authorizeSpend(envelopes, { amountCents: 1000, mcc: '5411', country: 'DEU' })
  assert.equal(d.approved, true)
  assert.equal(d.envelopeId, 'env_food')
  assert.equal(toAsaResponse(d).result, 'APPROVED')
})

test('incomplete envelope without mccs does not throw', () => {
  const d = authorizeSpend([{ id: 'env_x', balanceCents: 100, receivedAt: '2026-01-01T00:00:00Z' }], {
    amountCents: 10,
    mcc: '5411',
    country: 'DEU',
  })
  assert.equal(d.approved, true)
})

test('declines MCC outside every envelope as UNAUTHORIZED_MERCHANT', () => {
  const d = authorizeSpend(envelopes, { amountCents: 1000, mcc: '7995', country: 'DEU' })
  assert.equal(d.approved, false)
  assert.equal(d.asaResult, 'UNAUTHORIZED_MERCHANT')
})

test('declines over envelope balance as INSUFFICIENT_FUNDS', () => {
  const d = authorizeSpend(envelopes, { amountCents: 9000, mcc: '5411', country: 'DEU' })
  assert.equal(d.asaResult, 'INSUFFICIENT_FUNDS')
})

test('declines paused card', () => {
  const d = authorizeSpend(envelopes, { amountCents: 100, mcc: '5411', country: 'DEU', cardState: 'PAUSED' })
  assert.equal(d.asaResult, 'CARD_PAUSED')
})

test('enforces daily velocity', () => {
  const transactions = [
    { envelopeId: 'env_food', status: 'SETTLED', amountCents: DAILY_LIMIT_CENTS, created: new Date().toISOString() },
  ]
  const d = authorizeSpend(envelopes, { amountCents: 100, mcc: '5411', country: 'DEU', transactions })
  assert.equal(d.asaResult, 'VELOCITY_EXCEEDED')
  assert.equal(spentToday(transactions, 'env_food'), DAILY_LIMIT_CENTS)
})

test('falls through to a later covering envelope with enough balance', () => {
  const list = [
    { id: 'env_small', connectionName: 'A', balanceCents: 500, mccs: ['5411'], countries: [], receivedAt: '2026-01-01T00:00:00Z' },
    { id: 'env_big', connectionName: 'B', balanceCents: 9000, mccs: ['5411'], countries: [], receivedAt: '2026-02-01T00:00:00Z' },
  ]
  const d = authorizeSpend(list, { amountCents: 2000, mcc: '5411', country: 'DEU' })
  assert.equal(d.approved, true)
  assert.equal(d.envelopeId, 'env_big')
})

test('prefers the most specific envelope before older broad ones', () => {
  const list = [
    { id: 'env_broad', balanceCents: 9000, mccs: ['5411', '5912', '4111'], receivedAt: '2026-01-01T00:00:00Z' },
    { id: 'env_narrow', balanceCents: 9000, mccs: ['5411'], receivedAt: '2026-03-01T00:00:00Z' },
  ]
  assert.equal(authorizeSpend(list, { amountCents: 100, mcc: '5411', country: 'DEU' }).envelopeId, 'env_narrow')
})

test('rejects non-positive or NaN amounts', () => {
  assert.equal(authorizeSpend(envelopes, { amountCents: NaN, mcc: '5411', country: 'DEU' }).approved, false)
  assert.equal(authorizeSpend(envelopes, { amountCents: 0, mcc: '5411', country: 'DEU' }).approved, false)
})

test('ASA response never uses a result outside the documented enum', () => {
  const d = authorizeSpend(envelopes, { amountCents: 100, mcc: '5411', country: 'DEU', cardState: 'CLOSED' })
  assert.equal(toAsaResponse(d).result, 'CARD_PAUSED')
})

test('partial approval pays what the envelope has on capable terminals', () => {
  const d = authorizeSpend(envelopes, { amountCents: 9000, mcc: '5411', country: 'DEU', partialApprovalCapable: true })
  assert.equal(d.approved, true)
  assert.equal(d.approvedAmountCents, 5000)
  assert.deepEqual(toAsaResponse(d, { token: 't' }), { result: 'APPROVED', token: 't', approved_amount: 5000 })
})

test('per-connection daily limits via function', () => {
  const d = authorizeSpend(envelopes, { amountCents: 2000, mcc: '5411', country: 'DEU', dailyLimitCents: () => 1000 })
  assert.equal(d.asaResult, 'VELOCITY_EXCEEDED')
})
