import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPool } from './db/pool.js'
import { migrate } from './db/migrate.js'
import { createLithicService } from './lithicService.js'
import { createCashRule, decideCash } from './domain.js'

const adminUrl = process.env.DATABASE_URL
const skip = adminUrl ? false : 'DATABASE_URL is not set'

let testUrl, dbName

/**
 * These tests own their database.
 *
 * syncCashRules is program-wide by nature: it looks at every cardholder with approved cash
 * and reconciles one set of Lithic rules against all of them. Sharing a database with other
 * test files means another file's cardholder changes what this one sees, so it gets its own.
 */
before(async () => {
  if (skip) return
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  dbName = `stipend_lithic_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()

  testUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
  const db = createPool({ url: testUrl, max: 2 })
  await migrate({ db })
  await db.end()
})

after(async () => {
  if (!dbName) return
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await admin.end()
})

/**
 * A fake Lithic that behaves like the real auth-rules API in the ways that matter here:
 * a rule is created inactive and becomes active only by promoting a draft, and PATCH
 * cannot put it back to ACTIVE.
 */
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

  return {
    rules,
    calls,
    configured: true,
    environment: 'sandbox',
    call,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  }
}

async function withProgram(fn) {
  const db = createPool({ url: testUrl, max: 4, applicationName: 'stipend-lithic-test' })
  const run = randomUUID().slice(0, 8)
  const f = {
    run,
    a: `ch_a_${run}`,
    b: `ch_b_${run}`,
    cardA: randomUUID(),
    cardB: randomUUID(),
    accountA: randomUUID(),
    accountB: randomUUID(),
    connectionId: `cx_${run}`,
    envelopeId: `env_${run}`,
    ruleId: null,
  }

  try {
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO cardholders (id, first_name, last_name, email, lithic_account, card)
         VALUES ($1,'A','Holder',$2,$3,$4::jsonb), ($5,'B','Holder',$6,$7,$8::jsonb)`,
        [
          f.a, `a-${run}@example.test`, f.accountA, JSON.stringify({ token: f.cardA, state: 'OPEN' }),
          f.b, `b-${run}@example.test`, f.accountB, JSON.stringify({ token: f.cardB, state: 'OPEN' }),
        ],
      )
      await c.query(
        `INSERT INTO connections (id, name, protocol, mccs, countries, daily_limit_cents) VALUES ($1,'Food','json','{5411}','{}',15000)`,
        [f.connectionId],
      )
      await c.query(
        `INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name, balance_cents, mccs, countries, received_at)
         VALUES ($1,$2,$3,'Food',5000,'{5411}','{}',now())`,
        [f.envelopeId, f.a, f.connectionId],
      )
      const rule = await createCashRule(c, { name: `Cash 100 ${run}`, limitCents: 10000, period: 'MONTH' })
      f.ruleId = rule.id
    })

    await fn(db, f)
  } finally {
    // Leave the program empty for the next test: these rules are program-wide.
    await db.query('DELETE FROM cardholders WHERE id = ANY($1)', [[f.a, f.b]]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = $1', [f.connectionId]).catch(() => {})
    await db.query('DELETE FROM cash_rules WHERE id = $1', [f.ruleId]).catch(() => {})
    await db.end()
  }
}

test('cash rules on Lithic: program-wide block with exclusions, shared account velocity per cash rule', { skip }, async () => {
  await withProgram(async (db, f) => {
    const lithic = fakeLithic()
    const service = createLithicService({ lithic, db })
    const named = (name) => lithic.rules.find((r) => r.name === name)

    await service.syncCashRules()

    const block = named('Stipend program cash block')
    const categories = named('Stipend program cash category block')
    assert.equal(block.state, 'ACTIVE')
    assert.equal(block.program_level, true)
    assert.deepEqual(block.excluded_card_tokens, [], 'nobody is excluded until they are in a cash rule')
    assert.deepEqual(block.current_version.parameters.conditions, [{ attribute: 'CASH_AMOUNT', operation: 'IS_GREATER_THAN', value: 0 }])
    assert.ok(['6010', '6011', '6051', '4829', '6540'].every((mcc) => categories.current_version.parameters.conditions[0].value.includes(mcc)))
    assert.equal(named(`Stipend cash rule ${f.ruleId}`), undefined, 'a rule with no members has no velocity limits')

    // Both cardholders join the rule.
    await db.tx(async (c) => {
      for (const holderId of [f.a, f.b]) await decideCash(c, holderId, { decision: 'APPROVE', ruleId: f.ruleId, actor: 'ops' })
    })
    await service.syncCashRules()

    assert.deepEqual([...block.excluded_card_tokens].sort(), [f.cardA, f.cardB].sort())

    const cash = named(`Stipend cash rule ${f.ruleId}`)
    assert.deepEqual([...cash.account_tokens].sort(), [f.accountA, f.accountB].sort(), 'members share one account-level limit')
    assert.deepEqual(cash.current_version.parameters, {
      scope: 'ACCOUNT',
      period: { type: 'MONTH', day_of_month: 1 },
      limit_amount: null,
      limit_count: null,
      limit_cash_amount: 10000,
    })

    // Quasi-cash carries no cash_amount, so it is capped by category instead.
    const quasi = named(`Stipend quasi-cash rule ${f.ruleId}`)
    assert.equal(quasi.current_version.parameters.limit_amount, 10000)
    assert.ok(!quasi.current_version.parameters.filters.include_mccs.includes('6011'))

    // A member's card allowlist gains the cash categories.
    await service.syncRules(f.a)
    assert.ok(named('Stipend MCC allowlist').current_version.parameters.conditions[0].value.includes('6011'))

    // Removing everyone deactivates the shared limits and blocks their cards again.
    await db.tx(async (c) => {
      for (const holderId of [f.a, f.b]) await decideCash(c, holderId, { decision: 'REVOKE', actor: 'ops' })
    })
    await service.syncCashRules()

    assert.deepEqual(block.excluded_card_tokens, [])
    assert.equal(cash.state, 'INACTIVE')
    assert.equal(quasi.state, 'INACTIVE')

    // Re-adding goes through draft + promote, because Lithic cannot PATCH a rule to ACTIVE.
    await db.tx((c) => decideCash(c, f.a, { decision: 'APPROVE', ruleId: f.ruleId, actor: 'ops' }))
    await service.syncCashRules()

    assert.equal(cash.state, 'ACTIVE')
    assert.deepEqual(cash.account_tokens, [f.accountA])
    assert.ok(!lithic.calls.some((c) => c.method === 'PATCH' && c.body?.state === 'ACTIVE'))

    // Leave nobody approved behind: the next test asserts an empty program.
    await db.tx((c) => decideCash(c, f.a, { decision: 'REVOKE', actor: 'ops' }))
  })
})

test('card rules follow the funded envelopes', { skip }, async () => {
  await withProgram(async (db, f) => {
    const lithic = fakeLithic()
    const service = createLithicService({ lithic, db })
    const named = (name) => lithic.rules.find((r) => r.name === name)

    await service.syncRules(f.a)

    const mcc = named('Stipend MCC allowlist')
    assert.deepEqual(mcc.current_version.parameters.conditions[0], { attribute: 'MCC', operation: 'IS_NOT_ONE_OF', value: ['5411'] })
    assert.deepEqual(mcc.card_tokens, [f.cardA])

    // The daily cap is the sum of the funded connections' limits.
    const velocity = named('Stipend daily velocity')
    assert.equal(velocity.current_version.parameters.limit_amount, 15000)
    assert.equal(velocity.current_version.parameters.scope, 'CARD')

    // The rule tokens are recorded against the card so the console can show them.
    const { rows } = await db.query('SELECT card FROM cardholders WHERE id = $1', [f.a])
    assert.equal(rows[0].card.mccRuleToken, mcc.token)
    assert.equal(rows[0].card.velocityRuleToken, velocity.token)
    assert.ok(rows[0].card.rulesSyncedAt)
    assert.equal(rows[0].card.token, f.cardA, 'the merge left the card token alone')
  })
})

test('an emptied envelope deactivates the velocity rule', { skip }, async () => {
  await withProgram(async (db, f) => {
    const lithic = fakeLithic()
    const service = createLithicService({ lithic, db })

    await service.syncRules(f.a)
    assert.equal(lithic.rules.find((r) => r.name === 'Stipend daily velocity').state, 'ACTIVE')

    await db.query('UPDATE envelopes SET balance_cents = 0 WHERE id = $1', [f.envelopeId])
    await service.syncRules(f.a)

    assert.equal(lithic.rules.find((r) => r.name === 'Stipend daily velocity').state, 'INACTIVE')
  })
})

test('a cardholder without a Lithic card is skipped rather than failing', { skip }, async () => {
  await withProgram(async (db, f) => {
    const lithic = fakeLithic()
    const service = createLithicService({ lithic, db })

    await db.query(`UPDATE cardholders SET card = '{"token":null,"state":"OPEN"}'::jsonb WHERE id = $1`, [f.b])
    assert.equal(await service.syncRules(f.b), null)
  })
})

test('activating a rule promotes a draft rather than patching its state', { skip }, async () => {
  await withProgram(async (db, f) => {
    const lithic = fakeLithic()
    const service = createLithicService({ lithic, db })

    await service.syncRules(f.a)
    const rule = lithic.rules.find((r) => r.name === 'Stipend MCC allowlist')
    assert.equal(rule.state, 'ACTIVE')

    // Deactivating is a plain PATCH, which Lithic does allow.
    await service.setRuleState(rule.token, 'INACTIVE')
    assert.equal(rule.state, 'INACTIVE')

    lithic.calls.length = 0
    await service.setRuleState(rule.token, 'ACTIVE')

    assert.equal(rule.state, 'ACTIVE', 'the rule is active again')
    assert.ok(
      lithic.calls.some((c) => c.method === 'POST' && c.path.endsWith('/draft')) &&
        lithic.calls.some((c) => c.method === 'POST' && c.path.endsWith('/promote')),
      'it goes through draft and promote',
    )
    assert.ok(
      !lithic.calls.some((c) => c.method === 'PATCH' && c.body?.state === 'ACTIVE'),
      'it never asks Lithic to PATCH a rule back to ACTIVE, which Lithic refuses',
    )
    assert.deepEqual(rule.current_version.parameters, rule.draft_version.parameters, 'the promoted version keeps its parameters')
  })
})

test('an unknown rule state is refused', { skip }, async () => {
  await withProgram(async (db) => {
    const service = createLithicService({ lithic: fakeLithic(), db })
    await assert.rejects(() => service.setRuleState('33333333-3333-4333-8333-000000000001', 'PAUSED'), /ACTIVE or INACTIVE/)
  })
})

test('public HTTPS detection for ASA URLs', async () => {
  const { isPublicHttps } = await import('./lithicService.js')
  assert.equal(isPublicHttps('https://abc.trycloudflare.com/api/asa'), true)
  assert.equal(isPublicHttps('http://127.0.0.1:5175/api/asa'), false)
  assert.equal(isPublicHttps('https://localhost/api/asa'), false)
  assert.equal(isPublicHttps('https://stipend.local/api/asa'), false)
  assert.equal(isPublicHttps('not a url'), false)
})
