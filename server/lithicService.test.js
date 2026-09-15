import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDb } from './db.js'
import { createLithicService } from './lithicService.js'

const CARD_A = '11111111-1111-4111-8111-111111111111'
const CARD_B = '11111111-1111-4111-8111-222222222222'
const ACCOUNT_A = '22222222-2222-4222-8222-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

function fakeLithic() {
  const rules = []
  const calls = []
  let n = 0
  const scopeOf = (r) => (r.program_level ? 'PROGRAM' : r.account_tokens?.length ? 'ACCOUNT' : 'CARD')
  const call = async (method, path, body) => {
    calls.push({ method, path, body })
    const url = new URL(path, 'https://lithic.test')
    if (method === 'GET' && url.pathname === '/v2/auth_rules') {
      const scope = url.searchParams.get('scope')
      const card = url.searchParams.get('card_token')
      return { data: rules.filter((r) => (!scope || scopeOf(r) === scope) && (!card || (r.card_tokens || []).includes(card))), has_more: false }
    }
    if (method === 'POST' && url.pathname === '/v2/auth_rules') {
      const rule = { token: `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`, state: 'INACTIVE', ...body, draft_version: { parameters: body.parameters } }
      rules.push(rule)
      return rule
    }
    const rule = rules.find((r) => url.pathname.includes(r.token))
    if (method === 'POST' && url.pathname.endsWith('/draft')) rule.draft_version = { parameters: body.parameters }
    if (method === 'POST' && url.pathname.endsWith('/promote')) Object.assign(rule, { state: 'ACTIVE', current_version: rule.draft_version })
    if (method === 'PATCH') Object.assign(rule, body)
    return rule || {}
  }
  return { rules, calls, configured: true, environment: 'sandbox', call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) }
}

test('cash rules on Lithic: program-wide block with exclusions, shared account velocity per cash rule', async () => {
  const lithic = fakeLithic()
  const db = createDb({
    file: ':memory:',
    pollMs: 0,
    seed: () => ({
      cardholders: [
        { id: 'ch_a', lithicAccount: ACCOUNT_A, card: { token: CARD_A, state: 'OPEN' } },
        { id: 'ch_b', lithicAccount: ACCOUNT_B, card: { token: CARD_B, state: 'OPEN' } },
      ],
      cashRules: [{ id: 'cash_100', name: 'Cash 100', limitCents: 10000, period: 'MONTH' }],
      connections: [{ id: 'c1', mccs: ['5411'], dailyLimitCents: 15000 }],
      envelopes: [{ id: 'e1', cardholderId: 'ch_a', connectionId: 'c1', balanceCents: 5000, mccs: ['5411'], countries: [] }],
      transactions: [],
    }),
  })
  const service = createLithicService({ lithic, db })
  const named = (name) => lithic.rules.find((r) => r.name === name)

  await service.syncCashRules()
  const block = named('Stipend program cash block')
  const categories = named('Stipend program cash category block')
  assert.equal(block.state, 'ACTIVE')
  assert.equal(block.program_level, true)
  assert.deepEqual(block.excluded_card_tokens, [])
  assert.deepEqual(block.current_version.parameters.conditions, [{ attribute: 'CASH_AMOUNT', operation: 'IS_GREATER_THAN', value: 0 }])
  assert.ok(['6010', '6011', '6051', '4829', '6540'].every((mcc) => categories.current_version.parameters.conditions[0].value.includes(mcc)))
  assert.equal(named('Stipend cash rule cash_100'), undefined)

  db.mutate((s) => {
    for (const h of s.cardholders) h.cash = { status: 'APPROVED', ruleId: 'cash_100' }
  })
  await service.syncCashRules()
  assert.deepEqual(block.excluded_card_tokens, [CARD_A, CARD_B])
  const cash = named('Stipend cash rule cash_100')
  assert.deepEqual(cash.account_tokens, [ACCOUNT_A, ACCOUNT_B])
  assert.deepEqual(cash.current_version.parameters, { scope: 'ACCOUNT', period: { type: 'MONTH', day_of_month: 1 }, limit_amount: null, limit_count: null, limit_cash_amount: 10000 })
  const quasi = named('Stipend quasi-cash rule cash_100')
  assert.equal(quasi.current_version.parameters.limit_amount, 10000)
  assert.ok(!quasi.current_version.parameters.filters.include_mccs.includes('6011'))

  // Card-level allowlist gains the cash categories for members.
  await service.syncRules('ch_a')
  assert.ok(named('Stipend MCC allowlist').current_version.parameters.conditions[0].value.includes('6011'))

  // Removing everyone deactivates the shared velocity rules and blocks their cards again.
  db.mutate((s) => {
    for (const h of s.cardholders) h.cash = { status: 'REVOKED' }
  })
  await service.syncCashRules()
  assert.deepEqual(block.excluded_card_tokens, [])
  assert.equal(cash.state, 'INACTIVE')
  assert.equal(quasi.state, 'INACTIVE')

  // Re-adding re-activates through draft + promote (Lithic cannot PATCH a rule back to ACTIVE).
  db.mutate((s) => {
    s.cardholders[0].cash = { status: 'APPROVED', ruleId: 'cash_100' }
  })
  await service.syncCashRules()
  assert.equal(cash.state, 'ACTIVE')
  assert.deepEqual(cash.account_tokens, [ACCOUNT_A])
  assert.ok(!lithic.calls.some((c) => c.method === 'PATCH' && c.body?.state === 'ACTIVE'))
  db.close()
})
