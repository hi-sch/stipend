import { secretBox } from './secrets.js'

/**
 * Row access for the money path.
 *
 * Every function takes the `client` of an open transaction, so a caller composes several
 * of them into one atomic unit. Nothing here opens its own transaction and nothing here
 * calls out to Lithic or email: a transaction body may be retried after a serialization
 * failure, so it has to be free of outside side effects.
 *
 * The locking rule that matters: an authorization locks one cardholder's envelopes with
 * SELECT ... FOR UPDATE. Two cardholders spending at the same moment no longer serialize
 * behind each other, which is what the single-document store forced them to do.
 */

// ---------------------------------------------------------------- row mapping

// The API payload and the frontend both speak camelCase; the schema speaks snake_case.
// These mappers are the only place the two meet.

const envelopeRow = (r) =>
  r == null ? null : {
    id: r.id,
    cardholderId: r.cardholder_id,
    connectionId: r.connection_id,
    connectionName: r.connection_name,
    balanceCents: r.balance_cents,
    spentCents: r.spent_cents,
    mccs: r.mccs ?? [],
    countries: r.countries ?? [],
    color: r.color,
    receivedAt: r.received_at,
    endToEndId: r.end_to_end_id,
    remittance: r.remittance,
  }

const creditRow = (r) =>
  r == null ? null : {
    id: r.id,
    created: r.created_at,
    connectionId: r.connection_id,
    cardholderId: r.cardholder_id,
    envelopeId: r.envelope_id,
    amountCents: r.amount_cents,
    recalledCents: r.recalled_cents,
    currency: r.currency,
    endToEndId: r.end_to_end_id,
    msgId: r.msg_id,
    protocol: r.protocol,
    purpose: r.purpose,
    remittance: r.remittance,
    status: r.status,
    method: r.method,
    lithicCategory: r.lithic_category,
    lithicTransfer: r.lithic_transfer,
    recall: r.recall,
  }

const transactionRow = (r) =>
  r == null ? null : {
    id: r.id,
    cardholderId: r.cardholder_id,
    cardToken: r.card_token,
    created: r.created_at,
    updated: r.updated_at,
    kind: r.kind,
    status: r.status,
    result: r.result,
    detailedResults: r.detailed_results ?? [],
    merchant: r.merchant ?? {},
    currency: r.currency,
    requestedCents: r.requested_cents,
    amountCents: r.amount_cents,
    envelopeId: r.envelope_id,
    cashEnvelopeId: r.cash_envelope_id,
    cashCents: r.cash_cents,
    debitedCents: r.debited_cents,
    cashDebitedCents: r.cash_debited_cents,
    unallocatedCents: r.unallocated_cents,
    review: r.review,
    allocatedBy: r.allocated_by,
    note: r.note,
    asaResult: r.asa_result,
    asaResponse: r.asa_response,
    source: r.source,
    live: r.live,
    events: r.events ?? [],
    lithic: r.lithic ?? {},
  }

const connectionRow = (r) =>
  r == null ? null : {
    id: r.id,
    name: r.name,
    agency: r.agency,
    country: r.country,
    system: r.system,
    protocol: r.protocol,
    purpose: r.purpose,
    status: r.status,
    mccs: r.mccs ?? [],
    countries: r.countries ?? [],
    dailyLimitCents: r.daily_limit_cents,
    cashAllowed: r.cash_allowed,
    hookPath: r.hook_path,
    // The only read path for this secret: HMAC verification, the masked payload and the
    // create/rotate responses all come through here.
    hmacSecret: secretBox().open(r.hmac_secret),
    createdAt: r.created_at,
  }

const cardholderRow = (r) =>
  r == null ? null : {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    city: r.city,
    country: r.country,
    ibanRef: r.iban_ref,
    beneficiaryRef: r.beneficiary_ref,
    iban: r.iban,
    lithicAccount: r.lithic_account,
    lithicHolder: r.lithic_holder,
    dob: r.dob,
    physical: r.physical ?? {},
    card: r.card ?? {},
    kyc: r.kyc ?? { status: 'NOT_SUBMITTED' },
    prefs: r.prefs ?? {},
    createdAt: r.created_at,
  }

export const rows = { envelopeRow, creditRow, transactionRow, connectionRow, cardholderRow }

// ---------------------------------------------------------------- cardholders

export async function getCardholder(client, id) {
  const { rows: r } = await client.query('SELECT * FROM cardholders WHERE id = $1', [id])
  return cardholderRow(r[0])
}

/** The cardholder a Lithic card belongs to. Backs holderByCard() on the ASA path. */
export async function getCardholderByCardToken(client, cardToken) {
  if (!cardToken) return null
  const { rows: r } = await client.query(`SELECT * FROM cardholders WHERE card ->> 'token' = $1`, [cardToken])
  return cardholderRow(r[0])
}

export async function listCardholders(client) {
  const { rows: r } = await client.query('SELECT * FROM cardholders ORDER BY created_at')
  return r.map(cardholderRow)
}

/**
 * Every cardholder with the cash state, envelope summary and cash usage the console shows.
 *
 * This replaces reading the cardholders and then asking two more questions per row. On a
 * program with a thousand cardholders that was two thousand queries for one page load,
 * and it grew with the program.
 *
 * The period boundary matches cashPeriodStart(): UTC, and a week starts on Monday, which
 * is what date_trunc('week') does. If those two ever disagree, cash limits silently shift.
 */
export async function cardholdersForConsole(client) {
  const { rows } = await client.query(`
    SELECT c.*,
           cc.status  AS cash_status,
           cc.rule_id AS cash_rule_id,
           cc.requested_cents, cc.requested_period, cc.reason AS cash_reason,
           cc.requested_at, cc.decided_at, cc.decided_by, cc.note AS cash_note,
           r.name AS rule_name, r.limit_cents AS rule_limit_cents, r.period AS rule_period,
           COALESCE(env.count, 0)     AS envelope_count,
           COALESCE(env.available, 0) AS envelope_available,
           usage.period_start,
           COALESCE(usage.used_cents, 0) AS cash_used_cents
      FROM cardholders c
      LEFT JOIN cardholder_cash cc ON cc.cardholder_id = c.id
      LEFT JOIN cash_rules r ON r.id = cc.rule_id AND cc.status = 'APPROVED'
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count, COALESCE(sum(balance_cents), 0)::bigint AS available
          FROM envelopes e WHERE e.cardholder_id = c.id
      ) env ON true
      LEFT JOIN LATERAL (
        SELECT start.at AS period_start,
               COALESCE(sum(t.cash_cents), 0)::bigint AS used_cents
          FROM (
            SELECT date_trunc(
                     CASE r.period WHEN 'DAY' THEN 'day' WHEN 'WEEK' THEN 'week' ELSE 'month' END,
                     now() AT TIME ZONE 'UTC'
                   ) AT TIME ZONE 'UTC' AS at
          ) start
          LEFT JOIN transactions t
            ON t.cardholder_id = c.id
           AND t.cash_cents > 0
           AND t.status <> ALL ('{DECLINED,VOIDED,EXPIRED}')
           AND t.created_at >= start.at
         GROUP BY start.at
      ) usage ON r.id IS NOT NULL
     ORDER BY c.created_at
  `)

  return rows.map((r) => {
    const base = cardholderRow(r)
    const cash = r.cash_status
      ? {
          status: r.cash_status,
          ruleId: r.cash_rule_id,
          requestedCents: r.requested_cents,
          requestedPeriod: r.requested_period,
          reason: r.cash_reason,
          requestedAt: r.requested_at,
          decidedAt: r.decided_at,
          decidedBy: r.decided_by,
          note: r.cash_note,
          // Only a cardholder in an approved rule carries the rule's limit. withCash left
          // these keys out entirely otherwise, and the console tells the difference.
          ...(r.rule_name ? { limitCents: r.rule_limit_cents, period: r.rule_period, ruleName: r.rule_name } : {}),
        }
      : { status: 'NONE' }

    return {
      ...base,
      cash,
      summary: { count: r.envelope_count, available: r.envelope_available },
      cashUsage: r.rule_name
        ? {
            ruleId: r.cash_rule_id,
            ruleName: r.rule_name,
            usedCents: r.cash_used_cents,
            limitCents: r.rule_limit_cents,
            period: r.rule_period,
            periodStart: r.period_start,
            remainingCents: Math.max(0, r.rule_limit_cents - r.cash_used_cents),
          }
        : null,
    }
  })
}

/** The cardholder behind a Lithic account holder token, for account_holder.* events. */
export async function getCardholderByLithicHolder(client, token) {
  if (!token) return null
  const { rows: r } = await client.query('SELECT * FROM cardholders WHERE lithic_holder = $1', [token])
  return cardholderRow(r[0])
}

// Which camelCase field maps to which column, and whether a jsonb value is merged into
// what is there or replaces it. Anything not listed here cannot be written by an update,
// which is the point: a typo becomes an error instead of a silently ignored field.
const CARDHOLDER_COLUMNS = {
  firstName: { column: 'first_name' },
  lastName: { column: 'last_name' },
  email: { column: 'email' },
  phone: { column: 'phone' },
  city: { column: 'city' },
  country: { column: 'country' },
  dob: { column: 'dob' },
  ibanRef: { column: 'iban_ref' },
  beneficiaryRef: { column: 'beneficiary_ref' },
  iban: { column: 'iban' },
  lithicAccount: { column: 'lithic_account' },
  lithicHolder: { column: 'lithic_holder' },
  // Card and physical are accumulated: a refresh from Lithic updates the fields it knows
  // and leaves the rule tokens Stipend stored alongside them.
  card: { column: 'card', merge: true },
  physical: { column: 'physical', merge: true },
  prefs: { column: 'prefs', merge: true },
  // KYC is replaced wholesale, because a stale status reason must not survive a refresh.
  kyc: { column: 'kyc', json: true },
}

/**
 * Update a cardholder. This is what patchHolder() did to the draft, expressed as one
 * statement so a concurrent writer touching a different field cannot be lost.
 */
export async function updateCardholder(client, id, fields) {
  const sets = []
  const args = [id]

  for (const [key, value] of Object.entries(fields)) {
    const spec = CARDHOLDER_COLUMNS[key]
    if (!spec || value === undefined) continue
    args.push(spec.merge || spec.json ? JSON.stringify(value) : value)
    const placeholder = `$${args.length}`
    sets.push(spec.merge ? `${spec.column} = ${spec.column} || ${placeholder}::jsonb` : spec.json ? `${spec.column} = ${placeholder}::jsonb` : `${spec.column} = ${placeholder}`)
  }

  if (!sets.length) return getCardholder(client, id)

  const { rows: r } = await client.query(
    `UPDATE cardholders SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    args,
  )
  return cardholderRow(r[0])
}

/** Keep the sign-in address in step when a cardholder's email changes. */
export async function updateUserEmailForCardholder(client, cardholderId, email) {
  await client.query('UPDATE users SET email = $2 WHERE cardholder_id = $1', [cardholderId, email])
}

// ---------------------------------------------------------------- disputes

const disputeRow = (r) =>
  r == null ? null : {
    id: r.id,
    lithicToken: r.lithic_token,
    cardholderId: r.cardholder_id,
    transactionId: r.transaction_id,
    merchant: r.merchant ?? {},
    amountCents: r.amount_cents,
    reason: r.reason,
    note: r.note,
    status: r.status,
    resolutionReason: r.resolution_reason,
    evidence: r.evidence ?? [],
    created: r.created_at,
    updated: r.updated_at,
  }

export async function insertDispute(client, dispute) {
  const { rows: r } = await client.query(
    `INSERT INTO disputes (id, lithic_token, cardholder_id, transaction_id, merchant, amount_cents,
                           reason, note, status, resolution_reason, evidence)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'[]'::jsonb)
     RETURNING *`,
    [
      dispute.id,
      dispute.lithicToken ?? null,
      dispute.cardholderId,
      dispute.transactionId,
      JSON.stringify(dispute.merchant ?? {}),
      dispute.amountCents,
      dispute.reason ?? null,
      dispute.note ?? null,
      dispute.status ?? 'LOCAL',
      dispute.resolutionReason ?? null,
    ],
  )
  return disputeRow(r[0])
}

export async function getDispute(client, id, { forUpdate = false } = {}) {
  const { rows: r } = await client.query(`SELECT * FROM disputes WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])
  return disputeRow(r[0])
}

export async function getDisputeByLithicToken(client, token, { forUpdate = false } = {}) {
  if (!token) return null
  const { rows: r } = await client.query(`SELECT * FROM disputes WHERE lithic_token = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [token])
  return disputeRow(r[0])
}

export async function disputesFor(client, cardholderId) {
  const { rows: r } = await client.query('SELECT * FROM disputes WHERE cardholder_id = $1 ORDER BY created_at DESC', [cardholderId])
  return r.map(disputeRow)
}

export async function updateDispute(client, id, { status, resolutionReason, evidence }) {
  const { rows: r } = await client.query(
    `UPDATE disputes
        SET status            = COALESCE($2, status),
            resolution_reason = CASE WHEN $3::boolean THEN $4 ELSE resolution_reason END,
            evidence          = COALESCE($5::jsonb, evidence),
            updated_at        = now()
      WHERE id = $1
      RETURNING *`,
    [id, status ?? null, resolutionReason !== undefined, resolutionReason ?? null, evidence ? JSON.stringify(evidence) : null],
  )
  return disputeRow(r[0])
}

// ---------------------------------------------------------------- connections

export async function getConnection(client, id) {
  const { rows: r } = await client.query('SELECT * FROM connections WHERE id = $1', [id])
  return connectionRow(r[0])
}

export async function listConnections(client) {
  const { rows: r } = await client.query('SELECT * FROM connections ORDER BY created_at')
  return r.map(connectionRow)
}

/** Connections whose money may be taken as cash, for choosing a cash envelope. */
export async function cashConnectionIds(client) {
  const { rows: r } = await client.query('SELECT id FROM connections WHERE cash_allowed')
  return new Set(r.map((row) => row.id))
}

// ---------------------------------------------------------------- envelopes

/**
 * A cardholder's envelopes, newest credit first, matching the order the engine expects.
 *
 * `forUpdate` locks exactly these rows for the rest of the transaction. That is the whole
 * concurrency story for an authorization: two purchases on the same card queue, purchases
 * on different cards do not.
 */
export async function envelopesFor(client, cardholderId, { forUpdate = false } = {}) {
  const { rows: r } = await client.query(
    `SELECT * FROM envelopes
      WHERE cardholder_id = $1
      ORDER BY received_at DESC NULLS LAST, created_at DESC
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [cardholderId],
  )
  return r.map(envelopeRow)
}

export async function getEnvelope(client, id, { forUpdate = false } = {}) {
  const { rows: r } = await client.query(`SELECT * FROM envelopes WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])
  return envelopeRow(r[0])
}

/**
 * The envelope a connection pays into, created on the first credit and topped up after.
 * The MCC and country allowlists follow the connection, so a policy change reaches money
 * that is already on the card.
 */
export async function upsertEnvelopeForCredit(client, { id, cardholderId, connection, amountCents, at, color, endToEndId, remittance }) {
  const { rows: r } = await client.query(
    `INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name, balance_cents, spent_cents,
                            mccs, countries, color, received_at, end_to_end_id, remittance)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (cardholder_id, connection_id) DO UPDATE
       SET balance_cents   = envelopes.balance_cents + EXCLUDED.balance_cents,
           connection_name = EXCLUDED.connection_name,
           mccs            = EXCLUDED.mccs,
           countries       = EXCLUDED.countries,
           received_at     = EXCLUDED.received_at,
           end_to_end_id   = COALESCE(EXCLUDED.end_to_end_id, envelopes.end_to_end_id),
           remittance      = COALESCE(EXCLUDED.remittance, envelopes.remittance)
     RETURNING *`,
    [
      id,
      cardholderId,
      connection.id,
      connection.name,
      amountCents,
      connection.mccs ?? [],
      connection.countries ?? [],
      color ?? null,
      at ?? new Date().toISOString(),
      endToEndId ?? null,
      remittance ?? null,
    ],
  )
  return envelopeRow(r[0])
}

/**
 * Move an envelope's cached balance. `delta` is what the transaction takes out, so a
 * positive delta lowers the balance and raises the spend, and a refund does the reverse.
 * The journal is the record; this keeps the projection in step with it.
 */
export async function applyEnvelopeDelta(client, envelopeId, delta) {
  if (!delta) return null
  const { rows: r } = await client.query(
    `UPDATE envelopes
        SET balance_cents = balance_cents - $2,
            spent_cents   = GREATEST(0, spent_cents + $2)
      WHERE id = $1
      RETURNING *`,
    [envelopeId, delta],
  )
  return envelopeRow(r[0])
}

// ---------------------------------------------------------------- credits

export async function insertCredit(client, credit) {
  const { rows: r } = await client.query(
    `INSERT INTO credits (id, connection_id, cardholder_id, envelope_id, amount_cents, recalled_cents,
                          currency, end_to_end_id, msg_id, protocol, purpose, remittance, status,
                          method, lithic_category, lithic_transfer, created_at)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz, now()))
     RETURNING *`,
    [
      credit.id,
      credit.connectionId,
      credit.cardholderId,
      credit.envelopeId ?? null,
      credit.amountCents,
      credit.currency ?? 'EUR',
      credit.endToEndId,
      credit.msgId ?? null,
      credit.protocol ?? null,
      credit.purpose ?? null,
      credit.remittance ?? null,
      credit.status ?? 'SETTLED',
      credit.method ?? null,
      credit.lithicCategory ?? null,
      credit.lithicTransfer ?? null,
      credit.created ?? null,
    ],
  )
  return creditRow(r[0])
}

/**
 * Whether this agency instruction was already applied. The unique index is the real
 * defence; this answers the question without provoking an error the caller must catch.
 */
export async function creditExists(client, connectionId, endToEndId) {
  const { rows: r } = await client.query(
    'SELECT 1 FROM credits WHERE connection_id = $1 AND end_to_end_id = $2',
    [connectionId, endToEndId],
  )
  return r.length > 0
}

export async function getCredit(client, id, { forUpdate = false } = {}) {
  const { rows: r } = await client.query(`SELECT * FROM credits WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])
  return creditRow(r[0])
}

export async function recordRecall(client, { creditId, recalledCents, status, recall }) {
  const { rows: r } = await client.query(
    `UPDATE credits SET recalled_cents = $2, status = $3, recall = $4 WHERE id = $1 RETURNING *`,
    [creditId, recalledCents, status, recall ?? null],
  )
  return creditRow(r[0])
}

export async function creditsFor(client, cardholderId) {
  const { rows: r } = await client.query('SELECT * FROM credits WHERE cardholder_id = $1 ORDER BY created_at DESC', [cardholderId])
  return r.map(creditRow)
}

// ---------------------------------------------------------------- transactions

export async function getTransaction(client, id, { forUpdate = false } = {}) {
  const { rows: r } = await client.query(`SELECT * FROM transactions WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])
  return transactionRow(r[0])
}

/**
 * Insert or update a transaction. Booked amounts are never taken from the incoming row:
 * they belong to the ledger and are moved only by applyBookedAmounts(), so a replayed
 * Lithic payload cannot reset what has already been booked.
 */
export async function upsertTransaction(client, txn) {
  const { rows: r } = await client.query(
    `INSERT INTO transactions (id, cardholder_id, card_token, kind, status, result, detailed_results,
                               merchant, currency, requested_cents, amount_cents, envelope_id,
                               cash_envelope_id, cash_cents, note, asa_result, asa_response,
                               source, live, events, lithic, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             COALESCE($22::timestamptz, now()), now())
     ON CONFLICT (id) DO UPDATE
       SET status           = EXCLUDED.status,
           result           = EXCLUDED.result,
           detailed_results = EXCLUDED.detailed_results,
           merchant         = EXCLUDED.merchant,
           amount_cents     = EXCLUDED.amount_cents,
           envelope_id      = COALESCE(EXCLUDED.envelope_id, transactions.envelope_id),
           cash_envelope_id = COALESCE(EXCLUDED.cash_envelope_id, transactions.cash_envelope_id),
           cash_cents       = EXCLUDED.cash_cents,
           note             = EXCLUDED.note,
           events           = EXCLUDED.events,
           lithic           = EXCLUDED.lithic,
           updated_at       = now()
     RETURNING *`,
    [
      txn.id,
      txn.cardholderId,
      txn.cardToken ?? null,
      txn.kind ?? 'PURCHASE',
      txn.status,
      txn.result ?? null,
      txn.detailedResults ?? [],
      txn.merchant ?? {},
      txn.currency ?? 'EUR',
      txn.requestedCents ?? 0,
      txn.amountCents ?? 0,
      txn.envelopeId ?? null,
      txn.cashEnvelopeId ?? null,
      txn.cashCents ?? 0,
      txn.note ?? null,
      txn.asaResult ?? null,
      txn.asaResponse ?? null,
      txn.source ?? null,
      txn.live ?? false,
      JSON.stringify(txn.events ?? []),
      JSON.stringify(txn.lithic ?? {}),
      txn.created ?? null,
    ],
  )
  return transactionRow(r[0])
}

/** Record what the ledger now holds for this transaction. */
export async function applyBookedAmounts(client, { transactionId, debitedCents, cashDebitedCents, unallocatedDelta = 0 }) {
  const { rows: r } = await client.query(
    `UPDATE transactions
        SET debited_cents      = $2,
            cash_debited_cents = $3,
            unallocated_cents  = unallocated_cents + $4,
            updated_at         = now()
      WHERE id = $1
      RETURNING *`,
    [transactionId, debitedCents, cashDebitedCents, unallocatedDelta],
  )
  return transactionRow(r[0])
}

export async function transactionsFor(client, cardholderId) {
  const { rows: r } = await client.query('SELECT * FROM transactions WHERE cardholder_id = $1 ORDER BY created_at DESC', [cardholderId])
  return r.map(transactionRow)
}

/**
 * A cardholder's transactions since a moment.
 *
 * The authorization path needs this rather than the full list: the engine's daily cap only
 * consults today's spend, so today is all it has to see. Loading a whole history on a
 * request with a ~2s ASA deadline would get slower for every cardholder who keeps using
 * their card.
 */
export async function transactionsSince(client, cardholderId, sinceIso) {
  const { rows: r } = await client.query(
    'SELECT * FROM transactions WHERE cardholder_id = $1 AND created_at >= $2 ORDER BY created_at DESC',
    [cardholderId, sinceIso],
  )
  return r.map(transactionRow)
}

/**
 * Cash already used in the current period. This used to be a scan over every transaction
 * in the document; it is now an indexed aggregate over one cardholder's cash spend.
 */
export async function cashUsedSince(client, cardholderId, periodStartIso) {
  const { rows: r } = await client.query(
    `SELECT COALESCE(sum(cash_cents), 0)::bigint AS used_cents
       FROM transactions
      WHERE cardholder_id = $1
        AND cash_cents > 0
        AND created_at >= $2
        AND status <> ALL ('{DECLINED,VOIDED,EXPIRED}')`,
    [cardholderId, periodStartIso],
  )
  return r[0]?.used_cents ?? 0
}

/**
 * What a cardholder has spent from one envelope today, for the per-connection daily cap.
 * The engine used to compute this in memory over the whole transaction list.
 */
export async function spentTodayFrom(client, cardholderId, envelopeId, sinceIso) {
  const { rows: r } = await client.query(
    `SELECT COALESCE(sum(amount_cents), 0)::bigint AS spent_cents
       FROM transactions
      WHERE cardholder_id = $1
        AND envelope_id = $2
        AND created_at >= $3
        AND kind = 'PURCHASE'
        AND status <> ALL ('{DECLINED,VOIDED,EXPIRED}')`,
    [cardholderId, envelopeId, sinceIso],
  )
  return r[0]?.spent_cents ?? 0
}
