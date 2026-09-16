/**
 * Double-entry posting.
 *
 * The envelope balances the app shows are a projection of this journal, not the record
 * itself. Every movement is a balanced entry, so "where did this euro go" is answerable
 * and a drifted balance is a detectable break rather than a silent error.
 *
 * Account conventions, from the envelope's point of view:
 *
 *   credit from an agency   DR funding      CR envelope     envelope grows
 *   purchase settles        DR envelope     CR settlement   envelope shrinks
 *   refund                  DR settlement   CR envelope     envelope grows back
 *   agency recall           DR envelope     CR recall       envelope shrinks
 *
 * So an envelope's balance is sum(CR) - sum(DR) on its account, and its spend is the
 * total debited to settlement and cash.
 *
 * Every posting carries an idempotency key. Replaying an ASA decision or re-syncing a
 * Lithic transaction recomputes the same key, the unique index rejects it, and the
 * posting is skipped instead of doubling the money.
 */

const ACCOUNT_KINDS = {
  ENVELOPE: (ref) => `env:${ref}`,
  FUNDING: (ref) => `fund:${ref}`,
  SETTLEMENT: (ref) => `settle:${ref}`,
  CASH: (ref) => `cash:${ref}`,
  RECALL: (ref) => `recall:${ref}`,
  UNALLOCATED: (ref) => `unalloc:${ref}`,
}

/**
 * Get or create a ledger account. Accounts are derived from the thing they track, so the
 * id is deterministic and two concurrent postings converge on the same row.
 */
export async function ensureAccount(client, { kind, ref, cardholderId = null, connectionId = null, envelopeId = null }) {
  const build = ACCOUNT_KINDS[kind]
  if (!build) throw new Error(`Unknown ledger account kind: ${kind}`)
  const id = build(ref)

  await client.query(
    `INSERT INTO ledger_accounts (id, kind, cardholder_id, connection_id, envelope_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, kind, cardholderId, connectionId, envelopeId],
  )
  return id
}

/**
 * Write one balanced entry.
 *
 * `lines` is a list of `{ accountId, direction, amountCents }`. Lines with a zero amount
 * are dropped, so a caller can pass a cash leg and a goods leg without checking which of
 * them actually moved. Returns null when this key was already posted.
 */
export async function postEntry(client, { idempotencyKey, kind, lines, at, source = null, transactionId = null, creditId = null, cardholderId = null, memo = null, createdBy = null }) {
  const used = lines.filter((line) => line.amountCents !== 0)
  if (!used.length) return null

  const debits = used.filter((l) => l.direction === 'DR').reduce((sum, l) => sum + l.amountCents, 0)
  const credits = used.filter((l) => l.direction === 'CR').reduce((sum, l) => sum + l.amountCents, 0)
  if (debits !== credits) {
    // The database would refuse this at COMMIT anyway; failing here names the caller.
    throw new Error(`Journal entry ${idempotencyKey} does not balance: debits ${debits}, credits ${credits}`)
  }

  const entry = await client.query(
    `INSERT INTO journal_entries (idempotency_key, kind, at, source, transaction_id, credit_id, cardholder_id, memo, created_by)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [idempotencyKey, kind, at ?? null, source, transactionId, creditId, cardholderId, memo, createdBy],
  )

  // Already posted. The caller replayed something; that is expected, not an error.
  if (!entry.rows.length) return null
  const entryId = entry.rows[0].id

  for (const line of used) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, direction, amount_cents)
       VALUES ($1, $2, $3, $4)`,
      [entryId, line.accountId, line.direction, Math.abs(line.amountCents)],
    )
  }

  return entryId
}

/** Money arriving from a paying agency and landing in an envelope. */
export async function postCredit(client, { credit, envelope, connection, at, source = 'hook' }) {
  const funding = await ensureAccount(client, { kind: 'FUNDING', ref: connection.id, connectionId: connection.id })
  const envelopeAccount = await ensureAccount(client, {
    kind: 'ENVELOPE',
    ref: envelope.id,
    envelopeId: envelope.id,
    cardholderId: envelope.cardholder_id ?? envelope.cardholderId,
  })

  return postEntry(client, {
    idempotencyKey: `credit:${credit.id}`,
    kind: 'CREDIT',
    at,
    source,
    creditId: credit.id,
    cardholderId: credit.cardholder_id ?? credit.cardholderId,
    memo: credit.remittance ?? null,
    lines: [
      { accountId: funding, direction: 'DR', amountCents: credit.amountCents ?? credit.amount_cents },
      { accountId: envelopeAccount, direction: 'CR', amountCents: credit.amountCents ?? credit.amount_cents },
    ],
  })
}

/**
 * An agency taking back what is still unspent. `takenCents` is what the envelope could
 * actually give up, which is not necessarily the full credit.
 */
export async function postRecall(client, { credit, envelopeId, takenCents, recalledTotalCents, connectionId, cardholderId, at, source = 'hook' }) {
  if (!takenCents) return null

  const envelopeAccount = await ensureAccount(client, { kind: 'ENVELOPE', ref: envelopeId, envelopeId, cardholderId })
  const recall = await ensureAccount(client, { kind: 'RECALL', ref: connectionId, connectionId })

  return postEntry(client, {
    // The running total makes a partial recall followed by another one two distinct keys.
    idempotencyKey: `recall:${credit.id}:${recalledTotalCents}`,
    kind: 'RECALL',
    at,
    source,
    creditId: credit.id,
    cardholderId,
    lines: [
      { accountId: envelopeAccount, direction: 'DR', amountCents: takenCents },
      { accountId: recall, direction: 'CR', amountCents: takenCents },
    ],
  })
}

/**
 * Book the difference between what a transaction currently occupies and what it should.
 *
 * This is the journal form of settleDebit(): the goods part and the cash part move on
 * their own envelopes, and a delta of zero posts nothing. A positive delta takes money
 * out of an envelope, a negative one puts it back (a refund, reversal or expiry).
 *
 * `goodsDelta` and `cashDelta` are the already-computed differences. `bookedTotal` and
 * `bookedCash` are what they add up to afterwards, and they make the idempotency key: a
 * replay that would land on the same booked state posts nothing.
 */
export async function postTransactionDelta(client, {
  transactionId,
  cardholderId,
  envelopeId,
  cashEnvelopeId,
  goodsDelta,
  cashDelta,
  bookedTotal,
  bookedCash,
  at,
  kind = 'SETTLEMENT',
  source = null,
}) {
  if (!goodsDelta && !cashDelta) return null

  const lines = []

  if (goodsDelta) {
    // Without an envelope the money is real but unattributed; it waits on the
    // cardholder's unallocated account until an operator allocates it.
    const account = envelopeId
      ? await ensureAccount(client, { kind: 'ENVELOPE', ref: envelopeId, envelopeId, cardholderId })
      : await ensureAccount(client, { kind: 'UNALLOCATED', ref: cardholderId, cardholderId })
    const settlement = await ensureAccount(client, { kind: 'SETTLEMENT', ref: cardholderId, cardholderId })

    lines.push(
      { accountId: account, direction: goodsDelta > 0 ? 'DR' : 'CR', amountCents: Math.abs(goodsDelta) },
      { accountId: settlement, direction: goodsDelta > 0 ? 'CR' : 'DR', amountCents: Math.abs(goodsDelta) },
    )
  }

  if (cashDelta) {
    const account = cashEnvelopeId
      ? await ensureAccount(client, { kind: 'ENVELOPE', ref: cashEnvelopeId, envelopeId: cashEnvelopeId, cardholderId })
      : await ensureAccount(client, { kind: 'UNALLOCATED', ref: cardholderId, cardholderId })
    const cash = await ensureAccount(client, { kind: 'CASH', ref: cardholderId, cardholderId })

    lines.push(
      { accountId: account, direction: cashDelta > 0 ? 'DR' : 'CR', amountCents: Math.abs(cashDelta) },
      { accountId: cash, direction: cashDelta > 0 ? 'CR' : 'DR', amountCents: Math.abs(cashDelta) },
    )
  }

  return postEntry(client, {
    idempotencyKey: `txn:${transactionId}:${bookedTotal}:${bookedCash}`,
    kind,
    at,
    source,
    transactionId,
    cardholderId,
    lines,
  })
}

/**
 * An operator attributing an unallocated amount to a real envelope. The money does not
 * move in or out of the program, it moves between two of its accounts.
 */
export async function postAllocation(client, { transactionId, cardholderId, envelopeId, amountCents, actor, at }) {
  if (!amountCents) return null

  const unallocated = await ensureAccount(client, { kind: 'UNALLOCATED', ref: cardholderId, cardholderId })
  const envelopeAccount = await ensureAccount(client, { kind: 'ENVELOPE', ref: envelopeId, envelopeId, cardholderId })

  return postEntry(client, {
    idempotencyKey: `alloc:${transactionId}:${envelopeId}:${amountCents}`,
    kind: 'ALLOCATION',
    at,
    transactionId,
    cardholderId,
    createdBy: actor ?? null,
    lines: [
      { accountId: envelopeAccount, direction: amountCents > 0 ? 'DR' : 'CR', amountCents: Math.abs(amountCents) },
      { accountId: unallocated, direction: amountCents > 0 ? 'CR' : 'DR', amountCents: Math.abs(amountCents) },
    ],
  })
}

/**
 * What the journal says an envelope holds: credits in, spend and recalls out.
 * The reconciliation job compares this with envelopes.balance_cents.
 */
export async function envelopeBalance(client, envelopeId) {
  // sum() over bigint returns numeric, which node-postgres hands back as a string. The
  // cast keeps money arriving as a number, the way every caller expects.
  const { rows } = await client.query(
    `SELECT (COALESCE(sum(amount_cents) FILTER (WHERE direction = 'CR'), 0)
           - COALESCE(sum(amount_cents) FILTER (WHERE direction = 'DR'), 0))::bigint AS balance_cents
       FROM journal_lines
      WHERE account_id = $1`,
    [`env:${envelopeId}`],
  )
  return rows[0]?.balance_cents ?? 0
}

/** Journal balances for every envelope at once, for the reconciliation sweep. */
export async function allEnvelopeBalances(client) {
  const { rows } = await client.query(
    `SELECT a.envelope_id,
            (COALESCE(sum(l.amount_cents) FILTER (WHERE l.direction = 'CR'), 0)
           - COALESCE(sum(l.amount_cents) FILTER (WHERE l.direction = 'DR'), 0))::bigint AS balance_cents
       FROM ledger_accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
      WHERE a.kind = 'ENVELOPE'
      GROUP BY a.envelope_id`,
  )
  return new Map(rows.map((r) => [r.envelope_id, r.balance_cents]))
}
