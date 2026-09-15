import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCredit,
  authorizeAsa,
  isDuplicateCredit,
  reconcileTransaction,
  recallCredit,
  resolveBeneficiary,
  virtualIbanFor,
} from './domain.js'
import { isValidIban } from '../src/lib/pain001.js'

const CARD = '11111111-1111-4111-8111-111111111111'

function fixture() {
  return {
    cardholders: [
      { id: 'ch_a', email: 'a@example.test', beneficiaryRef: 'REF-A', iban: virtualIbanFor('ch_a'), card: { token: CARD, state: 'OPEN' } },
    ],
    connections: [{ id: 'conn_food', name: 'Food', mccs: ['5411'], countries: ['DEU'], protocol: 'json', purpose: 'SSBE', dailyLimitCents: 20000 }],
    envelopes: [],
    credits: [],
    transactions: [],
    notifications: [],
    cases: [],
    asaLog: [],
  }
}

function lithicTxn(overrides) {
  return {
    token: '22222222-2222-4222-8222-222222222222',
    card_token: CARD,
    created: '2026-09-14T10:00:00Z',
    result: 'APPROVED',
    status: 'PENDING',
    amounts: { hold: { amount: 1000 }, cardholder: { amount: 0, currency: 'USD' } },
    merchant: { descriptor: 'REWE', mcc: '5411', country: 'DEU' },
    events: [{ type: 'AUTHORIZATION', amount: 1000, result: 'APPROVED', detailed_results: ['APPROVED'] }],
    ...overrides,
  }
}

test('virtual IBANs are valid and stable', () => {
  assert.equal(isValidIban(virtualIbanFor('ch_a')), true)
  assert.equal(virtualIbanFor('ch_a'), virtualIbanFor('ch_a'))
})

test('beneficiary resolution by reference then IBAN', () => {
  const s = fixture()
  assert.equal(resolveBeneficiary(s, { beneficiaryRef: 'REF-A' }).id, 'ch_a')
  assert.equal(resolveBeneficiary(s, { iban: s.cardholders[0].iban }).id, 'ch_a')
  assert.equal(resolveBeneficiary(s, { beneficiaryRef: 'nope' }), null)
})

test('credit, ASA hold, clearing, void are idempotent envelope moves', () => {
  const s = fixture()
  const credit = applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 5000, endToEndId: 'E1' })
  assert.equal(isDuplicateCredit(s, 'conn_food', 'E1'), true)
  const env = s.envelopes[0]
  assert.equal(env.balanceCents, 5000)

  const res = authorizeAsa(s, { token: '22222222-2222-4222-8222-222222222222', amount: 1000, card: { token: CARD }, merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } })
  assert.equal(res.result, 'APPROVED')
  assert.equal(env.balanceCents, 4000)
  // Same ASA again (Lithic retry) must not double-debit.
  authorizeAsa(s, { token: '22222222-2222-4222-8222-222222222222', amount: 1000, card: { token: CARD }, merchant: { mcc: '5411', country: 'DEU' } })
  assert.equal(env.balanceCents, 4000)

  reconcileTransaction(s, lithicTxn({ status: 'SETTLED', amounts: { settlement: { amount: 800 }, cardholder: { amount: 800 } } }))
  assert.equal(env.balanceCents, 4200)
  reconcileTransaction(s, lithicTxn({ status: 'SETTLED', amounts: { settlement: { amount: 800 }, cardholder: { amount: 800 } } }))
  assert.equal(env.balanceCents, 4200)
  reconcileTransaction(s, lithicTxn({ status: 'VOIDED' }))
  assert.equal(env.balanceCents, 5000)

  const recall = recallCredit(s, { credit, reason: 'DUPL' })
  assert.equal(recall.status, 'CNCL')
  assert.equal(env.balanceCents, 0)
})

test('ASA declines unknown cards and partial approves capable terminals', () => {
  const s = fixture()
  applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 3000, endToEndId: 'E1' })
  assert.equal(authorizeAsa(s, { token: 't0', amount: 100, card: { token: 'other' }, merchant: { mcc: '5411' } }).result, 'UNAUTHORIZED_MERCHANT')
  const res = authorizeAsa(s, {
    token: 't1',
    amount: 5000,
    card: { token: CARD },
    merchant: { mcc: '5411', country: 'DEU' },
    pos: { terminal: { partial_approval_capable: true } },
  })
  assert.deepEqual(res, { result: 'APPROVED', token: 't1', approved_amount: 3000 })
  assert.equal(s.envelopes[0].balanceCents, 0)
})

test('returns credit the envelope that paid', () => {
  const s = fixture()
  applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 3000, endToEndId: 'E1' })
  authorizeAsa(s, { token: 'buy', amount: 1000, card: { token: CARD }, merchant: { mcc: '5411', country: 'DEU' } })
  reconcileTransaction(
    s,
    lithicTxn({ token: 'ret', status: 'SETTLED', amounts: { settlement: { amount: 400 } }, events: [{ type: 'RETURN', amount: 400, result: 'APPROVED' }] }),
  )
  assert.equal(s.envelopes[0].balanceCents, 2400)
})

test('recall of spent money is rejected', () => {
  const s = fixture()
  const credit = applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 1000, endToEndId: 'E1' })
  s.envelopes[0].balanceCents = 0
  assert.equal(recallCredit(s, { credit, reason: 'CUST' }).status, 'RJCR')
})

test('public HTTPS detection for ASA URLs', async () => {
  const { isPublicHttps } = await import('./lithicService.js')
  assert.equal(isPublicHttps('https://abc.trycloudflare.com/api/asa'), true)
  assert.equal(isPublicHttps('http://127.0.0.1:5175/api/asa'), false)
  assert.equal(isPublicHttps('https://localhost/api/asa'), false)
})

test('unmatched refunds wait for an operator and can be allocated', async () => {
  const { allocateTransaction } = await import('./domain.js')
  const s = fixture()
  applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 3000, endToEndId: 'E1' })
  reconcileTransaction(
    s,
    lithicTxn({ token: 'ret2', status: 'SETTLED', amounts: { settlement: { amount: 700 } }, merchant: { descriptor: 'UNKNOWN SHOP', mcc: '5999' }, events: [{ type: 'RETURN', amount: 700, result: 'APPROVED' }] }),
  )
  const txn = s.transactions.find((t) => t.id === 'ret2')
  assert.equal(txn.review, 'NEEDS_ENVELOPE')
  assert.equal(txn.unallocatedCents, -700)
  assert.equal(s.cases[0].kind, 'refund-review')
  allocateTransaction(s, { transactionId: 'ret2', envelopeId: s.envelopes[0].id })
  assert.equal(s.envelopes[0].balanceCents, 3700)
  assert.equal(s.cases[0].status, 'CLOSED')
})

test('cash rules: off by default, request, add to rule, ATM and cashback split, limits, void, revoke', async () => {
  const { requestCash, decideCash, cashUsageFor, withdrawCashRequest, createCashRule, updateCashRule, deleteCashRule, withCash } = await import('./domain.js')
  const s = fixture()
  s.connections.push({ id: 'conn_cash', name: 'Living costs', mccs: ['5999'], countries: [], protocol: 'json', purpose: 'SSBE', cashAllowed: true })
  applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 5000, endToEndId: 'F1' })
  applyCredit(s, { connection: s.connections[1], holder: s.cardholders[0], amountCents: 5000, endToEndId: 'C1' })
  const food = s.envelopes.find((e) => e.connectionId === 'conn_food')
  const cashEnv = s.envelopes.find((e) => e.connectionId === 'conn_cash')
  const atm = (token, amount, mcc = '6011') => authorizeAsa(s, { token, amount, cash_amount: mcc === '6011' ? amount : 0, card: { token: CARD }, merchant: { mcc, country: 'DEU', descriptor: 'ATM' } })

  assert.equal(atm('a0', 1000).result, 'UNAUTHORIZED_MERCHANT')
  assert.equal(atm('q0', 1000, '6051').result, 'UNAUTHORIZED_MERCHANT')
  requestCash(s, 'ch_a', { amountCents: 3000, period: 'MONTH', reason: 'Market stall' })
  assert.throws(() => requestCash(s, 'ch_a', { amountCents: 3000, period: 'MONTH' }), /already waiting/)
  withdrawCashRequest(s, 'ch_a')
  assert.throws(() => decideCash(s, 'ch_a', { decision: 'APPROVE', ruleId: 'nope' }), /existing cash rule/)
  const rule = createCashRule(s, { name: 'Cash 30', limitCents: 3000, period: 'MONTH' })
  decideCash(s, 'ch_a', { decision: 'APPROVE', ruleId: rule.id, actor: 'ops' })
  assert.equal(withCash(s, s.cardholders[0]).cash.limitCents, 3000)
  assert.throws(() => deleteCashRule(s, rule.id), /Remove the 1/)

  assert.equal(atm('a1', 1500).result, 'APPROVED')
  assert.equal(atm('q1', 500, '6051').result, 'APPROVED')
  assert.equal(cashEnv.balanceCents, 3000)
  assert.equal(atm('a2', 1500).result, 'VELOCITY_EXCEEDED')

  const cashback = authorizeAsa(s, { token: 'cb1', amount: 1800, cash_amount: 800, card: { token: CARD }, merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } })
  assert.equal(cashback.result, 'APPROVED')
  assert.equal(food.balanceCents, 4000)
  assert.equal(cashEnv.balanceCents, 2200)
  assert.equal(cashUsageFor(s, 'ch_a').usedCents, 2800)

  reconcileTransaction(s, lithicTxn({ token: 'cb1', status: 'VOIDED', merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } }))
  assert.equal(food.balanceCents, 5000)
  assert.equal(cashEnv.balanceCents, 3000)
  assert.equal(cashUsageFor(s, 'ch_a').usedCents, 2000)

  // Raising the rule's limit applies to every member at once.
  updateCashRule(s, rule.id, { limitCents: 10000 })
  assert.equal(cashUsageFor(s, 'ch_a').remainingCents, 8000)

  decideCash(s, 'ch_a', { decision: 'REVOKE', note: 'Program ended' })
  assert.equal(atm('a3', 100).result, 'UNAUTHORIZED_MERCHANT')
  deleteCashRule(s, rule.id)
})

test('cash from envelopes whose connection forbids cash is declined', async () => {
  const { decideCash, createCashRule } = await import('./domain.js')
  const s = fixture()
  applyCredit(s, { connection: s.connections[0], holder: s.cardholders[0], amountCents: 5000, endToEndId: 'F1' })
  const rule = createCashRule(s, { name: 'Weekly', limitCents: 3000, period: 'WEEK' })
  decideCash(s, 'ch_a', { decision: 'APPROVE', ruleId: rule.id })
  const res = authorizeAsa(s, { token: 'x', amount: 1000, cash_amount: 1000, card: { token: CARD }, merchant: { mcc: '6011' } })
  assert.equal(res.result, 'INSUFFICIENT_FUNDS')
})

test('synced cash transactions without an ASA decision book cash on a cash envelope', () => {
  const s = fixture()
  s.connections.push({ id: 'conn_cash', name: 'Living costs', mccs: ['5999'], countries: [], protocol: 'json', purpose: 'SSBE', cashAllowed: true })
  applyCredit(s, { connection: s.connections[1], holder: s.cardholders[0], amountCents: 5000, endToEndId: 'C1' })
  const txn = reconcileTransaction(s, lithicTxn({ token: 'atm1', merchant: { mcc: '6011', country: 'DEU', descriptor: 'ATM' } }))
  assert.equal(txn.cashCents, 1000)
  assert.equal(s.envelopes[0].balanceCents, 4000)
})

test("email alerts follow the cardholder's alert types", async () => {
  const { notify } = await import('./domain.js')
  const s = fixture()
  notify(s, { holderId: 'ch_a', title: 'off', kind: 'decline' })
  assert.equal((s.emailOutbox || []).length, 0)
  s.cardholders[0].prefs = { emailAlerts: true, emailMuted: ['declines'] }
  notify(s, { holderId: 'ch_a', title: 'muted', kind: 'decline' })
  notify(s, { holderId: 'ch_a', title: 'muted 3ds', kind: '3ds' })
  notify(s, { holderId: 'ch_a', title: 'credit', kind: 'credit' })
  notify(s, { holderId: 'ch_a', title: 'ungrouped', kind: 'info' })
  assert.deepEqual(s.emailOutbox.map((m) => m.subject).sort(), ['credit', 'ungrouped'])
  assert.equal(s.notifications.length, 5)
})
