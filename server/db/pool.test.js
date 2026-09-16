import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import { createPool } from './pool.js'

// Deliberately not process.env.DATABASE_URL: before() points this at a database of this
// file's own. Leaving it unset until then means a failure to create that database is a
// loud error here, instead of this file quietly writing into a development database.
let url = null
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set'

let ownDatabase = null
before(async () => {
  if (skip) return
  ownDatabase = await createTestDatabase('pool')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Finding a connection nobody gave back.
 *
 * idleTimeoutMillis only reaps clients that are idle *in the pool*. One that was checked out
 * and never released is invisible to it and to the pool's counts, shows in Postgres as an
 * ordinary idle backend, and stays for the life of the process. A development server was
 * once found holding 102 connections against a maximum of 10 with no way to tell which code
 * path had taken them, and that is what these cover.
 */
function poolWithLog(extra = {}) {
  const warnings = []
  const db = createPool({
    url,
    max: 4,
    applicationName: 'stipend-pool-test',
    leakAfterMs: 1_000,
    log: { warn: (message, meta) => warnings.push({ message, meta }), error() {}, info() {} },
    ...extra,
  })
  return { db, warnings }
}

test('a connection nobody gives back is reported, and says where it was taken', { skip }, async () => {
  const { db, warnings } = poolWithLog()
  try {
    const leaked = await db.pool.connect()
    await wait(2_500)

    assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings.map((w) => w.message))}`)
    assert.match(warnings[0].message, /held open far too long/)
    assert.ok(warnings[0].meta.heldMs >= 1_000, `heldMs was ${warnings[0].meta.heldMs}`)

    // The stack is taken at checkout, so it names this file rather than the sweep that
    // noticed. Without that the warning says a connection leaked and nothing more.
    assert.match(warnings[0].meta.where, /pool\.test\.js/)

    await wait(1_500)
    assert.equal(warnings.length, 1, 'reported once, not every sweep')

    leaked.release()
  } finally {
    await db.end()
  }
})

test('a connection that is given back is never reported', { skip }, async () => {
  const { db, warnings } = poolWithLog()
  try {
    for (let i = 0; i < 3; i++) {
      const client = await db.pool.connect()
      await client.query('SELECT 1')
      client.release()
    }
    await db.query('SELECT 1')
    await db.tx(async (c) => c.query('SELECT 1'))

    await wait(2_500)
    assert.deepEqual(warnings, [], 'ordinary traffic is not a leak')
    assert.equal(db.heldStats().held, 0)
  } finally {
    await db.end()
  }
})

test('a connection held on purpose can say so', { skip }, async () => {
  // The version stream listens for the life of the process and a migration holds its
  // advisory lock for as long as it runs. Both would otherwise be reported every sweep,
  // which is how people learn to ignore the one warning that matters.
  const { db, warnings } = poolWithLog()
  try {
    const listener = await db.pool.connect()
    db.untrack(listener)

    await wait(2_500)
    assert.deepEqual(warnings, [])
    assert.equal(db.heldStats().held, 0, 'it is no longer counted as held')

    listener.release()
  } finally {
    await db.end()
  }
})

test('held connections are counted and aged, for the health endpoint', { skip }, async () => {
  const { db } = poolWithLog()
  try {
    assert.deepEqual(db.heldStats(), { held: 0, oldestMs: 0 })

    const a = await db.pool.connect()
    await wait(60)
    const b = await db.pool.connect()

    const stats = db.heldStats()
    assert.equal(stats.held, 2)
    assert.ok(stats.oldestMs >= 60, `oldest was ${stats.oldestMs}ms`)

    a.release()
    b.release()
    assert.equal(db.heldStats().held, 0)
  } finally {
    await db.end()
  }
})

test('ending the pool stops the sweep', { skip }, async () => {
  // An interval left running keeps a reference to the pool and reports connections that
  // belong to a database nobody is using any more.
  const { db, warnings } = poolWithLog()
  const leaked = await db.pool.connect()
  leaked.release()
  await db.end()

  await wait(2_500)
  assert.deepEqual(warnings, [])
})
