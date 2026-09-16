import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { postCredit } from './ledger.js'
import { BREAK_KINDS, findBalanceBreaks, findLithicBreaks, findUnallocatedBreaks, openBreaks, resolveBreak, runReconciliation } from './recon.js'

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
  ownDatabase = await createTestDatabase('recon')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

function fixtures() {
  const run = randomUUID().slice(0, 8)
  return { run, holderId: `ch_${run}`, connectionId: `cx_${run}`, envelopeId: `env_${run}` }
}

/**
 * One cardholder with one funded envelope, reconciling cleanly. Every check below is
 * scoped to this cardholder so tests running in parallel cannot see each other's rows.
 */
async function withFundedHolder(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-recon-test' })
  const f = fixtures()
  try {
    await db.tx(async (c) => {
      await c.query(`INSERT INTO cardholders (id, first_name, last_name, email) VALUES ($1,'Test','Holder',$2)`, [f.holderId, `${f.run}@example.test`])
      await c.query(`INSERT INTO connections (id, name, protocol) VALUES ($1,'Test agency','json')`, [f.connectionId])
      await c.query(`INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name, balance_cents) VALUES ($1,$2,$3,'Test agency',60000)`, [f.envelopeId, f.holderId, f.connectionId])
      await c.query(
        `INSERT INTO credits (id, connection_id, cardholder_id, envelope_id, amount_cents, end_to_end_id)
         VALUES ($1,$2,$3,$4,60000,$5)`,
        [`crd_${f.run}`, f.connectionId, f.holderId, f.envelopeId, `E2E-${f.run}`],
      )
      await postCredit(c, {
        credit: { id: `crd_${f.run}`, amountCents: 60000, cardholderId: f.holderId },
        envelope: { id: f.envelopeId, cardholderId: f.holderId },
        connection: { id: f.connectionId },
      })
    })
    await fn(db, f)
  } finally {
    await db.query('DELETE FROM cardholders WHERE id = $1', [f.holderId]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = $1', [f.connectionId]).catch(() => {})
    await db.end()
  }
}

test('books that agree produce no breaks', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    assert.deepEqual(await findBalanceBreaks(db.pool, { cardholderId: f.holderId }), [])
    assert.deepEqual(await findUnallocatedBreaks(db.pool, { cardholderId: f.holderId }), [])

    const result = await runReconciliation({ db, cardholderId: f.holderId })
    assert.equal(result.status, 'OK')
    assert.deepEqual(result.breaks, [])
  })
})

test('a cached balance that drifts from the journal is a critical break', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    // Exactly the damage a posting bug would do: the projection moves, the journal does not.
    await db.query('UPDATE envelopes SET balance_cents = balance_cents - 500 WHERE id = $1', [f.envelopeId])

    const breaks = await findBalanceBreaks(db.pool, { cardholderId: f.holderId })
    assert.equal(breaks.length, 1)
    assert.equal(breaks[0].kind, BREAK_KINDS.ENVELOPE_BALANCE)
    assert.equal(breaks[0].severity, 'CRITICAL')
    assert.equal(breaks[0].expectedCents, 60000, 'the journal is the expectation')
    assert.equal(breaks[0].actualCents, 59500, 'the cached balance is what is wrong')
    assert.equal(breaks[0].detail.driftCents, -500)
  })
})

test('a run records its breaks and can be read back', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    await db.query('UPDATE envelopes SET balance_cents = balance_cents + 250 WHERE id = $1', [f.envelopeId])

    const result = await runReconciliation({ db, cardholderId: f.holderId })
    assert.equal(result.status, 'BREAKS')
    assert.equal(result.breaks.length, 1)

    const { rows } = await db.query('SELECT * FROM recon_runs WHERE id = $1', [result.runId])
    assert.equal(rows[0].status, 'BREAKS')
    assert.equal(rows[0].break_count, 1)
    assert.ok(rows[0].finished_at, 'the run is closed')
    assert.equal(rows[0].summary.byKind.ENVELOPE_BALANCE, 1)
    assert.equal(rows[0].summary.comparedWithLithic, false, 'no Lithic key means no Lithic comparison')

    const open = await openBreaks(db.pool)
    assert.ok(open.some((b) => b.run_id === result.runId))
  })
})

test('money booked outside an envelope is reported', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    const txnId = `txn_${f.run}`

    await db.tx(async (c) => {
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, unallocated_cents) VALUES ($1,$2,'SETTLED',2500,2500)`, [txnId, f.holderId])
    })

    const breaks = await findUnallocatedBreaks(db.pool, { cardholderId: f.holderId })
    assert.equal(breaks.length, 1)
    assert.equal(breaks[0].kind, BREAK_KINDS.UNALLOCATED)
    assert.equal(breaks[0].transactionId, txnId)
    assert.equal(breaks[0].actualCents, 2500)
    assert.match(breaks[0].detail.note, /outside any envelope/)
  })
})

test('a refund with nowhere to go reads differently from an overspend', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    await db.query(`INSERT INTO transactions (id, cardholder_id, status, kind, amount_cents, unallocated_cents) VALUES ($1,$2,'SETTLED','RETURN',2500,-2500)`, [`txn_${f.run}`, f.holderId])

    const [brk] = await findUnallocatedBreaks(db.pool, { cardholderId: f.holderId })
    assert.equal(brk.actualCents, -2500)
    assert.match(brk.detail.note, /Refund has no envelope/)
  })
})

test('a transaction Lithic does not have is critical, unless it holds no money', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    await db.tx(async (c) => {
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, live, merchant) VALUES ($1,$2,'SETTLED',2860,true,'{"descriptor":"REWE"}'::jsonb)`, [`txn_live_${f.run}`, f.holderId])
      await c.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, live) VALUES ($1,$2,'DECLINED',9900,true)`, [`txn_dec_${f.run}`, f.holderId])
    })

    const breaks = await findLithicBreaks(db.pool, [], { cardholderId: f.holderId })

    assert.equal(breaks.length, 1, 'the declined authorization is not a difference')
    assert.equal(breaks[0].kind, BREAK_KINDS.MISSING_IN_LITHIC)
    assert.equal(breaks[0].transactionId, `txn_live_${f.run}`)
    assert.equal(breaks[0].severity, 'CRITICAL')
  })
})

test('a transaction Stipend never recorded is reported', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    const breaks = await findLithicBreaks(
      db.pool,
      [{ id: 'txn_only_in_lithic', cardholderId: f.holderId, amountCents: 4200, status: 'SETTLED', merchant: { descriptor: 'Unknown merchant' } }],
      { cardholderId: f.holderId },
    )

    assert.equal(breaks.length, 1)
    assert.equal(breaks[0].kind, BREAK_KINDS.MISSING_IN_STIPEND)
    assert.equal(breaks[0].expectedCents, 4200)
    assert.equal(breaks[0].detail.lithicTransaction, 'txn_only_in_lithic')
  })
})

test('amount and status differences are reported separately', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    const txnId = `txn_${f.run}`
    await db.query(`INSERT INTO transactions (id, cardholder_id, status, amount_cents, live, merchant) VALUES ($1,$2,'PENDING',2860,true,'{"descriptor":"REWE"}'::jsonb)`, [txnId, f.holderId])

    const breaks = await findLithicBreaks(
      db.pool,
      [{ id: txnId, cardholderId: f.holderId, amountCents: 3000, status: 'SETTLED' }],
      { cardholderId: f.holderId },
    )

    const kinds = breaks.map((b) => b.kind).sort()
    assert.deepEqual(kinds, [BREAK_KINDS.AMOUNT_MISMATCH, BREAK_KINDS.STATUS_MISMATCH])

    const amount = breaks.find((b) => b.kind === BREAK_KINDS.AMOUNT_MISMATCH)
    assert.equal(amount.expectedCents, 3000)
    assert.equal(amount.actualCents, 2860)
    assert.equal(amount.severity, 'CRITICAL')

    // A lagging status is usually a sync that has not caught up, not lost money.
    assert.equal(breaks.find((b) => b.kind === BREAK_KINDS.STATUS_MISMATCH).severity, 'WARN')
  })
})

test('a run that compares against Lithic says so', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    const result = await runReconciliation({
      db,
      cardholderId: f.holderId,
      fetchLithicTransactions: async () => [],
    })

    const { rows } = await db.query('SELECT summary FROM recon_runs WHERE id = $1', [result.runId])
    assert.equal(rows[0].summary.comparedWithLithic, true)
    assert.equal(result.status, 'OK')
  })
})

test('a break is cleared once, with who decided and why', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    await db.query('UPDATE envelopes SET balance_cents = balance_cents - 100 WHERE id = $1', [f.envelopeId])
    const result = await runReconciliation({ db, cardholderId: f.holderId })
    const [brk] = await openBreaks(db.pool)
    const target = (await openBreaks(db.pool)).find((b) => b.run_id === result.runId) ?? brk

    const cleared = await resolveBreak(db.pool, {
      id: target.id,
      status: 'ACCEPTED',
      actor: 'ops@stipend.demo',
      resolution: 'Known drift from a manual correction.',
    })
    assert.equal(cleared.status, 'ACCEPTED')
    assert.equal(cleared.resolved_by, 'ops@stipend.demo')
    assert.ok(cleared.resolved_at)

    // Clearing it twice is refused rather than silently rewriting the decision.
    await assert.rejects(() => resolveBreak(db.pool, { id: target.id, actor: 'someone.else@stipend.demo' }), /already cleared/)
  })
})

test('a run failing is recorded rather than swallowed', { skip }, async () => {
  await withFundedHolder(async (db, f) => {
    await assert.rejects(
      () =>
        runReconciliation({
          db,
          cardholderId: f.holderId,
          fetchLithicTransactions: async () => {
            throw new Error('Lithic is unreachable')
          },
        }),
      /Lithic is unreachable/,
    )

    const { rows } = await db.query(`SELECT * FROM recon_runs WHERE status = 'FAILED' ORDER BY started_at DESC LIMIT 1`)
    assert.equal(rows[0].error, 'Lithic is unreachable')
    assert.ok(rows[0].finished_at)
  })
})
