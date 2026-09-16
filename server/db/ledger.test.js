import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { allEnvelopeBalances, envelopeBalance, postAllocation, postCredit, postEntry, postRecall, postTransactionDelta } from './ledger.js'

// These tests need a real Postgres, because what is being tested is largely the database's
// own guarantees. Without DATABASE_URL they skip rather than fail, so `npm test` still
// runs everywhere.
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
  ownDatabase = await createTestDatabase('ledger')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

/** Every run uses fresh ids, so idempotency keys from an earlier run cannot collide. */
function fixtures() {
  const run = randomUUID().slice(0, 8)
  return {
    run,
    holderId: `ch_${run}`,
    goodsConnectionId: `cx_g_${run}`,
    cashConnectionId: `cx_c_${run}`,
    goodsEnvelopeId: `env_g_${run}`,
    cashEnvelopeId: `env_c_${run}`,
  }
}

/**
 * One cardholder with two envelopes, each fed by its own connection, because an envelope
 * is unique per (cardholder, connection).
 */
async function withFixtures(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-ledger-test' })
  const f = fixtures()
  try {
    await db.tx(async (c) => {
      await c.query(`INSERT INTO cardholders (id, first_name, last_name, email) VALUES ($1,'Test','Holder',$2)`, [f.holderId, `${f.run}@example.test`])
      await c.query(`INSERT INTO connections (id, name, protocol, cash_allowed) VALUES ($1,'Goods agency','json',false)`, [f.goodsConnectionId])
      await c.query(`INSERT INTO connections (id, name, protocol, cash_allowed) VALUES ($1,'Cash agency','json',true)`, [f.cashConnectionId])
      await c.query(`INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name) VALUES ($1,$2,$3,'Goods agency')`, [f.goodsEnvelopeId, f.holderId, f.goodsConnectionId])
      await c.query(`INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name) VALUES ($1,$2,$3,'Cash agency')`, [f.cashEnvelopeId, f.holderId, f.cashConnectionId])
    })
    await fn(db, f)
  } finally {
    // Cardholder delete cascades to envelopes, transactions, credits and ledger accounts.
    await db.query('DELETE FROM cardholders WHERE id = $1', [f.holderId]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = ANY($1)', [[f.goodsConnectionId, f.cashConnectionId]]).catch(() => {})
    await db.end()
  }
}

/**
 * Credit an envelope the way the hook does: the credit row first, then the posting.
 * journal_entries.credit_id references credits, so the row has to exist.
 */
async function fund(c, f, { id, amountCents, envelopeId, connectionId }) {
  await c.query(
    `INSERT INTO credits (id, connection_id, cardholder_id, envelope_id, amount_cents, end_to_end_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, connectionId, f.holderId, envelopeId, amountCents, `E2E-${id}`],
  )
  return postCredit(c, {
    credit: { id, amountCents, cardholderId: f.holderId, remittance: 'Test credit' },
    envelope: { id: envelopeId, cardholderId: f.holderId },
    connection: { id: connectionId },
  })
}

const fundGoods = (c, f, amountCents = 60000, suffix = '') =>
  fund(c, f, { id: `crd_g${suffix}_${f.run}`, amountCents, envelopeId: f.goodsEnvelopeId, connectionId: f.goodsConnectionId })

const fundCash = (c, f, amountCents = 20000) =>
  fund(c, f, { id: `crd_c_${f.run}`, amountCents, envelopeId: f.cashEnvelopeId, connectionId: f.cashConnectionId })

test('a credit lands in the envelope and balances', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const entry = await db.tx((c) => fundGoods(c, f))
    assert.ok(entry, 'first posting returns an entry id')

    const balance = await envelopeBalance(db.pool, f.goodsEnvelopeId)
    assert.equal(balance, 60000)
    assert.equal(typeof balance, 'number', 'money comes back as a number, not a numeric string')
  })
})

test('replaying a credit posts nothing and does not move the balance', { skip }, async () => {
  await withFixtures(async (db, f) => {
    await db.tx((c) => fundGoods(c, f))

    const replay = await db.tx((c) =>
      postCredit(c, {
        credit: { id: `crd_g_${f.run}`, amountCents: 60000, cardholderId: f.holderId },
        envelope: { id: f.goodsEnvelopeId, cardholderId: f.holderId },
        connection: { id: f.goodsConnectionId },
      }),
    )

    assert.equal(replay, null, 'a replayed credit is skipped')
    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000)
  })
})

test('a settled purchase takes money out of the envelope', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, envelope_id) VALUES ($1,$2,'SETTLED',2860,$3)`, [txnId, f.holderId, f.goodsEnvelopeId])
      await postTransactionDelta(c, {
        transactionId: txnId,
        cardholderId: f.holderId,
        envelopeId: f.goodsEnvelopeId,
        cashEnvelopeId: null,
        goodsDelta: 2860,
        cashDelta: 0,
        bookedTotal: 2860,
        bookedCash: 0,
      })
    })

    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000 - 2860)
  })
})

test('replaying the same booked state posts nothing', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`
    const delta = {
      transactionId: txnId,
      cardholderId: f.holderId,
      envelopeId: f.goodsEnvelopeId,
      cashEnvelopeId: null,
      goodsDelta: 2860,
      cashDelta: 0,
      bookedTotal: 2860,
      bookedCash: 0,
    }

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents) VALUES ($1,$2,'SETTLED',2860)`, [txnId, f.holderId])
      await postTransactionDelta(c, delta)
    })

    const replay = await db.tx((c) => postTransactionDelta(c, delta))
    assert.equal(replay, null)
    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000 - 2860)
  })
})

test('a purchase with cashback draws on two envelopes in one entry', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await fundCash(c, f)
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, cash_cents) VALUES ($1,$2,'SETTLED',5000,2000)`, [txnId, f.holderId])

      // 50.00 of which 20.00 is cashback: 30.00 from goods, 20.00 from the cash envelope.
      await postTransactionDelta(c, {
        transactionId: txnId,
        cardholderId: f.holderId,
        envelopeId: f.goodsEnvelopeId,
        cashEnvelopeId: f.cashEnvelopeId,
        goodsDelta: 3000,
        cashDelta: 2000,
        bookedTotal: 5000,
        bookedCash: 2000,
      })
    })

    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000 - 3000)
    assert.equal(await envelopeBalance(db.pool, f.cashEnvelopeId), 20000 - 2000)

    // One entry, four lines, and it balances.
    const { rows } = await db.query(
      `SELECT count(*)::int AS lines,
              sum(amount_cents) FILTER (WHERE direction='DR')::bigint AS dr,
              sum(amount_cents) FILTER (WHERE direction='CR')::bigint AS cr
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.transaction_id = $1`,
      [txnId],
    )
    assert.equal(rows[0].lines, 4)
    assert.equal(rows[0].dr, rows[0].cr)
  })
})

test('a refund puts money back', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents) VALUES ($1,$2,'SETTLED',2860)`, [txnId, f.holderId])
      await postTransactionDelta(c, {
        transactionId: txnId, cardholderId: f.holderId, envelopeId: f.goodsEnvelopeId, cashEnvelopeId: null,
        goodsDelta: 2860, cashDelta: 0, bookedTotal: 2860, bookedCash: 0,
      })
      // Reversed: what was booked goes back to zero.
      await postTransactionDelta(c, {
        transactionId: txnId, cardholderId: f.holderId, envelopeId: f.goodsEnvelopeId, cashEnvelopeId: null,
        goodsDelta: -2860, cashDelta: 0, bookedTotal: 0, bookedCash: 0, kind: 'REVERSAL',
      })
    })

    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000)
  })
})

test('a recall takes back unspent money', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const creditId = `crd_g_${f.run}`

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await postRecall(c, {
        credit: { id: creditId },
        envelopeId: f.goodsEnvelopeId,
        takenCents: 15000,
        recalledTotalCents: 15000,
        connectionId: f.goodsConnectionId,
        cardholderId: f.holderId,
      })
    })

    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 45000)
  })
})

test('a second partial recall is a separate posting', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const creditId = `crd_g_${f.run}`
    const recall = (takenCents, recalledTotalCents) => ({
      credit: { id: creditId },
      envelopeId: f.goodsEnvelopeId,
      takenCents,
      recalledTotalCents,
      connectionId: f.goodsConnectionId,
      cardholderId: f.holderId,
    })

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await postRecall(c, recall(10000, 10000))
      await postRecall(c, recall(5000, 15000))
    })

    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 45000)

    // Replaying the first one changes nothing.
    const replay = await db.tx((c) => postRecall(c, recall(10000, 10000)))
    assert.equal(replay, null)
    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 45000)
  })
})

test('an operator allocation moves money out of unallocated', { skip }, async () => {
  await withFixtures(async (db, f) => {
    const txnId = `txn_${f.run}`

    await db.tx(async (c) => {
      await fundGoods(c, f)
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents) VALUES ($1,$2,'SETTLED',2500)`, [txnId, f.holderId])
      // Approved with no envelope to carry it: it lands in unallocated.
      await postTransactionDelta(c, {
        transactionId: txnId, cardholderId: f.holderId, envelopeId: null, cashEnvelopeId: null,
        goodsDelta: 2500, cashDelta: 0, bookedTotal: 2500, bookedCash: 0,
      })
      // The operator attributes it to a real envelope.
      await postAllocation(c, { transactionId: txnId, cardholderId: f.holderId, envelopeId: f.goodsEnvelopeId, amountCents: 2500, actor: 'ops@stipend.demo' })
    })

    const { rows } = await db.query(
      `SELECT (COALESCE(sum(amount_cents) FILTER (WHERE direction='DR'),0)
             - COALESCE(sum(amount_cents) FILTER (WHERE direction='CR'),0))::bigint AS net
         FROM journal_lines WHERE account_id = $1`,
      [`unalloc:${f.holderId}`],
    )
    assert.equal(rows[0].net, 0, 'unallocated is emptied by the allocation')
    assert.equal(await envelopeBalance(db.pool, f.goodsEnvelopeId), 60000 - 2500, 'the spend now sits on the envelope')
  })
})

test('an unbalanced entry is refused before it reaches the database', { skip }, async () => {
  await withFixtures(async (db, f) => {
    await assert.rejects(
      () => db.tx(async (c) => {
        const account = `env:${f.goodsEnvelopeId}`
        await c.query(`INSERT INTO ledger_accounts (id, kind, envelope_id, cardholder_id) VALUES ($1,'ENVELOPE',$2,$3) ON CONFLICT DO NOTHING`, [account, f.goodsEnvelopeId, f.holderId])
        await postEntry(c, {
          idempotencyKey: `bad:${f.run}`,
          kind: 'ADJUSTMENT',
          lines: [{ accountId: account, direction: 'DR', amountCents: 500 }],
        })
      }),
      /does not balance/,
    )
  })
})

test('the per-envelope sweep agrees with the single-envelope query', { skip }, async () => {
  await withFixtures(async (db, f) => {
    await db.tx((c) => fundGoods(c, f, 12345))

    const all = await allEnvelopeBalances(db.pool)
    assert.equal(all.get(f.goodsEnvelopeId), await envelopeBalance(db.pool, f.goodsEnvelopeId))
    assert.equal(all.get(f.goodsEnvelopeId), 12345)
  })
})
