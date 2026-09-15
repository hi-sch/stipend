import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideThreeDs, decideTokenization } from './responders.js'

const CARD = '11111111-1111-4111-8111-111111111111'
const state = () => ({
  cardholders: [{ id: 'ch_a', email: 'a@example.test', phone: '+49 30 555 0142', card: { token: CARD, state: 'OPEN' } }],
  envelopes: [{ id: 'env', cardholderId: 'ch_a', balanceCents: 5000, mccs: ['5411'], countries: ['DEU'], receivedAt: '2026-01-01T00:00:00Z' }],
  notifications: [],
  settings: { responders: { threeDsChallengeAboveCents: 3000 } },
})

test('3DS: approve covered merchants, challenge large amounts, decline uncovered or unknown cards', () => {
  const s = state()
  assert.equal(decideThreeDs(s, { card_token: CARD, merchant: { mcc: '5411' }, transaction: { amount: 1000 } }).three_ds_authentication_decision, 'APPROVE')
  assert.equal(decideThreeDs(s, { card_token: CARD, merchant: { mcc: '5411' }, transaction: { amount: 4000 } }).three_ds_authentication_decision, 'CHALLENGE_REQUESTED')
  assert.equal(decideThreeDs(s, { card_token: CARD, merchant: { mcc: '7995' }, transaction: { amount: 100 } }).three_ds_authentication_decision, 'DECLINE')
  assert.equal(decideThreeDs(s, { card_token: 'other', merchant: { mcc: '5411' }, transaction: { amount: 100 } }).three_ds_authentication_decision, 'DECLINE')
  assert.equal(s.responderLog.length, 4)
})

test('tokenization: follows wallet recommendation and blocks paused cards', () => {
  const s = state()
  assert.equal(decideTokenization(s, { card_token: CARD, wallet_decisioning_info: { recommended_decision: 'APPROVED' } }).tokenization_decision, 'APPROVE')
  assert.equal(decideTokenization(s, { card_token: CARD, wallet_decisioning_info: { recommended_decision: 'REQUIRE_ADDITIONAL_AUTHENTICATION' } }).tokenization_decision, 'AUTHENTICATE')
  s.cardholders[0].card.state = 'PAUSED'
  const res = decideTokenization(s, { card_token: CARD })
  assert.equal(res.tokenization_decision, 'DECLINE')
  assert.equal(res.email, 'a@example.test')
  assert.equal(res.phone_number, '+49305550142')
})
