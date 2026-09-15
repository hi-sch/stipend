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

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; stipend_session=abc%3D'), { a: '1', stipend_session: 'abc=' })
})
