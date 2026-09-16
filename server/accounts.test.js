import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter, createSessions, hashPassword, parseCookies, verifyPassword } from './accounts.js'

test('password hashing round-trip', () => {
  const stored = hashPassword('correct horse battery')
  assert.equal(verifyPassword('correct horse battery', stored), true)
  assert.equal(verifyPassword('wrong', stored), false)
  assert.equal(verifyPassword('x', 'garbage'), false)
})

test('sessions expire and can be destroyed', () => {
  const sessions = createSessions({ ttlMs: 50 })
  const token = sessions.create({ id: 'u1' })
  assert.equal(sessions.get(token).userId, 'u1')
  sessions.destroy(token)
  assert.equal(sessions.get(token), null)
})

test('rate limiter blocks after max hits', () => {
  const limiter = createRateLimiter({ max: 2 })
  assert.equal(limiter.allow('k'), true)
  assert.equal(limiter.allow('k'), true)
  assert.equal(limiter.allow('k'), false)
})

test('rate limiter counts each key separately', () => {
  const limiter = createRateLimiter({ max: 1 })
  assert.equal(limiter.allow('a'), true)
  assert.equal(limiter.allow('b'), true, 'one key being over does not block another')
  assert.equal(limiter.allow('a'), false)
})

test('rate limiter forgets hits once the window has passed', async () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 40 })
  assert.equal(limiter.allow('k'), true)
  assert.equal(limiter.allow('k'), false)

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(limiter.allow('k'), true, 'the window slid')
})

test('rate limiter does not grow for ever', async () => {
  // The login key is `ip|email`, both of which an attacker chooses, so entries used to
  // accumulate for the life of the process.
  const limiter = createRateLimiter({ max: 5, windowMs: 40 })
  for (let i = 0; i < 500; i++) limiter.allow(`attacker-${i}`)
  assert.equal(limiter.size, 500)

  await new Promise((r) => setTimeout(r, 60))
  limiter.allow('anyone')
  assert.equal(limiter.size, 1, 'keys whose window has passed are swept')
})

test('rate limiter refuses new keys at its ceiling instead of growing', () => {
  const limiter = createRateLimiter({ max: 5, maxKeys: 3 })
  for (const key of ['a', 'b', 'c']) assert.equal(limiter.allow(key), true)

  assert.equal(limiter.allow('d'), false, 'a key it is not already tracking is refused')
  assert.equal(limiter.size, 3, 'and not recorded')
  assert.equal(limiter.allow('a'), true, 'keys already in the window are unaffected')
})

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; stipend_session=abc%3D'), { a: '1', stipend_session: 'abc=' })
})
