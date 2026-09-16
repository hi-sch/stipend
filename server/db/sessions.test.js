import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './pool.js'
import { createSessionStore } from './sessions.js'

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
  ownDatabase = await createTestDatabase('sessions')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

async function withUser(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-sessions-test' })
  const id = `usr_${randomUUID().slice(0, 8)}`
  try {
    await db.query(`INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,'T','admin','x')`, [id, `${id}@example.test`])
    await fn(createSessionStore(db), { id }, db)
  } finally {
    await db.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
    await db.end()
  }
}

test('a session round trips, and the token itself is never stored', { skip }, async () => {
  await withUser(async (sessions, user, db) => {
    const token = await sessions.create(user, { ip: '127.0.0.1', userAgent: 'test' })

    const found = await sessions.get(token)
    assert.equal(found.userId, user.id)

    const { rows } = await db.query('SELECT token_hash FROM sessions WHERE user_id = $1', [user.id])
    assert.notEqual(rows[0].token_hash, token, 'the column holds a hash')
    assert.ok(!rows[0].token_hash.includes(token))
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/)
  })
})

test('an unknown token resolves to nothing', { skip }, async () => {
  await withUser(async (sessions) => {
    assert.equal(await sessions.get('not-a-real-token'), null)
    assert.equal(await sessions.get(''), null)
    assert.equal(await sessions.get(null), null)
  })
})

test('reading a session slides its expiry', { skip }, async () => {
  await withUser(async (sessions, user, db) => {
    const token = await sessions.create(user)
    const before = (await db.query('SELECT expires_at FROM sessions WHERE user_id = $1', [user.id])).rows[0].expires_at

    await db.query(`UPDATE sessions SET expires_at = now() + interval '1 minute' WHERE user_id = $1`, [user.id])
    await sessions.get(token)

    const after = (await db.query('SELECT expires_at FROM sessions WHERE user_id = $1', [user.id])).rows[0].expires_at
    assert.ok(new Date(after) > new Date(Date.now() + 60_000), 'the window moved forward again')
    assert.ok(new Date(before) <= new Date(after))
  })
})

test('an expired session is refused and cleared', { skip }, async () => {
  await withUser(async (sessions, user, db) => {
    const token = await sessions.create(user)
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1`, [user.id])

    assert.equal(await sessions.get(token), null)
    const { rows } = await db.query('SELECT count(*)::int n FROM sessions WHERE user_id = $1', [user.id])
    assert.equal(rows[0].n, 0, 'and the row does not linger')
  })
})

test('each device gets its own session', { skip }, async () => {
  await withUser(async (sessions, user) => {
    await sessions.create(user)
    await sessions.create(user)
    assert.equal(await sessions.countForUser(user.id), 2)
  })
})

test('signing out other devices keeps the one asking', { skip }, async () => {
  await withUser(async (sessions, user) => {
    const mine = await sessions.create(user)
    const other = await sessions.create(user)

    await sessions.destroyUser(user.id, mine)

    assert.equal(await sessions.countForUser(user.id), 1)
    assert.ok(await sessions.get(mine), 'the current device stays signed in')
    assert.equal(await sessions.get(other), null, 'the other one does not')
  })
})

test('signing out everywhere leaves nothing', { skip }, async () => {
  await withUser(async (sessions, user) => {
    await sessions.create(user)
    await sessions.create(user)

    await sessions.destroyUser(user.id)
    assert.equal(await sessions.countForUser(user.id), 0)
  })
})

test('destroying one token leaves the rest', { skip }, async () => {
  await withUser(async (sessions, user) => {
    const first = await sessions.create(user)
    await sessions.create(user)

    await sessions.destroy(first)
    assert.equal(await sessions.get(first), null)
    assert.equal(await sessions.countForUser(user.id), 1)
  })
})

test('expired sessions are purged, live ones are not', { skip }, async () => {
  await withUser(async (sessions, user, db) => {
    const live = await sessions.create(user)
    // Two lapsed rows written directly, so the live one can be told apart without needing
    // the store's hashing (or a pgcrypto extension) to single it out.
    for (const hash of ['stale-a', 'stale-b']) {
      await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 hour')`, [hash, user.id])
    }

    assert.equal(await sessions.purgeExpired(), 2, 'both lapsed rows go')
    assert.equal(await sessions.countForUser(user.id), 1)
    assert.ok(await sessions.get(live), 'and the live session is untouched')
  })
})

test('deleting the user takes their sessions with them', { skip }, async () => {
  await withUser(async (sessions, user, db) => {
    await sessions.create(user)
    await db.query('DELETE FROM users WHERE id = $1', [user.id])

    const { rows } = await db.query('SELECT count(*)::int n FROM sessions WHERE user_id = $1', [user.id])
    assert.equal(rows[0].n, 0, 'a removed cardholder cannot leave a usable session behind')
  })
})
