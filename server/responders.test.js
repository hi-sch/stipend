import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './db/testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './db/pool.js'
import { patchProgramSettings } from './db/meta.js'
import { decideThreeDs, decideTokenization } from './responders.js'

// Deliberately not process.env.DATABASE_URL: before() points this at a database of this
// file's own. Leaving it unset until then means a failure to create that database is a
// loud error here, instead of this file quietly writing into a development database.
let url = null
const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set'

// This file writes, so it works in a database of its own rather than in whatever
// DATABASE_URL points at, which is usually somebody’s development database.
let ownDatabase = null
before(async () => {
  if (skip) return
  ownDatabase = await createTestDatabase('responders')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

/**
 * A cardholder with one envelope covering groceries, and a challenge threshold of 30 EUR.
 * The responder policy is program-wide, so it is set and restored around each test.
 */
async function withWorld(fn) {
  const db = createPool({ url, max: 4, applicationName: 'stipend-responders-test' })
  const run = randomUUID().slice(0, 8)
  const f = { run, holderId: `ch_${run}`, connectionId: `cx_${run}`, envelopeId: `env_${run}`, card: randomUUID() }

  const before = await db.query(`SELECT value FROM program_meta WHERE key = 'settings'`)

  try {
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO cardholders (id, first_name, last_name, email, phone, card)
         VALUES ($1,'A','Holder',$2,'+49 30 555 0142',$3::jsonb)`,
        [f.holderId, `${run}@example.test`, JSON.stringify({ token: f.card, state: 'OPEN' })],
      )
      await c.query(`INSERT INTO connections (id, name, protocol, mccs, countries) VALUES ($1,'Food','json','{5411}','{DEU}')`, [f.connectionId])
      await c.query(
        `INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name, balance_cents, mccs, countries, received_at)
         VALUES ($1,$2,$3,'Food',5000,'{5411}','{DEU}',now())`,
        [f.envelopeId, f.holderId, f.connectionId],
      )
      await patchProgramSettings(c, { responders: { threeDsChallengeAboveCents: 3000 } })
    })

    await fn(db, f)
  } finally {
    await db.query('DELETE FROM cardholders WHERE id = $1', [f.holderId]).catch(() => {})
    await db.query('DELETE FROM connections WHERE id = $1', [f.connectionId]).catch(() => {})
    // Leave the program's responder policy as it was found.
    await db
      .query(
        `INSERT INTO program_meta (key, value) VALUES ('settings', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(before.rows[0]?.value ?? {})],
      )
      .catch(() => {})
    await db.end()
  }
}

const decisions = async (db, f) => {
  const { rows } = await db.query(`SELECT * FROM responder_log WHERE request ->> 'holderId' = $1 OR request ->> 'holderId' IS NULL ORDER BY at`, [f.holderId])
  return rows
}

test('3DS: approve covered merchants, challenge large amounts, decline uncovered or unknown cards', { skip }, async () => {
  await withWorld(async (db, f) => {
    const decide = (request) => db.tx((c) => decideThreeDs(c, request))

    const covered = await decide({ card_token: f.card, merchant: { mcc: '5411' }, transaction: { amount: 1000 } })
    assert.equal(covered.three_ds_authentication_decision, 'APPROVE')

    const large = await decide({ card_token: f.card, merchant: { mcc: '5411' }, transaction: { amount: 4000 } })
    assert.equal(large.three_ds_authentication_decision, 'CHALLENGE_REQUESTED')

    const uncovered = await decide({ card_token: f.card, merchant: { mcc: '7995' }, transaction: { amount: 100 } })
    assert.equal(uncovered.three_ds_authentication_decision, 'DECLINE')

    const unknown = await decide({ card_token: randomUUID(), merchant: { mcc: '5411' }, transaction: { amount: 100 } })
    assert.equal(unknown.three_ds_authentication_decision, 'DECLINE')

    const logged = (await decisions(db, f)).filter((r) => r.kind === '3ds')
    assert.ok(logged.length >= 3, 'every decision is written to the responder log')
  })
})

test('3DS: non-payment authentication is approved without checking envelopes', { skip }, async () => {
  await withWorld(async (db, f) => {
    const res = await db.tx((c) =>
      decideThreeDs(c, { card_token: f.card, merchant: { mcc: '7995' }, transaction: { amount: 100000 }, message_category: 'NON_PAYMENT_AUTHENTICATION' }),
    )
    assert.equal(res.three_ds_authentication_decision, 'APPROVE')
  })
})

test('3DS: a frozen card is declined whatever the merchant', { skip }, async () => {
  await withWorld(async (db, f) => {
    await db.query(`UPDATE cardholders SET card = card || '{"state":"PAUSED"}'::jsonb WHERE id = $1`, [f.holderId])
    const res = await db.tx((c) => decideThreeDs(c, { card_token: f.card, merchant: { mcc: '5411' }, transaction: { amount: 100 } }))
    assert.equal(res.three_ds_authentication_decision, 'DECLINE')
  })
})

test('tokenization: follows wallet recommendation and blocks paused cards', { skip }, async () => {
  await withWorld(async (db, f) => {
    const decide = (request) => db.tx((c) => decideTokenization(c, request))

    const approved = await decide({ card_token: f.card, wallet_decisioning_info: { recommended_decision: 'APPROVED' } })
    assert.equal(approved.tokenization_decision, 'APPROVE')

    const stepUp = await decide({ card_token: f.card, wallet_decisioning_info: { recommended_decision: 'REQUIRE_ADDITIONAL_AUTHENTICATION' } })
    assert.equal(stepUp.tokenization_decision, 'AUTHENTICATE')

    const declined = await decide({ card_token: f.card, wallet_decisioning_info: { recommended_decision: 'DECLINED' } })
    assert.equal(declined.tokenization_decision, 'DECLINE')

    await db.query(`UPDATE cardholders SET card = card || '{"state":"PAUSED"}'::jsonb WHERE id = $1`, [f.holderId])
    const paused = await decide({ card_token: f.card })

    assert.equal(paused.tokenization_decision, 'DECLINE')
    assert.equal(paused.email, `${f.run}@example.test`)
    assert.equal(paused.phone_number, '+49305550142')
  })
})

test('tokenization: an unknown card is declined and still answers with contact details', { skip }, async () => {
  await withWorld(async (db) => {
    const res = await db.tx((c) => decideTokenization(c, { card_token: randomUUID() }))
    assert.equal(res.tokenization_decision, 'DECLINE')
    assert.equal(res.email, 'support@stipend.local')
    assert.equal(res.mobile_application_name, 'Stipend')
  })
})

test('the responder policy comes from program settings', { skip }, async () => {
  await withWorld(async (db, f) => {
    // Raising the threshold turns what was a challenge into an approval.
    await db.tx((c) => patchProgramSettings(c, { responders: { threeDsChallengeAboveCents: 100000 } }))
    const res = await db.tx((c) => decideThreeDs(c, { card_token: f.card, merchant: { mcc: '5411' }, transaction: { amount: 4000 } }))
    assert.equal(res.three_ds_authentication_decision, 'APPROVE')
  })
})
