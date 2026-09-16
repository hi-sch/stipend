import { randomUUID } from 'node:crypto'

/**
 * Reconciliation and break detection.
 *
 * Two questions, asked on a schedule and on demand:
 *
 *   1. Does Stipend agree with itself? Envelope balances are a projection of the journal,
 *      so any envelope whose cached balance differs from its journal position is a break.
 *      This is the check that catches a bug in our own posting code.
 *
 *   2. Does Stipend agree with Lithic? Every card transaction Lithic knows about should
 *      exist here with the same amount and status, and vice versa. This is the check that
 *      catches a dropped webhook, a failed sync or a transaction authorized outside ASA.
 *
 * A break is never repaired automatically. Money that disagrees is an operator decision:
 * the run records what it found and someone resolves or accepts it.
 *
 * Note on seeded data: an envelope carrying an opening balance with no journal entries
 * behind it reads as a break, correctly. The seeder posts an ADJUSTMENT entry for opening
 * balances so demo data reconciles like real data.
 */

const BREAK = {
  ENVELOPE_BALANCE: 'ENVELOPE_BALANCE',
  MISSING_IN_STIPEND: 'MISSING_IN_STIPEND',
  MISSING_IN_LITHIC: 'MISSING_IN_LITHIC',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  UNALLOCATED: 'UNALLOCATED',
}

export const BREAK_KINDS = BREAK

/** Statuses that hold no money, so Lithic having no record of them is not a difference. */
const WEIGHTLESS = new Set(['DECLINED', 'VOIDED', 'EXPIRED'])

/**
 * Compare cached envelope balances against the journal.
 *
 * Scoped to one cardholder when `cardholderId` is given: an operator looking at one
 * account should not have to sweep the whole program, and a scheduled run can walk
 * accounts in batches instead of taking one long snapshot.
 */
export async function findBalanceBreaks(client, { cardholderId = null } = {}) {
  const { rows } = await client.query(
    `SELECT e.id            AS envelope_id,
            e.cardholder_id,
            e.connection_name,
            e.balance_cents AS cached_cents,
            COALESCE(j.balance_cents, 0) AS journal_cents
       FROM envelopes e
       LEFT JOIN (
         SELECT a.envelope_id,
                (COALESCE(sum(l.amount_cents) FILTER (WHERE l.direction = 'CR'), 0)
               - COALESCE(sum(l.amount_cents) FILTER (WHERE l.direction = 'DR'), 0))::bigint AS balance_cents
           FROM ledger_accounts a
           LEFT JOIN journal_lines l ON l.account_id = a.id
          WHERE a.kind = 'ENVELOPE'
          GROUP BY a.envelope_id
       ) j ON j.envelope_id = e.id
      WHERE ($1::text IS NULL OR e.cardholder_id = $1)
        AND e.balance_cents <> COALESCE(j.balance_cents, 0)`,
    [cardholderId],
  )

  return rows.map((r) => ({
    kind: BREAK.ENVELOPE_BALANCE,
    // Our own books disagreeing with themselves is the most serious thing here.
    severity: 'CRITICAL',
    cardholderId: r.cardholder_id,
    envelopeId: r.envelope_id,
    transactionId: null,
    expectedCents: r.journal_cents,
    actualCents: r.cached_cents,
    detail: {
      connection: r.connection_name,
      driftCents: r.cached_cents - r.journal_cents,
      note: 'Cached envelope balance disagrees with the journal.',
    },
  }))
}

/** Money booked but not attributed to an envelope, waiting on an operator. */
export async function findUnallocatedBreaks(client, { cardholderId = null } = {}) {
  const { rows } = await client.query(
    `SELECT id, cardholder_id, envelope_id, unallocated_cents, merchant, status
       FROM transactions
      WHERE unallocated_cents <> 0
        AND ($1::text IS NULL OR cardholder_id = $1)`,
    [cardholderId],
  )

  return rows.map((r) => ({
    kind: BREAK.UNALLOCATED,
    severity: 'WARN',
    cardholderId: r.cardholder_id,
    envelopeId: r.envelope_id,
    transactionId: r.id,
    expectedCents: 0,
    actualCents: r.unallocated_cents,
    detail: {
      merchant: r.merchant?.descriptor ?? null,
      status: r.status,
      note: r.unallocated_cents < 0 ? 'Refund has no envelope to return to.' : 'Approved outside any envelope.',
    },
  }))
}

/**
 * Compare Stipend's transactions against Lithic's for the same window.
 *
 * `lithicTransactions` is a list of already-mapped transactions, so this function stays
 * testable without a Lithic key and without a network.
 */
export async function findLithicBreaks(client, lithicTransactions, { cardholderId = null, since = null } = {}) {
  const { rows } = await client.query(
    `SELECT id, cardholder_id, card_token, amount_cents, status, merchant
       FROM transactions
      WHERE ($1::text IS NULL OR cardholder_id = $1)
        AND ($2::timestamptz IS NULL OR created_at >= $2)
        AND live`,
    [cardholderId, since],
  )

  const ours = new Map(rows.map((r) => [r.id, r]))
  const theirs = new Map(lithicTransactions.map((t) => [t.id, t]))
  const breaks = []

  for (const [id, mine] of ours) {
    const other = theirs.get(id)
    if (!other) {
      // A declined or reversed authorization holds no money; Lithic dropping it from the
      // window is not a difference worth waking anyone for.
      if (WEIGHTLESS.has(mine.status)) continue
      breaks.push({
        kind: BREAK.MISSING_IN_LITHIC,
        severity: 'CRITICAL',
        cardholderId: mine.cardholder_id,
        transactionId: id,
        envelopeId: null,
        expectedCents: mine.amount_cents,
        actualCents: null,
        detail: { merchant: mine.merchant?.descriptor ?? null, status: mine.status, note: 'Stipend booked a transaction Lithic has no record of.' },
      })
      continue
    }

    if (other.amountCents !== mine.amount_cents) {
      breaks.push({
        kind: BREAK.AMOUNT_MISMATCH,
        severity: 'CRITICAL',
        cardholderId: mine.cardholder_id,
        transactionId: id,
        envelopeId: null,
        expectedCents: other.amountCents,
        actualCents: mine.amount_cents,
        detail: { merchant: mine.merchant?.descriptor ?? null, note: 'Amount differs between Stipend and Lithic.' },
      })
    }

    if (other.status !== mine.status) {
      breaks.push({
        kind: BREAK.STATUS_MISMATCH,
        // A status that lags is usually a sync that has not caught up yet.
        severity: 'WARN',
        cardholderId: mine.cardholder_id,
        transactionId: id,
        envelopeId: null,
        expectedCents: mine.amount_cents,
        actualCents: mine.amount_cents,
        detail: { stipend: mine.status, lithic: other.status, note: 'Status differs between Stipend and Lithic.' },
      })
    }
  }

  for (const [id, other] of theirs) {
    if (ours.has(id)) continue
    breaks.push({
      kind: BREAK.MISSING_IN_STIPEND,
      severity: 'CRITICAL',
      cardholderId: other.cardholderId ?? null,
      transactionId: null,
      envelopeId: null,
      expectedCents: other.amountCents,
      actualCents: null,
      detail: { lithicTransaction: id, merchant: other.merchant?.descriptor ?? null, status: other.status, note: 'Lithic has a transaction Stipend never recorded.' },
    })
  }

  return breaks
}

/**
 * Run the checks and record what they found.
 *
 * `fetchLithicTransactions` is optional: without a Lithic key, or when only the internal
 * consistency of the books is in question, the run does the journal checks alone and says
 * so in its summary.
 */
export async function runReconciliation({ db, fetchLithicTransactions = null, cardholderId = null, since = null, log } = {}) {
  const runId = `recon_${randomUUID().slice(0, 12)}`

  await db.query(
    `INSERT INTO recon_runs (id, status, summary) VALUES ($1, 'RUNNING', $2::jsonb)`,
    [runId, JSON.stringify({ cardholderId, since, lithic: Boolean(fetchLithicTransactions) })],
  )

  try {
    const balance = await findBalanceBreaks(db.pool ?? db, { cardholderId })
    const unallocated = await findUnallocatedBreaks(db.pool ?? db, { cardholderId })

    let lithic = []
    let comparedWithLithic = false
    if (fetchLithicTransactions) {
      const fetched = await fetchLithicTransactions({ cardholderId, since })
      lithic = await findLithicBreaks(db.pool ?? db, fetched ?? [], { cardholderId, since })
      comparedWithLithic = true
    }

    const found = [...balance, ...unallocated, ...lithic]

    // One transaction for all the breaks, so a run is never half recorded.
    await db.tx(async (c) => {
      for (const b of found) {
        await c.query(
          `INSERT INTO recon_breaks (id, run_id, kind, severity, cardholder_id, transaction_id, envelope_id,
                                     expected_cents, actual_cents, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            `brk_${randomUUID().slice(0, 12)}`,
            runId,
            b.kind,
            b.severity,
            b.cardholderId,
            b.transactionId,
            b.envelopeId,
            b.expectedCents,
            b.actualCents,
            JSON.stringify(b.detail ?? {}),
          ],
        )
      }

      await c.query(
        `UPDATE recon_runs
            SET status = $2, finished_at = now(), checked = $3, break_count = $4, summary = $5::jsonb
          WHERE id = $1`,
        [
          runId,
          found.length ? 'BREAKS' : 'OK',
          balance.length + unallocated.length + lithic.length,
          found.length,
          JSON.stringify({
            cardholderId,
            since,
            comparedWithLithic,
            byKind: found.reduce((acc, b) => ({ ...acc, [b.kind]: (acc[b.kind] ?? 0) + 1 }), {}),
          }),
        ],
      )
    })

    if (found.length) log?.warn?.('reconciliation found breaks', { runId, breaks: found.length })
    else log?.info?.('reconciliation clean', { runId })

    return { runId, status: found.length ? 'BREAKS' : 'OK', breaks: found }
  } catch (err) {
    await db
      .query(`UPDATE recon_runs SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1`, [runId, err.message])
      .catch(() => {})
    throw err
  }
}

/** Breaks an operator still owes a decision on. */
export async function openBreaks(client, { limit = 100 } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM recon_breaks
      WHERE status = 'OPEN'
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, created_at DESC
      LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  )
  return rows
}

/**
 * Clear a break. RESOLVED means the underlying difference was corrected; ACCEPTED means an
 * operator looked at it and decided it is explained. Both record who decided and why.
 */
export async function resolveBreak(client, { id, status = 'RESOLVED', actor, resolution }) {
  if (!['RESOLVED', 'ACCEPTED'].includes(status)) {
    throw Object.assign(new Error('A break is resolved or accepted.'), { status: 400 })
  }
  const { rows } = await client.query(
    `UPDATE recon_breaks
        SET status = $2, resolved_by = $3, resolved_at = now(), resolution = $4
      WHERE id = $1 AND status = 'OPEN'
      RETURNING *`,
    [id, status, actor ?? null, resolution ?? null],
  )
  if (!rows.length) throw Object.assign(new Error('Unknown or already cleared break'), { status: 404 })
  return rows[0]
}
