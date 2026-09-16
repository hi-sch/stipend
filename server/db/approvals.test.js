import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { applyApproved, decide, expireStale, getApproval, listPending, needsApproval, requestApproval, SENSITIVE_ACTIONS } from './approvals.js'

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
  ownDatabase = await createTestDatabase('approvals')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

const MAKER = 'mira@stipend.demo'
const CHECKER = 'tomas@stipend.demo'

async function withDb(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-approvals-test' })
  const ids = []
  const track = async (promise) => {
    const approval = await promise
    ids.push(approval.id)
    return approval
  }
  try {
    await fn(db, { track, run: randomUUID().slice(0, 8) })
  } finally {
    await db.query('DELETE FROM approvals WHERE id = ANY($1)', [ids]).catch(() => {})
    await db.end()
  }
}

const ask = (db, { track }, extra = {}) =>
  track(
    db.tx((c) =>
      requestApproval(c, {
        action: 'cash.rule.update',
        target: 'cash_100_month',
        payload: { limitCents: 25000, period: 'MONTH' },
        requestedBy: MAKER,
        ...extra,
      }),
    ),
  )

test('sensitive actions are named, and everything else applies directly', () => {
  assert.equal(needsApproval('cash.rule.update'), true)
  assert.equal(needsApproval('credit.recall'), true)
  assert.equal(needsApproval('cardholder.delete'), true)
  assert.equal(needsApproval('ledger.external_payment'), true)

  // Reads and routine writes are not gated.
  assert.equal(needsApproval('auth.login'), false)
  assert.equal(needsApproval('cardholder.create'), false)
  assert.equal(needsApproval(''), false)
  assert.ok(SENSITIVE_ACTIONS.size > 0)
})

test('a request is parked with its payload intact', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    assert.equal(approval.status, 'PENDING')
    assert.equal(approval.requestedBy, MAKER)
    assert.equal(approval.target, 'cash_100_month')
    assert.deepEqual(approval.payload, { limitCents: 25000, period: 'MONTH' })
    assert.ok(approval.expiresAt, 'a request that nobody decides eventually lapses')
    assert.equal(approval.decidedBy, null)

    assert.ok((await listPending(db.pool)).some((a) => a.id === approval.id))
  })
})

test('the operator who asked cannot approve their own request', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    await assert.rejects(
      () => db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: MAKER })),
      (err) => err.status === 403 && /different operator/.test(err.message),
    )

    assert.equal((await getApproval(db.pool, approval.id)).status, 'PENDING', 'the request is untouched')
  })
})

test('the schema refuses four-eyes violations even if the check is bypassed', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    // Straight to the table, the way a future route or a migration might.
    await assert.rejects(
      () => db.query(`UPDATE approvals SET status = 'APPROVED', decided_by = $2 WHERE id = $1`, [approval.id, MAKER]),
      (err) => err.code === '23514',
    )
  })
})

test('a second operator approves, and the request can then be carried out', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    const approved = await db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: CHECKER, note: 'Agreed at standup.' }))
    assert.equal(approved.status, 'APPROVED')
    assert.equal(approved.decidedBy, CHECKER)
    assert.equal(approved.note, 'Agreed at standup.')

    let seen = null
    const { approval: applied, result } = await applyApproved(db, {
      id: approval.id,
      apply: async (c, payload) => {
        seen = payload
        return 'done'
      },
    })

    assert.deepEqual(seen, { limitCents: 25000, period: 'MONTH' }, 'the handler receives the parked payload')
    assert.equal(result, 'done')
    assert.equal(applied.status, 'APPLIED')
    assert.ok(applied.appliedAt)
  })
})

test('a rejected request is never carried out', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    const rejected = await db.tx((c) => decide(c, { id: approval.id, decision: 'REJECTED', decidedBy: CHECKER, note: 'Limit is too high.' }))
    assert.equal(rejected.status, 'REJECTED')

    let ran = false
    await assert.rejects(
      () => applyApproved(db, { id: approval.id, apply: async () => { ran = true } }),
      (err) => err.status === 409 && /rejected/.test(err.message),
    )
    assert.equal(ran, false, 'the handler never runs')
  })
})

test('a pending request cannot be carried out before anyone decides', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)

    let ran = false
    await assert.rejects(
      () => applyApproved(db, { id: approval.id, apply: async () => { ran = true } }),
      (err) => err.status === 409,
    )
    assert.equal(ran, false)
  })
})

test('a request is carried out once', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)
    await db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: CHECKER }))

    let runs = 0
    await applyApproved(db, { id: approval.id, apply: async () => { runs += 1 } })
    await assert.rejects(
      () => applyApproved(db, { id: approval.id, apply: async () => { runs += 1 } }),
      (err) => err.status === 409 && /already carried out/.test(err.message),
    )

    assert.equal(runs, 1)
  })
})

test('deciding twice is refused rather than rewriting the first decision', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)
    await db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: CHECKER }))

    await assert.rejects(
      () => db.tx((c) => decide(c, { id: approval.id, decision: 'REJECTED', decidedBy: 'someone.else@stipend.demo' })),
      (err) => err.status === 409 && /already approved/.test(err.message),
    )

    const current = await getApproval(db.pool, approval.id)
    assert.equal(current.status, 'APPROVED')
    assert.equal(current.decidedBy, CHECKER)
  })
})

test('a failing action is rolled back and recorded, not lost', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx)
    await db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: CHECKER }))

    await assert.rejects(
      () =>
        applyApproved(db, {
          id: approval.id,
          apply: async () => {
            throw new Error('Lithic rejected the rule')
          },
        }),
      /Lithic rejected the rule/,
    )

    const failed = await getApproval(db.pool, approval.id)
    assert.equal(failed.status, 'FAILED')
    assert.equal(failed.error, 'Lithic rejected the rule')
    assert.equal(failed.appliedAt, null, 'it was not carried out')
  })
})

test('an expired request cannot be approved', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const approval = await ask(db, ctx, { ttlMs: 1 })
    // Push it firmly into the past rather than waiting on the clock.
    await db.query(`UPDATE approvals SET expires_at = now() - interval '1 hour' WHERE id = $1`, [approval.id])

    await assert.rejects(
      () => db.tx((c) => decide(c, { id: approval.id, decision: 'APPROVED', decidedBy: CHECKER })),
      (err) => err.status === 409 && /expired/.test(err.message),
    )

    // decide() runs inside the caller's transaction and so writes nothing on the way out:
    // a status set there would be rolled back by the error that follows it. The row stays
    // pending until the sweep materializes the expiry.
    assert.equal((await getApproval(db.pool, approval.id)).status, 'PENDING')
    assert.ok((await expireStale(db.pool)).includes(approval.id))
    assert.equal((await getApproval(db.pool, approval.id)).status, 'EXPIRED')
  })
})

test('stale requests are swept', { skip }, async () => {
  await withDb(async (db, ctx) => {
    const stale = await ask(db, ctx)
    const fresh = await ask(db, ctx)
    await db.query(`UPDATE approvals SET expires_at = now() - interval '1 day' WHERE id = $1`, [stale.id])

    const expired = await expireStale(db.pool)
    assert.ok(expired.includes(stale.id))
    assert.ok(!expired.includes(fresh.id))

    assert.equal((await getApproval(db.pool, stale.id)).status, 'EXPIRED')
    assert.equal((await getApproval(db.pool, fresh.id)).status, 'PENDING')
  })
})

test('a request needs an action and a requester', { skip }, async () => {
  await withDb(async (db) => {
    await assert.rejects(() => db.tx((c) => requestApproval(c, { action: '', requestedBy: MAKER })), /needs an action/)
    await assert.rejects(() => db.tx((c) => requestApproval(c, { action: 'cash.rule.update', requestedBy: '' })), /needs a requester/)
  })
})

test('an unknown request is a 404', { skip }, async () => {
  await withDb(async (db) => {
    await assert.rejects(() => db.tx((c) => decide(c, { id: 'apr_nope', decision: 'APPROVED', decidedBy: CHECKER })), (err) => err.status === 404)
    await assert.rejects(() => applyApproved(db, { id: 'apr_nope', apply: async () => {} }), (err) => err.status === 404)
  })
})
