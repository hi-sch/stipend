import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GENESIS, auditHash, verifyChain } from './auditChain.js'

/** Build a chained run of entries the way the audit writer does. */
function chain(entries) {
  let prev = GENESIS
  return entries.map((entry, index) => {
    const row = { id: index + 1, outcome: 'ok', actor: 'ops@stipend.demo', target: null, details: null, ip: null, ...entry, prev_hash: prev }
    row.hash = auditHash(row, prev)
    prev = row.hash
    return row
  })
}

const sample = () =>
  chain([
    { at: '2026-09-16T10:00:00.000Z', action: 'auth.login' },
    { at: '2026-09-16T10:01:00.000Z', action: 'connection.create', target: 'de-jobcenter', details: { name: 'Jobcenter' } },
    { at: '2026-09-16T10:02:00.000Z', action: 'cash.rule.update', target: 'cash_100_month', details: { limitCents: 10000 } },
  ])

test('an untouched chain verifies', () => {
  const result = verifyChain(sample())
  assert.equal(result.ok, true)
  assert.equal(result.checked, 3)
  assert.equal(result.brokenAt, null)
})

test('an empty log verifies', () => {
  assert.deepEqual(verifyChain([]), { ok: true, checked: 0, brokenAt: null, reason: null })
})

test('editing an entry breaks the chain at that entry', () => {
  const rows = sample()
  rows[1].actor = 'someone.else@stipend.demo'

  const result = verifyChain(rows)
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 2)
  assert.match(result.reason, /do not match its hash/)
})

test('editing the details blob breaks the chain', () => {
  const rows = sample()
  rows[2].details = { limitCents: 999999 }

  const result = verifyChain(rows)
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 3)
})

test('deleting an entry breaks the link of the one after it', () => {
  const rows = sample()
  const without = [rows[0], rows[2]]

  const result = verifyChain(without)
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 3)
  assert.match(result.reason, /prev_hash/)
})

test('reordering entries breaks the chain', () => {
  const [first, second, third] = sample()
  const result = verifyChain([first, third, second])
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 3)
})

test('details hash independently of key order', () => {
  const at = '2026-09-16T10:00:00.000Z'
  const a = auditHash({ at, action: 'settings.update', details: { a: 1, b: { c: 2, d: 3 } } }, GENESIS)
  const b = auditHash({ at, action: 'settings.update', details: { b: { d: 3, c: 2 }, a: 1 } }, GENESIS)
  assert.equal(a, b)
})

test('a different previous hash yields a different entry hash', () => {
  const entry = { at: '2026-09-16T10:00:00.000Z', action: 'auth.login' }
  assert.notEqual(auditHash(entry, GENESIS), auditHash(entry, 'a'.repeat(64)))
})
