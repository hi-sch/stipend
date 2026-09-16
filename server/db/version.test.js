import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { createPool } from './pool.js'
import { bumpVersion, createVersionStream, currentVersion } from './version.js'

// Deliberately not process.env.DATABASE_URL: before() points this at a database of this
// file's own. Leaving it unset until then means a failure to create that database is a
// loud error here, instead of this file quietly writing into a development database.
let url = null
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set'

// This file writes, so it works in a database of its own rather than in whatever
// DATABASE_URL points at, which is usually somebody's development database.
let ownDatabase = null
before(async () => {
  if (skip) return
  ownDatabase = await createTestDatabase('version')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

const quiet = { info() {}, warn() {}, error() {} }

async function withStream(fn) {
  const db = createPool({ url, max: 6, applicationName: 'stipend-version-test' })
  const stream = createVersionStream({ db, log: quiet })
  await stream.start()
  try {
    await fn(db, stream)
  } finally {
    await stream.stop()
    await db.end()
  }
}

/** Wait for a condition, or give up — tests must not hang on a notification that never comes. */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

test('the version starts at nothing and counts up', { skip }, async () => {
  await withStream(async (db) => {
    assert.equal(await currentVersion(db), 0, 'a fresh program has no version yet')

    assert.equal(await db.tx((c) => bumpVersion(c)), 1)
    assert.equal(await db.tx((c) => bumpVersion(c)), 2)
    assert.equal(await currentVersion(db), 2)
  })
})

test('a write on one connection reaches a listener on another', { skip }, async () => {
  await withStream(async (db, stream) => {
    // This is the whole point: with several replicas, the pod that writes is usually not
    // the pod holding the browser's event stream.
    const seen = []
    stream.subscribe((v) => seen.push(v))

    const version = await db.tx((c) => bumpVersion(c))
    assert.ok(await until(() => seen.includes(version)), `listener saw ${JSON.stringify(seen)}`)
  })
})

test('a rolled back write announces nothing', { skip }, async () => {
  await withStream(async (db, stream) => {
    const seen = []
    stream.subscribe((v) => seen.push(v))

    const before = await currentVersion(db)
    await db
      .tx(async (c) => {
        await bumpVersion(c)
        throw new Error('rolled back')
      })
      .catch(() => {})

    // NOTIFY is transactional, so nothing should arrive. Give it a moment to prove it.
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(seen, [], 'no version was announced')
    assert.equal(await currentVersion(db), before, 'and the counter did not move')
  })
})

test('every listener hears each change', { skip }, async () => {
  await withStream(async (db, stream) => {
    const a = []
    const b = []
    stream.subscribe((v) => a.push(v))
    stream.subscribe((v) => b.push(v))

    const version = await db.tx((c) => bumpVersion(c))
    assert.ok(await until(() => a.includes(version) && b.includes(version)))
  })
})

test('unsubscribing stops the notifications', { skip }, async () => {
  await withStream(async (db, stream) => {
    const seen = []
    const stop = stream.subscribe((v) => seen.push(v))

    const first = await db.tx((c) => bumpVersion(c))
    assert.ok(await until(() => seen.includes(first)))

    stop()
    await db.tx((c) => bumpVersion(c))
    await new Promise((r) => setTimeout(r, 300))

    assert.deepEqual(seen, [first], 'nothing arrived after unsubscribing')
  })
})

test('one listener throwing does not rob the others', { skip }, async () => {
  await withStream(async (db, stream) => {
    const seen = []
    stream.subscribe(() => {
      throw new Error('a browser disconnected mid-write')
    })
    stream.subscribe((v) => seen.push(v))

    const version = await db.tx((c) => bumpVersion(c))
    assert.ok(await until(() => seen.includes(version)), 'the second listener still heard it')
  })
})

test('a stopped stream delivers nothing more', { skip }, async () => {
  const db = createPool({ url, max: 4, applicationName: 'stipend-version-stop-test' })
  const stream = createVersionStream({ db, log: quiet })
  await stream.start()

  const seen = []
  stream.subscribe((v) => seen.push(v))
  await stream.stop()

  await db.tx((c) => bumpVersion(c))
  await new Promise((r) => setTimeout(r, 300))

  assert.deepEqual(seen, [], 'shutting down releases the connection and the listeners')
  await db.end()
})

test('the listener survives a database that closes idle sessions', { skip }, async () => {
  // A connection the application has lost track of can only be reclaimed by the server, so
  // production sets idle_session_timeout. This connection is idle by design — it listens and
  // nothing else — so it exempts itself. Without that it is terminated on a timer and the
  // stream spends its life reconnecting.
  const admin = createPool({ url, max: 1, applicationName: 'stipend-version-cfg' })
  await admin.query(`ALTER DATABASE ${ownDatabase.name} SET idle_session_timeout = '2s'`)
  await admin.end()

  // Opened after the setting, so it inherits it.
  const db = createPool({ url, max: 4, applicationName: 'stipend-version-idle-test' })
  const complaints = []
  const stream = createVersionStream({ db, log: { info() {}, warn: (m) => complaints.push(m), error() {} }, reconnectMs: 100 })
  await stream.start()

  try {
    const seen = []
    stream.subscribe((v) => seen.push(v))

    // Twice the timeout, doing nothing at all.
    await new Promise((r) => setTimeout(r, 4_500))
    assert.deepEqual(complaints, [], 'the listening connection was not terminated')

    const version = await db.tx((c) => bumpVersion(c))
    assert.ok(await until(() => seen.includes(version)), 'and it still delivers')
  } finally {
    await stream.stop()
    await db.end()
    const reset = createPool({ url, max: 1, applicationName: 'stipend-version-cfg' })
    await reset.query(`ALTER DATABASE ${ownDatabase.name} RESET idle_session_timeout`)
    await reset.end()
  }
})
