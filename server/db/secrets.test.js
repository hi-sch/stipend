import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSecretBox } from './secrets.js'

const KEY = 'a-development-passphrase-long-enough'
const box = (extra = {}) => createSecretBox({ env: { STIPEND_SECRET_KEY: KEY, ...extra }, log: { warn() {} } })

test('a sealed value round trips', () => {
  const b = box()
  const secret = 'whk_2f1a8c9e4d7b6a5c3e2f1a8c'

  const stored = b.seal(secret)
  assert.notEqual(stored, secret, 'the stored form is not the secret')
  assert.ok(stored.startsWith('enc.v1.'))
  assert.equal(b.open(stored), secret)
})

test('the same secret seals differently every time', () => {
  const b = box()
  // A fresh nonce each time: two connections sharing a secret must not look identical in
  // the database, and neither must two writes of the same value.
  assert.notEqual(b.seal('same'), b.seal('same'))
  assert.equal(b.open(b.seal('same')), 'same')
})

test('a tampered value is refused, not quietly decrypted', () => {
  const b = box()
  const stored = b.seal('whk_original')
  const [prefix, iv, tag, body] = [stored.slice(0, 7), ...stored.slice(7).split('.')]

  // Flip the last character of the ciphertext.
  const flipped = body.slice(0, -1) + (body.at(-1) === 'A' ? 'B' : 'A')
  assert.throws(() => b.open(`${prefix}${iv}.${tag}.${flipped}`))

  // And a swapped authentication tag.
  const otherTag = b.seal('whk_other').slice(7).split('.')[1]
  assert.throws(() => b.open(`${prefix}${iv}.${otherTag}.${body}`))
})

test('a malformed value is refused', () => {
  const b = box()
  assert.throws(() => b.open('enc.v1.only-one-part'), /malformed/)
})

test('values written before a key existed still open', () => {
  const b = box()
  // Not sealed, so it is returned as it is. This is what makes turning the key on a
  // non-event for rows already in the database.
  assert.equal(b.open('whk_written_in_clear'), 'whk_written_in_clear')
  assert.equal(b.isSealed('whk_written_in_clear'), false)
})

test('without a key the program still runs and says so', () => {
  const b = createSecretBox({ env: {}, log: { warn() {} } })
  assert.equal(b.configured, false)
  assert.equal(b.seal('whk_plain'), 'whk_plain', 'values pass through rather than the server refusing to start')
  assert.equal(b.open('whk_plain'), 'whk_plain')
})

test('a key too short to be worth anything is refused, loudly', () => {
  const warnings = []
  const b = createSecretBox({ env: { STIPEND_SECRET_KEY: 'short' }, log: { warn: (m) => warnings.push(m) } })

  assert.equal(b.configured, false, 'a weak key is not treated as encryption')
  assert.match(warnings[0], /too short/)
})

test('an encrypted value cannot be opened without the key', () => {
  const sealed = box().seal('whk_secret')
  const keyless = createSecretBox({ env: {}, log: { warn() {} } })
  assert.throws(() => keyless.open(sealed), /STIPEND_SECRET_KEY is not set/)
})

test('a different key cannot open it either', () => {
  const sealed = box().seal('whk_secret')
  const other = createSecretBox({ env: { STIPEND_SECRET_KEY: 'a-completely-different-passphrase' }, log: { warn() {} } })
  assert.throws(() => other.open(sealed))
})

test('empty and absent values are left alone', () => {
  const b = box()
  for (const value of ['', null, undefined]) {
    assert.equal(b.seal(value), value)
    assert.equal(b.open(value), value)
  }
})

test('sealing twice does not double seal', () => {
  const b = box()
  const once = b.seal('whk_secret')
  assert.equal(b.seal(once), once)
  assert.equal(b.open(b.seal(once)), 'whk_secret')
})

test('secrets are compared in constant time', () => {
  const b = box()
  assert.equal(b.matches('whk_abc', 'whk_abc'), true)
  assert.equal(b.matches('whk_abc', 'whk_abd'), false)
  assert.equal(b.matches('whk_abc', 'whk_abcd'), false, 'different lengths are not equal')
  assert.equal(b.matches(null, undefined), true, 'both absent')
})
