import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { appendAudit, auditList, verifyAuditChain } from './audit.js'

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
  ownDatabase = await createTestDatabase('audit')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

/**
 * The audit table is append-only and shared, so these tests never delete from it (they
 * could not anyway) and never assume they own it.
 *
 * Verification runs from a checkpoint the test itself writes, not over the whole table. A
 * database that has ever had a row inserted outside appendAudit — a migration, a manual
 * fix, a restored backup — is permanently unverifiable from the beginning, and that is the
 * detector doing its job rather than something a test should paper over.
 */
async function withDb(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-audit-test' })
  try {
    const run = randomUUID().slice(0, 8)
    const { rows } = await db.query('SELECT COALESCE(max(id), 0) + 1 AS next FROM audit')
    await fn(db, run, Number(rows[0].next))
  } finally {
    await db.end()
  }
}

test('an appended entry links to the one before it', { skip }, async () => {
  await withDb(async (db, run, _fromId) => {
    const first = await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.one`, target: 't1' })
    const second = await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.two`, details: { limitCents: 10000 } })

    assert.equal(second.prevHash, first.hash, 'each entry commits to its predecessor')
    assert.notEqual(first.hash, second.hash)
    assert.match(first.hash, /^[0-9a-f]{64}$/)
  })
})

test('the chain verifies', { skip }, async () => {
  await withDb(async (db, run, fromId) => {
    await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.verify` })

    const result = await verifyAuditChain(db, { fromId })
    assert.equal(result.ok, true, result.reason || '')
    assert.ok(result.checked > 0)
  })
})

test('verification crosses batch boundaries', { skip }, async () => {
  await withDb(async (db, run, fromId) => {
    for (let i = 0; i < 5; i++) await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.batch.${i}` })

    // A batch size this small forces several passes. Resuming each pass from the previous
    // batch's last hash is the whole point: seeding every batch from the genesis value
    // reports a false break on the second one.
    const result = await verifyAuditChain(db, { fromId, batchSize: 2 })
    assert.equal(result.ok, true, result.reason || '')

    const whole = await verifyAuditChain(db, { fromId, batchSize: 10000 })
    assert.equal(whole.checked, result.checked, 'batch size does not change what is checked')
  })
})

test('a row written outside appendAudit breaks the chain', { skip }, async () => {
  await withDb(async (db, run, fromId) => {
    await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.before` })

    // Exactly what a migration, a manual fix or a restored backup would leave behind.
    const { rows } = await db.query(
      `INSERT INTO audit (actor, action, outcome, hash) VALUES ('someone','${'forged'}.${run}','ok','not-a-real-hash') RETURNING id`,
    )

    const result = await verifyAuditChain(db, { fromId })
    assert.equal(result.ok, false)
    assert.equal(result.brokenAt, rows[0].id, 'the unchained row is named')
  })
})

test('the table refuses to be rewritten', { skip }, async () => {
  await withDb(async (db, run, _fromId) => {
    const entry = await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.immutable` })
    assert.ok(entry.hash)

    await assert.rejects(
      () => db.query(`UPDATE audit SET actor = 'someone.else' WHERE action = $1`, [`test.${run}.immutable`]),
      (err) => err.code === '42501',
    )
    await assert.rejects(
      () => db.query('DELETE FROM audit WHERE action = $1', [`test.${run}.immutable`]),
      (err) => err.code === '42501',
    )
  })
})

test('concurrent appends do not fork the chain', { skip }, async () => {
  await withDb(async (db, run, fromId) => {
    // Without the advisory lock these would read the same tip and both claim it.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.race.${i}` })),
    )

    const result = await verifyAuditChain(db, { fromId })
    assert.equal(result.ok, true, result.reason || '')
  })
})

test('entries are listed newest first and filtered', { skip }, async () => {
  await withDb(async (db, run, _fromId) => {
    await appendAudit(db, { actor: `alice-${run}@stipend.demo`, action: `test.${run}.listed`, target: 'x' })
    await appendAudit(db, { actor: `bob-${run}@stipend.demo`, action: `test.${run}.listed`, target: 'y' })

    const byActor = await auditList(db, { actor: `alice-${run}@stipend.demo` })
    assert.equal(byActor.length, 1)
    assert.equal(byActor[0].target, 'x')

    const byAction = await auditList(db, { action: `test.${run}.listed` })
    assert.equal(byAction.length, 2)
    assert.ok(byAction[0].id > byAction[1].id, 'newest first')

    const limited = await auditList(db, { action: `test.${run}.listed`, limit: 1 })
    assert.equal(limited.length, 1)
  })
})

test('details survive the round trip and are part of the hash', { skip }, async () => {
  await withDb(async (db, run, fromId) => {
    await appendAudit(db, { actor: 'ops@stipend.demo', action: `test.${run}.details`, details: { limitCents: 10000, period: 'MONTH' } })

    const [row] = await auditList(db, { action: `test.${run}.details` })
    assert.deepEqual(row.details, { limitCents: 10000, period: 'MONTH' })

    const result = await verifyAuditChain(db, { fromId })
    assert.equal(result.ok, true, result.reason || '')
  })
})
