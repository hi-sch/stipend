import { GENESIS, auditHash, verifyChain } from './auditChain.js'

/**
 * Append-only audit log.
 *
 * Each entry commits to the hash of the entry before it. Appends take a transaction-level
 * advisory lock: without it two concurrent writers would read the same tip hash and write
 * two entries claiming the same predecessor, which forks the chain and makes the whole log
 * unverifiable from that point on. The lock is held only for the insert.
 *
 * The table also refuses UPDATE and DELETE outright (migration 001), so the chain is the
 * second line of defence, not the only one.
 */

const APPEND_LOCK = 902431

export async function appendAudit(db, entry) {
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK])

    const { rows } = await c.query('SELECT hash FROM audit ORDER BY id DESC LIMIT 1')
    const prev = rows[0]?.hash ?? GENESIS

    const row = {
      at: entry.at || new Date().toISOString(),
      actor: entry.actor || 'system',
      action: entry.action,
      target: entry.target ?? null,
      outcome: entry.outcome || 'ok',
      details: entry.details ?? null,
      ip: entry.ip ?? null,
    }

    const hash = auditHash(row, prev)
    await c.query(
      `INSERT INTO audit (at, actor, action, target, outcome, details, ip, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [row.at, row.actor, row.action, row.target, row.outcome, row.details === null ? null : JSON.stringify(row.details), row.ip, prev, hash],
    )

    return { ...row, hash, prevHash: prev }
  })
}

export async function auditList(db, { limit = 100, before, actor, action } = {}) {
  const where = []
  const args = []

  if (before) {
    args.push(Number(before))
    where.push(`id < $${args.length}`)
  }
  if (actor) {
    args.push(actor)
    where.push(`actor = $${args.length}`)
  }
  if (action) {
    args.push(`%${action}%`)
    where.push(`action LIKE $${args.length}`)
  }

  args.push(Math.min(500, Math.max(1, Number(limit) || 100)))

  const { rows } = await db.query(
    `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${args.length}`,
    args,
  )
  return rows
}

/**
 * Walk the chain from the beginning and report the first entry that does not verify.
 *
 * Reads in batches rather than loading the whole log: this runs on a table that only ever
 * grows, and an operator asking "is the audit log intact" should not be able to exhaust
 * the server's memory by asking.
 */
export async function verifyAuditChain(db, { batchSize = 1000, fromId = null } = {}) {
  let afterId = 0
  let checked = 0
  let prev = GENESIS

  // Verify a segment rather than the whole log. The table only grows, so an operator who
  // verified up to a known entry can carry on from there instead of re-reading everything.
  // The segment is seeded with the hash of the entry immediately before it, so a break at
  // the boundary is still caught.
  if (fromId) {
    const { rows } = await db.query('SELECT id, hash FROM audit WHERE id < $1 ORDER BY id DESC LIMIT 1', [fromId])
    if (rows.length) {
      prev = rows[0].hash
      afterId = rows[0].id
    } else {
      afterId = Number(fromId) - 1
    }
  }

  for (;;) {
    const { rows } = await db.query('SELECT * FROM audit WHERE id > $1 ORDER BY id LIMIT $2', [afterId, batchSize])
    if (!rows.length) break

    // The chain continues across batches, so verification resumes from the previous
    // batch's last hash rather than restarting at the genesis value.
    const result = verifyChain(rows, { startHash: prev })
    if (!result.ok) return { ...result, checked: checked + result.checked }

    checked += rows.length
    prev = rows[rows.length - 1].hash
    afterId = rows[rows.length - 1].id
  }

  return { ok: true, checked, brokenAt: null, reason: null }
}
