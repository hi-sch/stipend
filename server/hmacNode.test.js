import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { signBody, verifyHmac, verifyLithicWebhook } from './hmacNode.js'

test('HMAC round-trip', () => {
  const body = '{"amount":15000}'
  const sig = signBody('secret', body)
  assert.equal(verifyHmac('secret', body, `sha256=${sig}`), true)
  assert.equal(verifyHmac('secret', body, sig), true)
  assert.equal(verifyHmac('secret', body, 'deadbeef'), false)
  assert.equal(verifyHmac('other', body, sig), false)
  assert.equal(verifyHmac(undefined, body, sig), false)
  assert.equal(verifyHmac('secret', body, 'not-hex'), false)
})

test('Lithic Events API webhook signature', () => {
  const rawKey = Buffer.from('supersecret')
  const secret = `whsec_${rawKey.toString('base64')}`
  const id = 'msg_1'
  const ts = '1710000000'
  const body = '{"event_type":"card_transaction.updated"}'
  const digest = createHmac('sha256', rawKey).update(`${id}.${ts}.${body}`).digest('base64')
  const headers = {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${digest}`,
  }
  const at = { now: 1710000000 }
  assert.equal(verifyLithicWebhook(secret, body, headers, at).ok, true)
  assert.equal(verifyLithicWebhook(secret, body, { ...headers, 'webhook-signature': 'v1,aaaa' }, at).ok, false)
  assert.equal(verifyLithicWebhook(secret, body, {}, at).ok, false)
  assert.equal(verifyLithicWebhook('', body, headers, at).ok, false)
  assert.equal(verifyLithicWebhook(secret, body, headers, { now: 1710000000 + 3600 }).reason, 'stale-timestamp')
})
