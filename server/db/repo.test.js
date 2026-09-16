import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { cashUsageFor, withCash } from '../domain.js'
import {
  applyBookedAmounts,
  applyEnvelopeDelta,
  cardholdersForConsole,
  cashConnectionIds,
  cashUsedSince,
  creditExists,
  getCardholder,
  creditsFor,
  envelopesFor,
  getCardholderByCardToken,
  getEnvelope,
  getTransaction,
  insertCredit,
  recordRecall,
  spentTodayFrom,
  transactionsFor,
  upsertEnvelopeForCredit,
  upsertTransaction,
} from './repo.js'

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
  ownDatabase = await createTestDatabase('repo')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

function fixtures() {
  const run = randomUUID().slice(0, 8)
  return {
    run,
    holderId: `ch_${run}`,
    cardToken: `card_${run}`,
    goodsConnectionId: `cx_g_${run}`,
    cashConnectionId: `cx_c_${run}`,
  }
}

async function withFixtures(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-repo-test' })
  const f = fixtures()
  try {
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO cardholders (id, first_name, last_name, email, card)
         VALUES ($1,'Test','Holder',$2,$3::jsonb)`,
        [f.holderId, `${f.run}@example.test`, JSON.stringify({ token: f.cardToken, state: 'OPEN', lastFour: '4713' })],
      )
      await c.query(`INSERT INTO connections (id, name, protocol, cash_allowed, mccs, countries) VALUES ($1,'Goods agency','json',false,'{5411,5912}','{DEU}')`, [f.goodsConnectionId])
      await c.query(`INSERT INTO connections (id, name, protocol, cash_allowed, mccs, countries) VALUES ($1,'Cash agency','json',true,'{6011}','{DEU}')`, [f.cashConnectionId])
    })
    await fn(db, f)
  } finally {
    await db.query('DELETE FROM cardholders WHERE id = $1', [f.holderId]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = ANY($1)', [[f.goodsConnectionId, f.cashConnectionId]]).catch(() => {})
    await db.end()
  }
}

const goodsConnection = (f) => ({ id: f.goodsConnectionId, name: 'Goods agency', mccs: ['5411', '5912'], countries: ['DEU'] })

test('the console query says exactly what asking per cardholder said', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    const ruleId = `cash_${f.run}`

    await db.tx(async (c) => {
      await upsertEnvelopeForCredit(c, {
        id: envelopeId,
        cardholderId: f.holderId,
        connection: { id: f.cashConnectionId, name: 'Cash agency', mccs: ['6011'], countries: ['DEU'] },
        amountCents: 60000,
        at: new Date().toISOString(),
      })
      await c.query(`INSERT INTO cash_rules (id, name, limit_cents, period) VALUES ($1,'Cash 100','10000','MONTH')`, [ruleId])
      await c.query(
        `INSERT INTO cardholder_cash (cardholder_id, status, rule_id, requested_cents, requested_period, reason, requested_at, decided_at, decided_by, note)
         VALUES ($1,'APPROVED',$2,5000,'MONTH','Market stall',now(),now(),'ops@stipend.demo','ok')`,
        [f.holderId, ruleId],
      )
      // Cash that counts, and cash that must not: a declined withdrawal.
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'SETTLED',2500,2500)`, [`txn_a_${f.run}`, f.holderId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'DECLINED',9900,9900)`, [`txn_b_${f.run}`, f.holderId])
    })

    const fromConsoleQuery = (await cardholdersForConsole(db.pool)).find((c) => c.id === f.holderId)

    // What the console used to be built from: one call per cardholder, twice over.
    const holder = await getCardholder(db.pool, f.holderId)
    const perRow = await withCash(db.pool, holder)
    const usage = await cashUsageFor(db.pool, f.holderId)

    assert.deepEqual(fromConsoleQuery.cash, perRow.cash, 'the cash block is unchanged')
    assert.deepEqual(fromConsoleQuery.cashUsage, usage, 'cash usage is unchanged, including the period boundary')
    assert.equal(fromConsoleQuery.summary.count, 1)
    assert.equal(fromConsoleQuery.summary.available, 60000)
    assert.equal(fromConsoleQuery.cashUsage.usedCents, 2500, 'a declined withdrawal does not consume the budget')
    assert.equal(fromConsoleQuery.cashUsage.remainingCents, 7500)

    await db.query('DELETE FROM cardholder_cash WHERE cardholder_id = $1', [f.holderId])
    await db.query('DELETE FROM cash_rules WHERE id = $1', [ruleId])
  })
})

test('a cardholder with no cash row reads as NONE, with no usage', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const row = (await cardholdersForConsole(db.pool)).find((c) => c.id === f.holderId)
    assert.deepEqual(row.cash, { status: 'NONE' })
    assert.equal(row.cashUsage, null)
    assert.deepEqual(row.summary, { count: 0, available: 0 })
  })
})

test('a card token finds its cardholder', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const holder = await getCardholderByCardToken(db.pool, f.cardToken)
    assert.equal(holder.id, f.holderId)
    assert.equal(holder.card.lastFour, '4713')

    assert.equal(await getCardholderByCardToken(db.pool, 'card_nope'), null)
    assert.equal(await getCardholderByCardToken(db.pool, null), null)
  })
})

test('the first credit creates an envelope and the next tops it up', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`

    const first = await db.tx((c) =>
      upsertEnvelopeForCredit(c, {
        id: envelopeId,
        cardholderId: f.holderId,
        connection: goodsConnection(f),
        amountCents: 60000,
        at: new Date().toISOString(),
        color: '#7C6CF0',
      }),
    )
    assert.equal(first.id, envelopeId)
    assert.equal(first.balanceCents, 60000)
    assert.deepEqual(first.mccs, ['5411', '5912'])

    // A second credit from the same connection tops up rather than forking a new envelope.
    const second = await db.tx((c) =>
      upsertEnvelopeForCredit(c, {
        id: `env_other_${f.run}`,
        cardholderId: f.holderId,
        connection: { ...goodsConnection(f), mccs: ['5411'] },
        amountCents: 15000,
        at: new Date().toISOString(),
      }),
    )
    assert.equal(second.id, envelopeId, 'the same envelope is reused')
    assert.equal(second.balanceCents, 75000)
    assert.deepEqual(second.mccs, ['5411'], 'the allowlist follows the connection')

    assert.equal((await envelopesFor(db.pool, f.holderId)).length, 1)
  })
})

test('an envelope delta lowers the balance and raises the spend, and a refund reverses it', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))

    const spent = await db.tx((c) => applyEnvelopeDelta(c, envelopeId, 2860))
    assert.equal(spent.balanceCents, 57140)
    assert.equal(spent.spentCents, 2860)

    const refunded = await db.tx((c) => applyEnvelopeDelta(c, envelopeId, -2860))
    assert.equal(refunded.balanceCents, 60000)
    assert.equal(refunded.spentCents, 0)

    // A zero delta is a no-op, not a write.
    assert.equal(await db.tx((c) => applyEnvelopeDelta(c, envelopeId, 0)), null)
  })
})

test('spend never drives the cached spend total below zero', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))

    const refundedFirst = await db.tx((c) => applyEnvelopeDelta(c, envelopeId, -5000))
    assert.equal(refundedFirst.spentCents, 0, 'spend floors at zero')
    assert.equal(refundedFirst.balanceCents, 65000, 'the money still arrives')
  })
})

test('a credit is recorded once and a replay is visible before it is attempted', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))

    const e2e = `E2E-${f.run}`
    assert.equal(await creditExists(db.pool, f.goodsConnectionId, e2e), false)

    const credit = await db.tx((c) =>
      insertCredit(c, {
        id: `crd_${f.run}`,
        connectionId: f.goodsConnectionId,
        cardholderId: f.holderId,
        envelopeId,
        amountCents: 60000,
        endToEndId: e2e,
        protocol: 'pain001',
        remittance: 'Test credit',
      }),
    )
    assert.equal(credit.amountCents, 60000)
    assert.equal(credit.recalledCents, 0)

    assert.equal(await creditExists(db.pool, f.goodsConnectionId, e2e), true)

    // And the database refuses the replay outright.
    await assert.rejects(
      () => db.tx((c) => insertCredit(c, { id: `crd2_${f.run}`, connectionId: f.goodsConnectionId, cardholderId: f.holderId, envelopeId, amountCents: 60000, endToEndId: e2e })),
      (err) => err.code === '23505',
    )

    assert.equal((await creditsFor(db.pool, f.holderId)).length, 1)
  })
})

test('a recall records what was taken back', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))
    await db.tx((c) => insertCredit(c, { id: `crd_${f.run}`, connectionId: f.goodsConnectionId, cardholderId: f.holderId, envelopeId, amountCents: 60000, endToEndId: `E2E-${f.run}` }))

    const recalled = await db.tx((c) =>
      recordRecall(c, {
        creditId: `crd_${f.run}`,
        recalledCents: 15000,
        status: 'PARTIALLY_RECALLED',
        recall: { at: new Date().toISOString(), reason: 'DUPL', recalledCents: 15000 },
      }),
    )
    assert.equal(recalled.recalledCents, 15000)
    assert.equal(recalled.status, 'PARTIALLY_RECALLED')
    assert.equal(recalled.recall.reason, 'DUPL')

    // Recalling more than the credit is refused by the schema, not by the caller.
    await assert.rejects(
      () => db.tx((c) => recordRecall(c, { creditId: `crd_${f.run}`, recalledCents: 70000, status: 'RECALLED' })),
      (err) => err.code === '23514',
    )
  })
})

test('a re-synced transaction updates status without resetting what is booked', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    const txnId = `txn_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))

    await db.tx((c) =>
      upsertTransaction(c, {
        id: txnId,
        cardholderId: f.holderId,
        cardToken: f.cardToken,
        status: 'PENDING',
        result: 'APPROVED',
        amountCents: 2860,
        requestedCents: 2860,
        envelopeId,
        merchant: { descriptor: 'REWE City', mcc: '5411', country: 'DEU' },
        detailedResults: ['APPROVED'],
      }),
    )
    await db.tx((c) => applyBookedAmounts(c, { transactionId: txnId, debitedCents: 2860, cashDebitedCents: 0 }))

    // Lithic sends the settled version of the same transaction.
    const settled = await db.tx((c) =>
      upsertTransaction(c, {
        id: txnId,
        cardholderId: f.holderId,
        cardToken: f.cardToken,
        status: 'SETTLED',
        result: 'APPROVED',
        amountCents: 2860,
        merchant: { descriptor: 'REWE City Prenzlauer Berg', mcc: '5411', country: 'DEU' },
        detailedResults: ['APPROVED'],
      }),
    )

    assert.equal(settled.status, 'SETTLED')
    assert.equal(settled.merchant.descriptor, 'REWE City Prenzlauer Berg')
    assert.equal(settled.debitedCents, 2860, 'the booked amount survives the re-sync')
    assert.equal(settled.envelopeId, envelopeId, 'the paying envelope is not cleared by a payload without one')
  })
})

test('cash used in the period counts only live cash spend', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const since = new Date(Date.now() - 86400000).toISOString()

    await db.tx(async (c) => {
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'SETTLED',5000,2000)`, [`txn_a_${f.run}`, f.holderId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'PENDING',3000,3000)`, [`txn_b_${f.run}`, f.holderId])
      // Declined and reversed cash does not consume the budget.
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'DECLINED',9000,9000)`, [`txn_c_${f.run}`, f.holderId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'VOIDED',4000,4000)`, [`txn_d_${f.run}`, f.holderId])
      // Neither does an ordinary purchase.
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'SETTLED',7000,0)`, [`txn_e_${f.run}`, f.holderId])
    })

    const used = await cashUsedSince(db.pool, f.holderId, since)
    assert.equal(used, 5000)
    assert.equal(typeof used, 'number')
  })
})

test('spend today from one envelope ignores declines and other envelopes', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    const otherId = `env_other_${f.run}`
    const since = new Date(Date.now() - 3600000).toISOString()

    await db.tx(async (c) => {
      await upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() })
      await upsertEnvelopeForCredit(c, { id: otherId, cardholderId: f.holderId, connection: { id: f.cashConnectionId, name: 'Cash agency', mccs: ['6011'], countries: ['DEU'] }, amountCents: 20000, at: new Date().toISOString() })

      await c.query(`INSERT INTO transactions (id, cardholder_id, status, kind, amount_cents, envelope_id) VALUES ($1,$2,'SETTLED','PURCHASE',2860,$3)`, [`txn_a_${f.run}`, f.holderId, envelopeId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, kind, amount_cents, envelope_id) VALUES ($1,$2,'DECLINED','PURCHASE',9900,$3)`, [`txn_b_${f.run}`, f.holderId, envelopeId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, kind, amount_cents, envelope_id) VALUES ($1,$2,'SETTLED','PURCHASE',1000,$3)`, [`txn_c_${f.run}`, f.holderId, otherId])
    })

    assert.equal(await spentTodayFrom(db.pool, f.holderId, envelopeId, since), 2860)
    assert.equal(await spentTodayFrom(db.pool, f.holderId, otherId, since), 1000)
  })
})

test('cash connections are listed for choosing a cash envelope', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const ids = await cashConnectionIds(db.pool)
    assert.equal(ids.has(f.cashConnectionId), true)
    assert.equal(ids.has(f.goodsConnectionId), false)
  })
})

test('envelopes can be locked for an authorization', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const envelopeId = `env_${f.run}`
    await db.tx((c) => upsertEnvelopeForCredit(c, { id: envelopeId, cardholderId: f.holderId, connection: goodsConnection(f), amountCents: 60000, at: new Date().toISOString() }))

    // The lock is held for the life of the transaction; here we only prove the query
    // shape is valid and still returns the rows the engine expects.
    const locked = await db.tx(async (c) => {
      const list = await envelopesFor(c, f.holderId, { forUpdate: true })
      const one = await getEnvelope(c, envelopeId, { forUpdate: true })
      return { list, one }
    })

    assert.equal(locked.list.length, 1)
    assert.equal(locked.one.balanceCents, 60000)
  })
})

test('a transaction round trips through the row mapper', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`
    await db.tx((c) =>
      upsertTransaction(c, {
        id: txnId,
        cardholderId: f.holderId,
        cardToken: f.cardToken,
        status: 'SETTLED',
        result: 'APPROVED',
        amountCents: 2860,
        merchant: { descriptor: 'REWE', mcc: '5411' },
        detailedResults: ['APPROVED'],
        events: [{ type: 'AUTHORIZATION', amount: 2860 }],
        lithic: { category: 'CARD' },
      }),
    )

    const txn = await getTransaction(db.pool, txnId)
    assert.equal(txn.cardholderId, f.holderId)
    assert.equal(txn.merchant.mcc, '5411')
    assert.deepEqual(txn.detailedResults, ['APPROVED'])
    assert.equal(txn.events[0].type, 'AUTHORIZATION')
    assert.equal(txn.lithic.category, 'CARD')
    assert.equal(typeof txn.amountCents, 'number')

    assert.equal((await transactionsFor(db.pool, f.holderId)).length, 1)
  })
})
