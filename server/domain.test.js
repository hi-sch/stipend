import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './db/testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './db/pool.js'
import { getEnvelope, getTransaction } from './db/repo.js'
import {
  allocateTransaction,
  applyCredit,
  authorizeAsa,
  cashUsageFor,
  createCashRule,
  decideCash,
  deleteCashRule,
  isDuplicateCredit,
  notify,
  reconcileTransaction,
  recallCredit,
  requestCash,
  resolveBeneficiary,
  updateCashRule,
  virtualIbanFor,
  withCash,
  withdrawCashRequest,
} from './domain.js'
import { isValidIban } from '../src/lib/pain001.js'

// Deliberately not process.env.DATABASE_URL: before() points this at a database of this
// file's own. Leaving it unset until then means a failure to create that database is a
// loud error here, instead of this file quietly writing into a development database.
let url = null
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set'

// This file writes, so it works in a database of its own rather than in whatever
// DATABASE_URL points at, which is usually somebody’s development database.
let ownDatabase = null
before(async () => {
  if (skip) return
  ownDatabase = await createTestDatabase('domain')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

/**
 * These are the rules that decide whether money moves, so they are exercised against a
 * real database rather than a stubbed one: the locking, the constraints and the journal
 * are part of the behaviour being tested.
 */
function fixture() {
  const run = randomUUID().slice(0, 8)
  return {
    run,
    holderId: `ch_${run}`,
    card: randomUUID(),
    foodId: `conn_food_${run}`,
    cashId: `conn_cash_${run}`,
  }
}

async function withWorld(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-domain-test' })
  const f = fixture()
  try {
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO cardholders (id, first_name, last_name, email, beneficiary_ref, iban, card)
         VALUES ($1,'A','Holder',$2,$3,$4,$5::jsonb)`,
        [f.holderId, `${f.run}@example.test`, `REF-${f.run}`, virtualIbanFor(f.holderId), JSON.stringify({ token: f.card, state: 'OPEN' })],
      )
      await c.query(
        `INSERT INTO connections (id, name, protocol, purpose, mccs, countries, daily_limit_cents, cash_allowed)
         VALUES ($1,'Food','json','SSBE','{5411}','{DEU}',20000,false)`,
        [f.foodId],
      )
    })
    await fn(db, f)
  } finally {
    await db.query('DELETE FROM cardholders WHERE id = $1', [f.holderId]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = ANY($1)', [[f.foodId, f.cashId]]).catch(() => {})
    await db.end()
  }
}

const addCashConnection = (db, f) =>
  db.query(
    `INSERT INTO connections (id, name, protocol, purpose, mccs, countries, cash_allowed)
     VALUES ($1,'Living costs','json','SSBE','{5999}','{}',true)`,
    [f.cashId],
  )

const connection = async (db, id) => {
  const { rows } = await db.query('SELECT * FROM connections WHERE id = $1', [id])
  const r = rows[0]
  return { id: r.id, name: r.name, protocol: r.protocol, purpose: r.purpose, mccs: r.mccs, countries: r.countries, cashAllowed: r.cash_allowed }
}

const holder = async (db, id) => {
  const { rows } = await db.query('SELECT * FROM cardholders WHERE id = $1', [id])
  return { id: rows[0].id, email: rows[0].email, card: rows[0].card }
}

const credit = async (db, f, { connectionId, amountCents, endToEndId }) =>
  db.tx(async (c) =>
    applyCredit(c, {
      connection: await connection(db, connectionId),
      holder: await holder(db, f.holderId),
      amountCents,
      endToEndId,
    }),
  )

const envelopeFor = async (db, f, connectionId) => {
  const { rows } = await db.query('SELECT id FROM envelopes WHERE cardholder_id = $1 AND connection_id = $2', [f.holderId, connectionId])
  return rows[0]?.id ?? null
}

const balance = async (db, envelopeId) => (await getEnvelope(db.pool, envelopeId)).balanceCents

const asa = (db, body) => db.tx((c) => authorizeAsa(c, body))

const lithicTxn = (f, overrides) => ({
  token: `txn_${f.run}`,
  card_token: f.card,
  created: '2026-09-14T10:00:00Z',
  result: 'APPROVED',
  status: 'PENDING',
  amounts: { hold: { amount: 1000 }, cardholder: { amount: 0, currency: 'USD' } },
  merchant: { descriptor: 'REWE', mcc: '5411', country: 'DEU' },
  events: [{ type: 'AUTHORIZATION', amount: 1000, result: 'APPROVED', detailed_results: ['APPROVED'] }],
  ...overrides,
})

const sync = (db, txn) => db.tx((c) => reconcileTransaction(c, txn))

test('virtual IBANs are valid and stable', () => {
  assert.equal(isValidIban(virtualIbanFor('ch_a')), true)
  assert.equal(virtualIbanFor('ch_a'), virtualIbanFor('ch_a'))
})

test('beneficiary resolution by reference then IBAN', { skip }, async () => {
  await withWorld(async (db, f) => {
    assert.equal((await resolveBeneficiary(db.pool, { beneficiaryRef: `REF-${f.run}` })).id, f.holderId)
    assert.equal((await resolveBeneficiary(db.pool, { iban: virtualIbanFor(f.holderId) })).id, f.holderId)
    assert.equal(await resolveBeneficiary(db.pool, { beneficiaryRef: 'nope' }), null)
  })
})

test('credit, ASA hold, clearing, void are idempotent envelope moves', { skip }, async () => {
  await withWorld(async (db, f) => {
    const created = await credit(db, f, { connectionId: f.foodId, amountCents: 5000, endToEndId: `E1-${f.run}` })
    assert.equal(await isDuplicateCredit(db.pool, f.foodId, `E1-${f.run}`), true)

    const env = await envelopeFor(db, f, f.foodId)
    assert.equal(await balance(db, env), 5000)

    const token = `txn_${f.run}`
    const res = await asa(db, { token, amount: 1000, card: { token: f.card }, merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } })
    assert.equal(res.result, 'APPROVED')
    assert.equal(await balance(db, env), 4000)

    // Same ASA again (Lithic retry) must not double-debit.
    await asa(db, { token, amount: 1000, card: { token: f.card }, merchant: { mcc: '5411', country: 'DEU' } })
    assert.equal(await balance(db, env), 4000)

    await sync(db, lithicTxn(f, { status: 'SETTLED', amounts: { settlement: { amount: 800 }, cardholder: { amount: 800 } } }))
    assert.equal(await balance(db, env), 4200)
    await sync(db, lithicTxn(f, { status: 'SETTLED', amounts: { settlement: { amount: 800 }, cardholder: { amount: 800 } } }))
    assert.equal(await balance(db, env), 4200)

    await sync(db, lithicTxn(f, { status: 'VOIDED' }))
    assert.equal(await balance(db, env), 5000)

    const recall = await db.tx((c) => recallCredit(c, { credit: created, reason: 'DUPL' }))
    assert.equal(recall.status, 'CNCL')
    assert.equal(await balance(db, env), 0)
  })
})

test('ASA declines unknown cards and partial approves capable terminals', { skip }, async () => {
  await withWorld(async (db, f) => {
    await credit(db, f, { connectionId: f.foodId, amountCents: 3000, endToEndId: `E1-${f.run}` })
    const env = await envelopeFor(db, f, f.foodId)

    const unknown = await asa(db, { token: `t0_${f.run}`, amount: 100, card: { token: randomUUID() }, merchant: { mcc: '5411' } })
    assert.equal(unknown.result, 'UNAUTHORIZED_MERCHANT')

    const res = await asa(db, {
      token: `t1_${f.run}`,
      amount: 5000,
      card: { token: f.card },
      merchant: { mcc: '5411', country: 'DEU' },
      pos: { terminal: { partial_approval_capable: true } },
    })
    assert.deepEqual(res, { result: 'APPROVED', token: `t1_${f.run}`, approved_amount: 3000 })
    assert.equal(await balance(db, env), 0)
  })
})

test('returns credit the envelope that paid', { skip }, async () => {
  await withWorld(async (db, f) => {
    await credit(db, f, { connectionId: f.foodId, amountCents: 3000, endToEndId: `E1-${f.run}` })
    const env = await envelopeFor(db, f, f.foodId)

    await asa(db, { token: `buy_${f.run}`, amount: 1000, card: { token: f.card }, merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } })
    await sync(
      db,
      lithicTxn(f, {
        token: `ret_${f.run}`,
        status: 'SETTLED',
        amounts: { settlement: { amount: 400 } },
        events: [{ type: 'RETURN', amount: 400, result: 'APPROVED' }],
      }),
    )

    assert.equal(await balance(db, env), 2400)
  })
})

test('recall of spent money is rejected', { skip }, async () => {
  await withWorld(async (db, f) => {
    const created = await credit(db, f, { connectionId: f.foodId, amountCents: 1000, endToEndId: `E1-${f.run}` })
    const env = await envelopeFor(db, f, f.foodId)
    await db.query('UPDATE envelopes SET balance_cents = 0 WHERE id = $1', [env])

    const recall = await db.tx((c) => recallCredit(c, { credit: created, reason: 'CUST' }))
    assert.equal(recall.status, 'RJCR')
  })
})

test('public HTTPS detection for ASA URLs', async () => {
  const { isPublicHttps } = await import('./lithicService.js')
  assert.equal(isPublicHttps('https://abc.trycloudflare.com/api/asa'), true)
  assert.equal(isPublicHttps('http://127.0.0.1:5175/api/asa'), false)
  assert.equal(isPublicHttps('https://localhost/api/asa'), false)
})

test('unmatched refunds wait for an operator and can be allocated', { skip }, async () => {
  await withWorld(async (db, f) => {
    await credit(db, f, { connectionId: f.foodId, amountCents: 3000, endToEndId: `E1-${f.run}` })
    const env = await envelopeFor(db, f, f.foodId)

    await sync(
      db,
      lithicTxn(f, {
        token: `ret2_${f.run}`,
        status: 'SETTLED',
        amounts: { settlement: { amount: 700 } },
        merchant: { descriptor: 'UNKNOWN SHOP', mcc: '5999' },
        events: [{ type: 'RETURN', amount: 700, result: 'APPROVED' }],
      }),
    )

    const txn = await getTransaction(db.pool, `ret2_${f.run}`)
    assert.equal(txn.review, 'NEEDS_ENVELOPE')
    assert.equal(txn.unallocatedCents, -700)

    const { rows: cases } = await db.query(`SELECT * FROM cases WHERE transaction_id = $1`, [`ret2_${f.run}`])
    assert.equal(cases[0].kind, 'refund-review')

    await db.tx((c) => allocateTransaction(c, { transactionId: `ret2_${f.run}`, envelopeId: env }))
    assert.equal(await balance(db, env), 3700)

    const { rows: closed } = await db.query(`SELECT status FROM cases WHERE transaction_id = $1`, [`ret2_${f.run}`])
    assert.equal(closed[0].status, 'CLOSED')
  })
})

test('cash rules: off by default, request, add to rule, ATM and cashback split, limits, void, revoke', { skip }, async () => {
  await withWorld(async (db, f) => {
    await addCashConnection(db, f)
    await credit(db, f, { connectionId: f.foodId, amountCents: 5000, endToEndId: `F1-${f.run}` })
    await credit(db, f, { connectionId: f.cashId, amountCents: 5000, endToEndId: `C1-${f.run}` })

    const food = await envelopeFor(db, f, f.foodId)
    const cashEnv = await envelopeFor(db, f, f.cashId)

    const atm = (token, amount, mcc = '6011') =>
      asa(db, {
        token: `${token}_${f.run}`,
        amount,
        cash_amount: mcc === '6011' ? amount : 0,
        card: { token: f.card },
        merchant: { mcc, country: 'DEU', descriptor: 'ATM' },
      })

    // Cash is off for every card until an operator adds the cardholder to a rule.
    assert.equal((await atm('a0', 1000)).result, 'UNAUTHORIZED_MERCHANT')
    assert.equal((await atm('q0', 1000, '6051')).result, 'UNAUTHORIZED_MERCHANT')

    await db.tx((c) => requestCash(c, f.holderId, { amountCents: 3000, period: 'MONTH', reason: 'Market stall' }))
    await assert.rejects(() => db.tx((c) => requestCash(c, f.holderId, { amountCents: 3000, period: 'MONTH' })), /already waiting/)
    await db.tx((c) => withdrawCashRequest(c, f.holderId))

    await assert.rejects(() => db.tx((c) => decideCash(c, f.holderId, { decision: 'APPROVE', ruleId: 'nope' })), /existing cash rule/)

    const rule = await db.tx((c) => createCashRule(c, { name: `Cash 30 ${f.run}`, limitCents: 3000, period: 'MONTH' }))
    await db.tx((c) => decideCash(c, f.holderId, { decision: 'APPROVE', ruleId: rule.id, actor: 'ops' }))

    const shown = await db.tx((c) => withCash(c, { id: f.holderId }))
    assert.equal(shown.cash.limitCents, 3000)

    await assert.rejects(() => db.tx((c) => deleteCashRule(c, rule.id)), /Remove the 1/)

    assert.equal((await atm('a1', 1500)).result, 'APPROVED')
    assert.equal((await atm('q1', 500, '6051')).result, 'APPROVED')
    assert.equal(await balance(db, cashEnv), 3000)
    assert.equal((await atm('a2', 1500)).result, 'VELOCITY_EXCEEDED')

    // A purchase with cashback splits across the goods envelope and the cash envelope.
    const cashback = await asa(db, {
      token: `cb1_${f.run}`,
      amount: 1800,
      cash_amount: 800,
      card: { token: f.card },
      merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' },
    })
    assert.equal(cashback.result, 'APPROVED')
    assert.equal(await balance(db, food), 4000)
    assert.equal(await balance(db, cashEnv), 2200)
    assert.equal((await cashUsageFor(db.pool, f.holderId)).usedCents, 2800)

    // Reversing it gives both parts back and frees the cash budget again.
    await sync(db, lithicTxn(f, { token: `cb1_${f.run}`, status: 'VOIDED', merchant: { mcc: '5411', country: 'DEU', descriptor: 'REWE' } }))
    assert.equal(await balance(db, food), 5000)
    assert.equal(await balance(db, cashEnv), 3000)
    assert.equal((await cashUsageFor(db.pool, f.holderId)).usedCents, 2000)

    // Raising the rule's limit applies to every member at once.
    await db.tx((c) => updateCashRule(c, rule.id, { limitCents: 10000 }))
    assert.equal((await cashUsageFor(db.pool, f.holderId)).remainingCents, 8000)

    await db.tx((c) => decideCash(c, f.holderId, { decision: 'REVOKE', note: 'Program ended' }))
    assert.equal((await atm('a3', 100)).result, 'UNAUTHORIZED_MERCHANT')
    await db.tx((c) => deleteCashRule(c, rule.id))
  })
})

test('cash from envelopes whose connection forbids cash is declined', { skip }, async () => {
  await withWorld(async (db, f) => {
    await credit(db, f, { connectionId: f.foodId, amountCents: 5000, endToEndId: `F1-${f.run}` })

    const rule = await db.tx((c) => createCashRule(c, { name: `Weekly ${f.run}`, limitCents: 3000, period: 'WEEK' }))
    await db.tx((c) => decideCash(c, f.holderId, { decision: 'APPROVE', ruleId: rule.id }))

    const res = await asa(db, { token: `x_${f.run}`, amount: 1000, cash_amount: 1000, card: { token: f.card }, merchant: { mcc: '6011' } })
    assert.equal(res.result, 'INSUFFICIENT_FUNDS')

    await db.tx((c) => decideCash(c, f.holderId, { decision: 'REVOKE' }))
    await db.tx((c) => deleteCashRule(c, rule.id))
  })
})

test('synced cash transactions without an ASA decision book cash on a cash envelope', { skip }, async () => {
  await withWorld(async (db, f) => {
    await addCashConnection(db, f)
    await credit(db, f, { connectionId: f.cashId, amountCents: 5000, endToEndId: `C1-${f.run}` })
    const cashEnv = await envelopeFor(db, f, f.cashId)

    const txn = await sync(db, lithicTxn(f, { token: `atm1_${f.run}`, merchant: { mcc: '6011', country: 'DEU', descriptor: 'ATM' } }))
    assert.equal(txn.cashCents, 1000)
    assert.equal(await balance(db, cashEnv), 4000)
  })
})

test("email alerts follow the cardholder's alert types", { skip }, async () => {
  await withWorld(async (db, f) => {
    const subjects = async () => {
      const { rows } = await db.query('SELECT subject FROM email_outbox WHERE to_address = $1 ORDER BY subject', [`${f.run}@example.test`])
      return rows.map((r) => r.subject)
    }

    await db.tx((c) => notify(c, { holderId: f.holderId, title: 'off', kind: 'decline' }))
    assert.deepEqual(await subjects(), [], 'nothing is emailed until the cardholder turns alerts on')

    await db.query(`UPDATE cardholders SET prefs = $2::jsonb WHERE id = $1`, [f.holderId, JSON.stringify({ emailAlerts: true, emailMuted: ['declines'] })])

    await db.tx((c) => notify(c, { holderId: f.holderId, title: 'muted', kind: 'decline' }))
    await db.tx((c) => notify(c, { holderId: f.holderId, title: 'muted 3ds', kind: '3ds' }))
    await db.tx((c) => notify(c, { holderId: f.holderId, title: 'credit', kind: 'credit' }))
    await db.tx((c) => notify(c, { holderId: f.holderId, title: 'ungrouped', kind: 'info' }))

    assert.deepEqual(await subjects(), ['credit', 'ungrouped'])

    const { rows } = await db.query('SELECT count(*)::int AS n FROM notifications WHERE cardholder_id = $1', [f.holderId])
    assert.equal(rows[0].n, 5, 'every notification is kept in the app even when no email is sent')
  })
})
