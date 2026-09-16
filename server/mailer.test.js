import { test, before, after } from 'node:test'
import { createTestDatabase, dropTestDatabase } from './db/testDatabase.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPool } from './db/pool.js'
import { createMailer, deliverOutbox, requeueStuck } from './mailer.js'

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
  ownDatabase = await createTestDatabase('mailer')
  url = ownDatabase.url
})
after(async () => {
  if (ownDatabase) await dropTestDatabase(ownDatabase.name)
})

/** A mailer that records what it was asked to send, and can be made to fail. */
function recorder({ fail = false } = {}) {
  const sent = []
  return {
    sent,
    configured: true,
    async send(mail) {
      if (fail) throw new Error('smtp refused')
      sent.push(mail)
    },
  }
}

async function withOutbox(fn) {
  const db = createPool({ url, max: 6, applicationName: 'stipend-mailer-test' })
  const run = randomUUID().slice(0, 8)
  try {
    await fn(db, run)
  } finally {
    await db.query('DELETE FROM email_outbox').catch(() => {})
    await db.end()
  }
}

/**
 * Queue a message, with its times measured by the database's own clock.
 *
 * Deliberately not `new Date()`: the claim filters on `next_attempt_at <= now()`, which is
 * the database's now. Postgres here runs a millisecond or so behind this process, so a row
 * stamped with the local clock is briefly in the future as far as the claim is concerned, and
 * a test that delivers immediately after queueing finds nothing. It fails whichever test
 * happens to be quickest, which is what made this file look like a concurrency problem.
 *
 * `dueInMs` and `createdMsAgo` are offsets from that same clock, so both sides agree.
 */
const queue = (db, run, overrides = {}) =>
  db.query(
    `INSERT INTO email_outbox (id, to_address, subject, body, kind, status, next_attempt_at, created_at, attempts)
     VALUES ($1,$2,$3,'body','credit',$4,
             now() + ($5 || ' milliseconds')::interval,
             now() - ($6 || ' milliseconds')::interval,
             $7)`,
    [
      overrides.id ?? `mail_${randomUUID().slice(0, 8)}`,
      overrides.to ?? `${run}@example.test`,
      overrides.subject ?? 'Jobcenter credited',
      overrides.status ?? 'QUEUED',
      String(overrides.dueInMs ?? 0),
      String(overrides.createdMsAgo ?? 0),
      overrides.attempts ?? 0,
    ],
  )

const statuses = async (db) => (await db.query('SELECT id, status, attempts, last_error, next_attempt_at FROM email_outbox ORDER BY created_at')).rows

test('without SMTP nothing is sent and nothing is claimed', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run)
    const result = await deliverOutbox({ db, mailer: { configured: false, send: async () => {} } })

    assert.deepEqual(result, { sent: 0, failed: 0 })
    assert.equal((await statuses(db))[0].status, 'QUEUED', 'mail waits rather than being lost')
  })
})

test('queued mail is sent and marked', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run, { subject: 'Wohngeld credited' })
    const mailer = recorder()

    const result = await deliverOutbox({ db, mailer, publicUrl: 'https://stipend.example.org' })
    assert.equal(result.sent, 1)
    assert.equal(mailer.sent[0].subject, 'Wohngeld credited')
    assert.match(mailer.sent[0].text, /https:\/\/stipend\.example\.org/, 'the public URL is appended')

    const [row] = await statuses(db)
    assert.equal(row.status, 'SENT')
    assert.equal(row.last_error, null)
  })
})

test('mail that is not yet due is left alone', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run, { dueInMs: 3600_000 })
    const mailer = recorder()

    assert.equal((await deliverOutbox({ db, mailer })).sent, 0)
    assert.equal(mailer.sent.length, 0)
    assert.equal((await statuses(db))[0].status, 'QUEUED')
  })
})

test('a failure backs off and stays queued', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run)
    const result = await deliverOutbox({ db, mailer: recorder({ fail: true }), log: { warn() {} } })

    assert.equal(result.failed, 1)
    const [row] = await statuses(db)
    assert.equal(row.status, 'QUEUED', 'it will be tried again')
    assert.equal(row.attempts, 1)
    assert.equal(row.last_error, 'smtp refused')
    assert.ok(new Date(row.next_attempt_at) > new Date(), 'and not immediately')
  })
})

test('mail gives up after enough attempts', { skip }, async () => {
  await withOutbox(async (db, run) => {
    // One attempt short of the limit; this delivery is the last one.
    await queue(db, run, { attempts: 4 })
    await deliverOutbox({ db, mailer: recorder({ fail: true }), log: { warn() {} } })

    const [row] = await statuses(db)
    assert.equal(row.status, 'FAILED')
    assert.equal(row.attempts, 5)
  })
})

test('mail nobody could deliver for a day expires', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run, { createdMsAgo: 25 * 3600_000 })
    const mailer = recorder()

    await deliverOutbox({ db, mailer })
    assert.equal(mailer.sent.length, 0, 'it is not sent')
    assert.equal((await statuses(db))[0].status, 'EXPIRED')
  })
})

test('two deliverers do not send the same message twice', { skip }, async () => {
  await withOutbox(async (db, run) => {
    for (let i = 0; i < 6; i++) await queue(db, run, { subject: `Message ${i}` })

    // Both run at once, as two replicas would. Claiming uses FOR UPDATE SKIP LOCKED, so a
    // message belongs to whichever of them got there first.
    const a = recorder()
    const b = recorder()
    await Promise.all([deliverOutbox({ db, mailer: a }), deliverOutbox({ db, mailer: b })])

    // What has to hold is that nobody sent the same message as the other. How the six are
    // divided, and whether one pass drains the queue at all, is not something the design
    // promises — a claim that loses its race simply finds nothing and the next pass picks it
    // up. Asserting a particular split here made this test fail under load for a reason that
    // was never a defect.
    const subjects = [...a.sent, ...b.sent].map((m) => m.subject)
    assert.equal(new Set(subjects).size, subjects.length, 'no message was sent by both of them')

    // Anything left behind is delivered by the next pass, which is the guarantee that
    // matters: the queue drains, and nothing is sent twice getting there.
    const sweeper = recorder()
    await deliverOutbox({ db, mailer: sweeper })
    const all = [...subjects, ...sweeper.sent.map((m) => m.subject)]
    assert.equal(new Set(all).size, 6, 'all six messages were sent, none of them twice')
    assert.deepEqual((await statuses(db)).filter((r) => r.status !== 'SENT'), [])
  })
})

test('mail claimed by a process that died is returned to the queue', { skip }, async () => {
  await withOutbox(async (db, run) => {
    // What a pod killed mid-send leaves behind.
    await queue(db, run, { status: 'SENDING', createdMsAgo: 600_000 })

    const requeued = await requeueStuck({ db, olderThanMs: 60_000 })
    assert.equal(requeued.length, 1)
    assert.equal((await statuses(db))[0].status, 'QUEUED')

    const mailer = recorder()
    assert.equal((await deliverOutbox({ db, mailer })).sent, 1, 'and it goes out on the next pass')
  })
})

test('recently claimed mail is left alone by the sweep', { skip }, async () => {
  await withOutbox(async (db, run) => {
    await queue(db, run, { status: 'SENDING' })
    assert.deepEqual(await requeueStuck({ db, olderThanMs: 60_000 }), [], 'another process may still be sending it')
  })
})

test('a mailer is only configured when SMTP_URL is set', () => {
  assert.equal(createMailer({}).configured, false)
  assert.equal(createMailer({ SMTP_URL: 'smtps://user:pass@smtp.example.org:465' }).configured, true)
})

test('an unconfigured mailer refuses rather than pretending', async () => {
  await assert.rejects(() => createMailer({}).send({ to: 'x@example.test' }), /SMTP_URL is not configured/)
})
