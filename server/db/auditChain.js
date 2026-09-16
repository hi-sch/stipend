import { createHash } from 'node:crypto'

/**
 * Tamper-evident audit log.
 *
 * Each entry commits to the entry before it, so an edited or deleted row breaks the chain
 * at that point and the verifier can name it. The database also refuses UPDATE and DELETE
 * on the table; this is the second lock, the one that still works if someone reaches the
 * data through another path (a restored backup, a direct psql session, a replica).
 */

// The hash the first entry links to.
export const GENESIS = '0'.repeat(64)

/**
 * Canonical form of an entry. Field order is fixed here rather than taken from object key
 * order, so two processes hash the same entry identically and a JSON round trip cannot
 * change the result.
 */
function canonical(entry, prevHash) {
  return JSON.stringify([
    prevHash,
    entry.at,
    entry.actor ?? 'system',
    entry.action,
    entry.target ?? null,
    entry.outcome ?? 'ok',
    entry.details === undefined || entry.details === null ? null : stableJson(entry.details),
    entry.ip ?? null,
  ])
}

/** Stable JSON for the details blob: objects get sorted keys at every depth. */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

/** Hash of one entry given the hash of the previous one. */
export function auditHash(entry, prevHash = GENESIS) {
  return createHash('sha256').update(canonical(entry, prevHash)).digest('hex')
}

/**
 * Walk a chain in insertion order and report the first entry that does not verify.
 *
 * Returns `{ ok, checked, brokenAt, reason }`. `brokenAt` is the id of the first bad
 * entry: either its stored hash does not match its contents, or its prev_hash does not
 * match the entry before it — which is what a deleted row looks like from here.
 */
export function verifyChain(rows, { startHash = GENESIS } = {}) {
  let prev = startHash
  let checked = 0

  for (const row of rows) {
    if ((row.prev_hash ?? GENESIS) !== prev) {
      return { ok: false, checked, brokenAt: row.id, reason: 'prev_hash does not match the previous entry' }
    }
    const expected = auditHash(
      { at: row.at, actor: row.actor, action: row.action, target: row.target, outcome: row.outcome, details: row.details, ip: row.ip },
      prev,
    )
    if (expected !== row.hash) {
      return { ok: false, checked, brokenAt: row.id, reason: 'entry contents do not match its hash' }
    }
    prev = row.hash
    checked += 1
  }

  return { ok: true, checked, brokenAt: null, reason: null }
}
