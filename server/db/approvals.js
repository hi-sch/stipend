import { randomUUID } from 'node:crypto'

/**
 * Maker-checker for sensitive operator writes.
 *
 * Some actions move money, change who may take cash, or remove a cardholder. Those are
 * parked as a request and take effect only when a second operator approves them. The
 * separation is enforced in three places, deliberately:
 *
 *   - here, so the caller gets an error it can show a person
 *   - in the route layer, which refuses to run a sensitive handler directly
 *   - in the schema, where approvals_four_eyes rejects the row outright
 *
 * The last one is the guarantee. The first is the good error message.
 */

/**
 * Actions that need a second pair of eyes. Everything else applies directly.
 *
 * The test is what an action can do at its worst, not how often it is used: a cash rule
 * change raises the withdrawal limit for every member at once, a recall pulls money back
 * from a cardholder, an external payment moves real funds, and deleting a cardholder
 * destroys their history.
 */
export const SENSITIVE_ACTIONS = new Set([
  'cash.rule.create',
  'cash.rule.update',
  'cash.rule.delete',
  'cash.rule.assign',
  'cash.decide',
  'credit.recall',
  'cardholder.delete',
  'ledger.external_payment',
  'ledger.hold.void',
  'connection.delete',
  'settings.update',
  // Deletes every cardholder, connection, credit and transaction in the program and seeds
  // it again. Nothing else on this list destroys as much in one call.
  'admin.reset',
])

export const needsApproval = (action) => SENSITIVE_ACTIONS.has(action)

// A request left sitting is a request nobody is thinking about any more.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

class ApprovalError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export { ApprovalError }

const approvalRow = (r) =>
  r == null ? null : {
    id: r.id,
    action: r.action,
    target: r.target,
    payload: r.payload ?? {},
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    appliedAt: r.applied_at,
    note: r.note,
    error: r.error,
    expiresAt: r.expires_at,
  }

/**
 * Park a sensitive write. The payload is what the handler will be given when the request
 * is eventually applied, so it has to carry everything the action needs.
 */
export async function requestApproval(client, { action, target = null, payload = {}, requestedBy, ttlMs = DEFAULT_TTL_MS }) {
  if (!action) throw new ApprovalError('An approval request needs an action.')
  if (!requestedBy) throw new ApprovalError('An approval request needs a requester.')

  const { rows } = await client.query(
    `INSERT INTO approvals (id, action, target, payload, requested_by, expires_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,now() + ($6 || ' milliseconds')::interval)
     RETURNING *`,
    [`apr_${randomUUID().slice(0, 12)}`, action, target, JSON.stringify(payload), requestedBy, String(ttlMs)],
  )
  return approvalRow(rows[0])
}

export async function getApproval(client, id, { forUpdate = false } = {}) {
  const { rows } = await client.query(`SELECT * FROM approvals WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])
  return approvalRow(rows[0])
}

export async function listPending(client, { limit = 100 } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY requested_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  )
  return rows.map(approvalRow)
}

/**
 * A second operator decides. The requester is refused here with a message, and refused
 * again by the schema if anything ever reaches the database another way.
 */
export async function decide(client, { id, decision, decidedBy, note = null }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new ApprovalError('A request is approved or rejected.')
  }
  if (!decidedBy) throw new ApprovalError('A decision needs a decider.')

  const current = await getApproval(client, id, { forUpdate: true })
  if (!current) throw new ApprovalError('Unknown approval request', 404)
  if (current.status !== 'PENDING') throw new ApprovalError(`This request was already ${current.status.toLowerCase()}.`, 409)
  // Nothing is written on the way out. This runs inside the caller's transaction, so a
  // status set here would be rolled back by the very error that is about to be thrown.
  // expireStale() is the one place expiry is actually materialized.
  if (current.expiresAt && new Date(current.expiresAt) < new Date()) {
    throw new ApprovalError('This request has expired. Ask for it again.', 409)
  }
  if (current.requestedBy === decidedBy) {
    throw new ApprovalError('A request must be approved by a different operator than the one who asked for it.', 403)
  }

  const { rows } = await client.query(
    `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), note = $4
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *`,
    [id, decision, decidedBy, note],
  )
  if (!rows.length) throw new ApprovalError('This request was decided by someone else first.', 409)
  return approvalRow(rows[0])
}

/**
 * Carry out an approved request.
 *
 * `apply` runs inside its own transaction and receives the client and the payload. A
 * failure is recorded on the request rather than lost: the write is rolled back, the row
 * is marked FAILED with the reason, and an operator can see what happened and ask again.
 *
 * Takes the pool rather than a client, because marking the failure has to survive the
 * rollback of the attempt that failed.
 */
export async function applyApproved(db, { id, apply }) {
  const approval = await getApproval(db.pool ?? db, id)
  if (!approval) throw new ApprovalError('Unknown approval request', 404)
  if (approval.status === 'APPLIED') throw new ApprovalError('This request was already carried out.', 409)
  if (approval.status !== 'APPROVED') throw new ApprovalError(`Only an approved request can be carried out; this one is ${approval.status.toLowerCase()}.`, 409)

  try {
    return await db.tx(async (c) => {
      // Claim it inside the transaction so two operators clicking at once cannot both
      // carry out the same request.
      const claimed = await c.query(
        `UPDATE approvals SET status = 'APPLIED', applied_at = now() WHERE id = $1 AND status = 'APPROVED' RETURNING *`,
        [id],
      )
      if (!claimed.rows.length) throw new ApprovalError('This request was already carried out.', 409)

      const result = await apply(c, approval.payload, approval)
      return { approval: approvalRow(claimed.rows[0]), result }
    })
  } catch (err) {
    // A conflict means someone else got there first; that is not a failed action.
    if (err instanceof ApprovalError) throw err

    await db
      .query(`UPDATE approvals SET status = 'FAILED', error = $2 WHERE id = $1`, [id, err.message])
      .catch(() => {})
    throw err
  }
}

/** Sweep requests nobody decided in time. */
export async function expireStale(client) {
  const { rows } = await client.query(
    `UPDATE approvals SET status = 'EXPIRED'
      WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < now()
      RETURNING id`,
  )
  return rows.map((r) => r.id)
}
