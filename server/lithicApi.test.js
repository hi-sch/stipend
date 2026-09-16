import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLithic, isUuid, LithicError, qs } from './lithicApi.js'

/**
 * Every call to the card network goes through this client: its retry, its backoff and its
 * idempotency keys decide what happens when Lithic is slow, rate limiting, or returning an
 * error in the middle of a card issue. None of it was covered.
 */

/** A fetch that answers from a script of responses and records what it was asked. */
function fakeFetch(script) {
  const calls = []
  const responses = Array.isArray(script) ? [...script] : [script]

  const impl = async (url, options) => {
    calls.push({ url, options, headers: options?.headers ?? {} })
    const next = responses.length > 1 ? responses.shift() : responses[0]
    if (next instanceof Error) throw next

    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (h) => next.headers?.[h.toLowerCase()] ?? null },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    }
  }
  return { impl, calls }
}

const slept = []
const noSleep = async (ms) => {
  slept.push(ms)
}
const client = (script, extra = {}) => {
  const f = fakeFetch(script)
  return { lithic: createLithic({ apiKey: 'test-key', fetchImpl: f.impl, sleepImpl: noSleep, ...extra }), calls: f.calls }
}

test('a request carries the key, and a body only when there is one', async () => {
  const { lithic, calls } = client({ status: 200, body: { token: 'abc' } })

  await lithic.get('/v1/cards')
  assert.equal(calls[0].url, 'https://sandbox.lithic.com/v1/cards')
  assert.equal(calls[0].headers.Authorization, 'test-key')
  assert.equal(calls[0].headers['Content-Type'], undefined, 'a GET sends no content type')

  await lithic.post('/v1/cards', { type: 'VIRTUAL' })
  assert.equal(calls[1].headers['Content-Type'], 'application/json')
  assert.equal(calls[1].options.body, JSON.stringify({ type: 'VIRTUAL' }))
})

test('an idempotency key is sent only when given', async () => {
  const { lithic, calls } = client({ status: 200, body: {} })

  await lithic.post('/v1/cards', { a: 1 })
  assert.equal(calls[0].headers['Idempotency-Key'], undefined)

  await lithic.post('/v1/cards', { a: 1 }, { idempotencyKey: 'key-1' })
  assert.equal(calls[1].headers['Idempotency-Key'], 'key-1', 'a retried card issue must not create a second card')
})

test('production and sandbox are different origins', () => {
  assert.equal(createLithic({ apiKey: 'k' }).origin, 'https://sandbox.lithic.com')
  assert.equal(createLithic({ apiKey: 'k', environment: 'production' }).origin, 'https://api.lithic.com')
})

test('without a key nothing is sent and the error says why', async () => {
  const f = fakeFetch({ status: 200, body: {} })
  const lithic = createLithic({ apiKey: '', fetchImpl: f.impl })

  assert.equal(lithic.configured, false)
  await assert.rejects(() => lithic.get('/v1/cards'), (err) => err instanceof LithicError && err.status === 503 && /LITHIC_API_KEY/.test(err.message))
  assert.equal(f.calls.length, 0, 'it does not reach the network')
})

test('an error carries the status and the payload Lithic sent', async () => {
  const { lithic } = client({ status: 422, body: { message: 'Card is closed', debugging_request_id: 'req_1' } })

  await assert.rejects(
    () => lithic.post('/v1/cards', {}),
    (err) => err instanceof LithicError && err.status === 422 && err.message === 'Card is closed' && err.payload.debugging_request_id === 'req_1',
  )
})

test('a body that is not JSON still produces a usable error', async () => {
  const { lithic } = client({ status: 502, body: '<html>Bad Gateway</html>' })
  await assert.rejects(() => lithic.get('/v1/cards'), (err) => err.status === 502 && /Bad Gateway/.test(err.message))
})

test('an error with no message at all still names the status', async () => {
  const { lithic } = client({ status: 500, body: {} })
  await assert.rejects(() => lithic.get('/v1/cards'), (err) => err.message === 'Lithic 500')
})

test('a rate limit is retried, and the wait comes from Retry-After', async () => {
  slept.length = 0
  const { lithic, calls } = client([
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 200, body: { ok: true } },
  ])

  assert.deepEqual(await lithic.get('/v1/cards'), { ok: true })
  assert.equal(calls.length, 2, 'it tried again')
  assert.deepEqual(slept, [2000])
})

test('a Retry-After below a second still waits a second', async () => {
  slept.length = 0
  const { lithic } = client([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: {} }])

  await lithic.get('/v1/cards')
  assert.deepEqual(slept, [1000], 'never retry faster than once a second')
})

test('a Retry-After given as a date is honoured, not treated as zero', async () => {
  slept.length = 0
  const when = new Date(Date.now() + 5000).toUTCString()
  const { lithic } = client([{ status: 429, headers: { 'retry-after': when } }, { status: 200, body: {} }])

  await lithic.get('/v1/cards')
  assert.equal(slept.length, 1)
  assert.ok(slept[0] >= 1000 && slept[0] <= 60_000, `waited ${slept[0]}ms`)
  // Number() on a date is NaN and setTimeout(NaN) fires at once, which would retry straight
  // back into the rate limit.
  assert.ok(!Number.isNaN(slept[0]), 'the wait is a real number')
})

test('a missing Retry-After falls back to a second', async () => {
  slept.length = 0
  const { lithic } = client([{ status: 429 }, { status: 200, body: {} }])
  await lithic.get('/v1/cards')
  assert.deepEqual(slept, [1000])
})

test('it gives up rather than retrying a rate limit for ever', async () => {
  slept.length = 0
  const { lithic, calls } = client({ status: 429, headers: { 'retry-after': '1' } })

  await assert.rejects(() => lithic.get('/v1/cards'), (err) => err instanceof LithicError && err.status === 429 && /too many retries/.test(err.message))
  assert.equal(calls.length, 6, 'six attempts, then it stops')
})

test('requests run one at a time', async () => {
  // Auth rules are created, drafted and promoted in order; overlapping requests would
  // promote a draft that had not been written yet.
  const order = []
  let release
  const gate = new Promise((r) => {
    release = r
  })

  const impl = async (url) => {
    order.push(`start ${url.slice(-1)}`)
    if (url.endsWith('1')) await gate
    order.push(`end ${url.slice(-1)}`)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }
  }

  const lithic = createLithic({ apiKey: 'k', fetchImpl: impl, sleepImpl: noSleep })
  const first = lithic.get('/1')
  const second = lithic.get('/2')

  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, ['start 1'], 'the second request has not begun')

  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2'])
})

test('one failure does not wedge the queue behind it', async () => {
  const { lithic } = client([{ status: 500, body: { message: 'boom' } }, { status: 200, body: { ok: true } }])

  await assert.rejects(() => lithic.get('/v1/first'))
  assert.deepEqual(await lithic.get('/v1/second'), { ok: true }, 'the next request still runs')
})

test('a network error reaches the caller', async () => {
  const { lithic } = client(new Error('socket hang up'))
  await assert.rejects(() => lithic.get('/v1/cards'), /socket hang up/)
})

test('query strings drop what is not set', () => {
  assert.equal(qs({ a: 1, b: 'two' }), '?a=1&b=two')
  assert.equal(qs({ a: undefined, b: null, c: '' }), '', 'nothing set means no query string at all')
  assert.equal(qs({ a: 0, b: false }), '?a=0&b=false', 'zero and false are values')
  assert.equal(qs({ q: 'a b&c' }), '?q=a+b%26c', 'values are escaped')
})

test('UUID recognition', () => {
  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'.toUpperCase()), true)
  assert.equal(isUuid('card_7b9e7666'), false, 'a local identifier is not a Lithic token')
  assert.equal(isUuid(''), false)
  assert.equal(isUuid(null), false)
  assert.equal(isUuid(undefined), false)
})
