import { CASH_PERIODS, cashPartOf, isCashMcc } from '../src/lib/cash.js'
import { wantsEmail } from '../src/lib/alerts.js'
import { authorizeSpend, envelopesCovering, DAILY_LIMIT_CENTS, toAsaResponse } from '../src/lib/auth.js'
import { makeIban } from '../src/lib/pain001.js'
import { createHash, randomUUID } from 'node:crypto'
import { postAllocation, postCredit, postRecall, postTransactionDelta } from './db/ledger.js'
import {
  applyBookedAmounts,
  applyEnvelopeDelta,
  cashUsedSince,
  creditExists,
  creditsFor,
  envelopesFor as envelopeRowsFor,
  getCardholder,
  getCardholderByCardToken,
  getCredit,
  getEnvelope,
  getTransaction,
  insertCredit,
  listConnections,
  recordRecall,
  transactionsFor,
  transactionsSince,
  upsertEnvelopeForCredit,
  upsertTransaction as upsertTransactionRow,
} from './db/repo.js'

/**
 * Business rules over the database.
 *
 * Every function that touches state takes the `client` of an open transaction and is
 * async. The synchronous draft-mutating versions are gone with the state document: a
 * write now locks the rows it needs instead of the whole program.
 *
 * Nothing here talks to Lithic, and nothing here sends email directly — notifications go
 * to the outbox table and are delivered separately. A transaction body may be retried
 * after a serialization failure, so it has to stay free of outside side effects.
 *
 * The decision engine itself (src/lib/auth.js) is untouched and still pure: it takes
 * plain arrays of envelopes and transactions, so it is shared with the browser and knows
 * nothing about storage.
 */

const PALETTE = ['#7C6CF0', '#C9894A', '#2F9E8A', '#3D7EDB', '#D46B8C', '#E0A21A', '#6E8B3D']
const CREDIT_KINDS = new Set(['RETURN', 'CREDIT_AUTHORIZATION', 'FINANCIAL_CREDIT_AUTHORIZATION', 'CREDIT_AUTHORIZATION_ADVICE'])

// Retention for the rolling logs that used to be kept short by slicing an array.
const NOTIFICATION_KEEP = 300
const CASE_KEEP = 500
const ASA_LOG_KEEP = 300

// ---------------------------------------------------------------- pure helpers

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export function virtualIbanFor(cardholderId) {
  const digits = BigInt(`0x${createHash('sha256').update(cardholderId).digest('hex').slice(0, 12)}`).toString().padStart(10, '0').slice(-10)
  return makeIban('DE', `50010517${digits}`)
}

export function formatEur(cents) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100)
}

export function cashPeriodStart(period, now = new Date()) {
  const d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  if (period === 'WEEK') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  if (period === 'MONTH') d.setUTCDate(1)
  return d
}

/** How much of the envelope this transaction should currently occupy (negative = refund). */
export function desiredDebit(txn) {
  if (['DECLINED', 'VOIDED', 'EXPIRED'].includes(txn.status)) return 0
  if (txn.kind === 'RETURN') return -Math.abs(txn.amountCents || 0)
  return Math.abs(txn.amountCents || 0)
}

function merchantOf(source = {}) {
  return {
    descriptor: source.descriptor || source.name || 'Unknown merchant',
    city: source.city || '',
    country: source.country || '',
    mcc: source.mcc || source.mcc_code || '',
  }
}

export function mapLithicTransaction(txn) {
  const events = (txn.events || []).map((e) => ({
    token: e.token,
    type: e.type,
    amount: Math.abs(e.amounts?.cardholder?.amount ?? e.amount ?? 0),
    result: e.result,
    detailedResults: e.detailed_results || [],
    ruleResults: e.rule_results || [],
    created: e.created,
  }))
  const isCredit = events.some((e) => CREDIT_KINDS.has(e.type)) && !events.some((e) => e.type === 'AUTHORIZATION')
  const approved = txn.result === 'APPROVED' && txn.status !== 'DECLINED'
  const settled = Math.abs(txn.amounts?.settlement?.amount || 0) || Math.abs(txn.amounts?.cardholder?.amount || 0)
  const held = Math.abs(txn.amounts?.hold?.amount || 0)
  const status = approved ? (['PENDING', 'SETTLED', 'VOIDED', 'EXPIRED'].includes(txn.status) ? txn.status : 'PENDING') : 'DECLINED'
  const amountCents = status === 'PENDING' ? held || settled || events[0]?.amount || 0 : settled || held || events[0]?.amount || 0
  const last = events[events.length - 1] || {}
  return {
    id: txn.token,
    cardToken: txn.card_token,
    created: txn.created,
    updated: txn.updated || last.created || txn.created,
    kind: isCredit ? 'RETURN' : 'PURCHASE',
    amountCents,
    currency: txn.amounts?.cardholder?.currency || 'USD',
    status,
    result: txn.result,
    detailedResults: last.detailedResults?.length ? last.detailedResults : [txn.result],
    ruleResults: events.flatMap((e) => e.ruleResults),
    events,
    merchant: merchantOf(txn.merchant),
    network: txn.network,
    live: true,
  }
}

function domainError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

// ---------------------------------------------------------------- lookups

export const holderById = (client, holderId) => getCardholder(client, holderId)
export const holderByCard = (client, cardToken) => getCardholderByCardToken(client, cardToken)
export const envelopesFor = (client, holderId, options) => envelopeRowsFor(client, holderId, options)

/** MCCs and countries the card should currently allow, from the funded envelopes. */
export async function allowlistFor(client, holderId) {
  const list = (await envelopesFor(client, holderId)).filter((e) => e.balanceCents > 0)
  return {
    mccs: [...new Set(list.flatMap((e) => e.mccs || []))].sort(),
    countries: [...new Set(list.flatMap((e) => e.countries || []))].sort(),
    unrestricted: list.some((e) => !(e.mccs || []).length),
  }
}

/**
 * Per-connection daily cap, as the function the engine expects. Connections are read once
 * and closed over, so the engine stays synchronous and does no I/O of its own.
 */
export async function dailyLimitFor(client) {
  const connections = await listConnections(client)
  const byId = new Map(connections.map((c) => [c.id, c]))
  return (envelope) => byId.get(envelope.connectionId)?.dailyLimitCents ?? DAILY_LIMIT_CENTS
}

// ---------------------------------------------------------------- notifications and cases

/**
 * Tell a cardholder something, and copy it to the outbox when they asked for that alert
 * type. Delivery happens elsewhere; this only queues.
 */
export async function notify(client, { holderId, title, body, kind = 'info', at = new Date().toISOString() }) {
  const note = { id: id('ntf'), holderId: holderId || null, title, body: body || '', kind, at }

  if (holderId) {
    await client.query(
      `INSERT INTO notifications (id, cardholder_id, title, body, kind, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [note.id, holderId, title, body || '', kind, at],
    )
    await client.query(
      `DELETE FROM notifications
        WHERE cardholder_id = $1
          AND id NOT IN (SELECT id FROM notifications WHERE cardholder_id = $1 ORDER BY created_at DESC LIMIT $2)`,
      [holderId, NOTIFICATION_KEEP],
    )

    const holder = await getCardholder(client, holderId)
    if (holder && wantsEmail(holder.prefs, kind)) {
      await client.query(
        `INSERT INTO email_outbox (id, to_address, subject, body, kind, status, next_attempt_at, created_at)
         VALUES ($1,$2,$3,$4,$5,'QUEUED',now(),$6)`,
        [id('mail'), holder.email, title, body || '', kind, at],
      )
    }
  }

  return note
}

export async function openCase(client, fields) {
  const row = {
    id: id('case'),
    status: 'OPEN',
    at: new Date().toISOString(),
    ...fields,
  }

  await client.query(
    `INSERT INTO cases (id, cardholder_id, transaction_id, kind, title, merchant, mcc, amount_cents,
                        detailed_results, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$10)`,
    [
      row.id,
      row.cardholderId ?? null,
      row.transactionId ?? null,
      row.kind ?? null,
      row.title,
      row.merchant ?? null,
      row.mcc ?? null,
      row.amountCents ?? null,
      row.detailedResults ?? [],
      row.at,
    ],
  )

  await client.query(
    `DELETE FROM cases WHERE id NOT IN (SELECT id FROM cases ORDER BY created_at DESC LIMIT $1)`,
    [CASE_KEEP],
  )

  return row
}

async function closeCasesFor(client, transactionId, resolution) {
  await client.query(
    `UPDATE cases SET status = 'CLOSED', resolution = $2, updated_at = now()
      WHERE transaction_id = $1 AND status <> 'CLOSED'`,
    [transactionId, resolution],
  )
}

// ---------------------------------------------------------------- credits

/** Match a credit line to a cardholder by explicit reference first, then by Stipend virtual IBAN. */
export async function resolveBeneficiary(client, { beneficiaryRef, iban }) {
  const ref = String(beneficiaryRef || '').trim()
  if (ref) {
    const { rows } = await client.query('SELECT * FROM cardholders WHERE beneficiary_ref = $1', [ref])
    if (rows.length) return getCardholder(client, rows[0].id)
  }

  const normalized = String(iban || '').replace(/\s/g, '').toUpperCase()
  if (normalized) {
    const { rows } = await client.query('SELECT * FROM cardholders WHERE iban = $1', [normalized])
    if (rows.length) return getCardholder(client, rows[0].id)
  }

  return null
}

export async function isDuplicateCredit(client, connectionId, endToEndId) {
  return Boolean(endToEndId) && (await creditExists(client, connectionId, endToEndId))
}

/**
 * Money arriving from a paying agency. The envelope is created on the first credit from a
 * connection and topped up after, and the movement is posted to the journal so the balance
 * stays provable.
 */
export async function applyCredit(client, { connection, holder, amountCents, endToEndId, remittance, purpose, protocol, msgId, transfer, now = new Date() }) {
  const at = now.toISOString()
  const existing = await envelopesFor(client, holder.id)
  const current = existing.find((e) => e.connectionId === connection.id)

  const envelope = await upsertEnvelopeForCredit(client, {
    id: current?.id ?? id('env'),
    cardholderId: holder.id,
    connection,
    amountCents,
    at,
    color: current?.color ?? PALETTE[existing.length % PALETTE.length],
    endToEndId,
    remittance,
  })

  const credit = await insertCredit(client, {
    id: id('crd'),
    created: at,
    connectionId: connection.id,
    cardholderId: holder.id,
    envelopeId: envelope.id,
    amountCents,
    currency: 'EUR',
    endToEndId,
    msgId: msgId || null,
    protocol: protocol || connection.protocol,
    purpose: purpose || connection.purpose,
    remittance: remittance || `Credit via ${connection.name}`,
    status: 'SETTLED',
    lithicTransfer: transfer || null,
  })

  await postCredit(client, { credit: { ...credit, amountCents }, envelope, connection, at, source: protocol || connection.protocol })

  await notify(client, {
    holderId: holder.id,
    title: `${connection.name} credited`,
    body: `${formatEur(amountCents)} · ${credit.remittance}`,
    kind: 'credit',
    at,
  })

  return credit
}

/**
 * Agency recall (camt.056). Takes back what is still unspent in the envelope; spent money
 * cannot be pulled from the cardholder, so the rest is reported as partially recalled.
 */
export async function recallCredit(client, { credit, reason, now = new Date() }) {
  const locked = await getCredit(client, credit.id, { forUpdate: true })
  if (!locked) throw domainError('Unknown credit', 404)
  if (locked.status === 'RECALLED') return { status: 'RJCR', reason: 'ARDT', detail: 'Already recalled', recalledCents: 0 }

  const envelope =
    (locked.envelopeId ? await getEnvelope(client, locked.envelopeId, { forUpdate: true }) : null) ??
    (await envelopesFor(client, locked.cardholderId, { forUpdate: true })).find((e) => e.connectionId === locked.connectionId) ??
    null

  const outstanding = locked.amountCents - (locked.recalledCents || 0)
  const available = Math.max(0, envelope?.balanceCents || 0)
  const take = Math.min(outstanding, available)

  if (take === 0) return { status: 'RJCR', reason: 'NOAS', detail: 'Envelope already spent', recalledCents: 0 }

  // A recall takes money out, which is the same direction as a spend.
  await applyEnvelopeDelta(client, envelope.id, take)

  const recalledTotal = (locked.recalledCents || 0) + take
  await recordRecall(client, {
    creditId: locked.id,
    recalledCents: recalledTotal,
    status: recalledTotal >= locked.amountCents ? 'RECALLED' : 'PARTIALLY_RECALLED',
    recall: { at: now.toISOString(), reason, recalledCents: take },
  })

  await postRecall(client, {
    credit: locked,
    envelopeId: envelope.id,
    takenCents: take,
    recalledTotalCents: recalledTotal,
    connectionId: locked.connectionId,
    cardholderId: locked.cardholderId,
    at: now.toISOString(),
  })

  await notify(client, {
    holderId: locked.cardholderId,
    title: 'Credit recalled by paying agency',
    body: `${formatEur(take)} returned (${reason}).`,
    kind: 'recall',
  })

  return { status: take === outstanding ? 'CNCL' : 'PDCR', reason: take === outstanding ? null : 'NOAS', recalledCents: take }
}

// ---------------------------------------------------------------- cash

export async function cashRuleById(client, ruleId) {
  if (!ruleId) return null
  const { rows } = await client.query('SELECT * FROM cash_rules WHERE id = $1', [ruleId])
  const r = rows[0]
  return r ? { id: r.id, name: r.name, limitCents: r.limit_cents, period: r.period, createdAt: r.created_at } : null
}

export async function listCashRules(client) {
  const { rows } = await client.query('SELECT * FROM cash_rules ORDER BY created_at')
  return rows.map((r) => ({ id: r.id, name: r.name, limitCents: r.limit_cents, period: r.period, createdAt: r.created_at }))
}

/** The cash state of a cardholder, whether or not cash was ever considered for them. */
export async function cashStateFor(client, holderId) {
  const { rows } = await client.query('SELECT * FROM cardholder_cash WHERE cardholder_id = $1', [holderId])
  const r = rows[0]
  if (!r) return { status: 'NONE' }
  return {
    status: r.status,
    ruleId: r.rule_id,
    requestedCents: r.requested_cents,
    requestedPeriod: r.requested_period,
    reason: r.reason,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    note: r.note,
  }
}

/** The cash rule a cardholder belongs to, or null when cash is off. */
export async function cashPolicyFor(client, holderId) {
  const cash = await cashStateFor(client, holderId)
  if (cash.status !== 'APPROVED') return null
  return cashRuleById(client, cash.ruleId)
}

export async function cashRuleMembers(client, ruleId) {
  const { rows } = await client.query(
    `SELECT c.id FROM cardholders c
       JOIN cardholder_cash cc ON cc.cardholder_id = c.id
      WHERE cc.status = 'APPROVED' AND cc.rule_id = $1
      ORDER BY c.created_at`,
    [ruleId],
  )
  return Promise.all(rows.map((r) => getCardholder(client, r.id)))
}

export async function cashUsageFor(client, holderId, now = new Date()) {
  const rule = await cashPolicyFor(client, holderId)
  if (!rule) return null

  const start = cashPeriodStart(rule.period, now)
  const usedCents = await cashUsedSince(client, holderId, start.toISOString())

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    usedCents,
    limitCents: rule.limitCents,
    period: rule.period,
    periodStart: start.toISOString(),
    remainingCents: Math.max(0, rule.limitCents - usedCents),
  }
}

/** Cardholder as shown in the apps: the cash block carries the limit of the rule they belong to. */
export async function withCash(client, holder) {
  if (!holder) return holder
  const cash = await cashStateFor(client, holder.id)
  const rule = cash.status === 'APPROVED' ? await cashRuleById(client, cash.ruleId) : null
  return {
    ...holder,
    cash: rule ? { ...cash, limitCents: rule.limitCents, period: rule.period, ruleName: rule.name } : cash,
  }
}

function validRule({ name, limitCents, period }) {
  const clean = String(name || '').trim().slice(0, 80)
  if (!clean) throw domainError('Give the cash rule a name.')
  if (!Number.isInteger(limitCents) || limitCents <= 0) throw domainError('Limit must be a positive number of cents.')
  if (!CASH_PERIODS.includes(period)) throw domainError('Period must be DAY, WEEK or MONTH.')
  return { name: clean, limitCents, period }
}

export async function createCashRule(client, fields, { now = new Date() } = {}) {
  const rule = validRule(fields)
  const ruleId = `cash_${randomUUID().slice(0, 8)}`
  await client.query(
    `INSERT INTO cash_rules (id, name, limit_cents, period, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [ruleId, rule.name, rule.limitCents, rule.period, now.toISOString()],
  )
  return cashRuleById(client, ruleId)
}

export async function updateCashRule(client, ruleId, fields, { now = new Date() } = {}) {
  const current = await cashRuleById(client, ruleId)
  if (!current) throw domainError('Unknown cash rule', 404)
  const rule = validRule({ ...current, ...fields })
  await client.query(
    `UPDATE cash_rules SET name = $2, limit_cents = $3, period = $4, updated_at = $5 WHERE id = $1`,
    [ruleId, rule.name, rule.limitCents, rule.period, now.toISOString()],
  )
  return cashRuleById(client, ruleId)
}

export async function deleteCashRule(client, ruleId) {
  if (!(await cashRuleById(client, ruleId))) throw domainError('Unknown cash rule', 404)
  const members = await cashRuleMembers(client, ruleId)
  if (members.length) throw domainError(`Remove the ${members.length} cardholder(s) from this rule first.`, 409)
  await client.query('DELETE FROM cash_rules WHERE id = $1', [ruleId])
}

export async function requestCash(client, holderId, { amountCents, period, reason, now = new Date() }) {
  const holder = await getCardholder(client, holderId)
  if (!holder) throw domainError('Unknown cardholder', 404)
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw domainError('Amount must be a positive number of cents.')
  if (!CASH_PERIODS.includes(period)) throw domainError('Period must be DAY, WEEK or MONTH.')

  const cash = await cashStateFor(client, holderId)
  if (cash.status === 'REQUESTED') throw domainError('A cash request is already waiting for review.', 409)
  if (cash.status === 'APPROVED') throw domainError('This card already has a cash budget. Ask your program to change it.', 409)

  await client.query(
    `INSERT INTO cardholder_cash (cardholder_id, status, requested_cents, requested_period, reason, requested_at)
     VALUES ($1,'REQUESTED',$2,$3,$4,$5)
     ON CONFLICT (cardholder_id) DO UPDATE
       SET status = 'REQUESTED', requested_cents = EXCLUDED.requested_cents,
           requested_period = EXCLUDED.requested_period, reason = EXCLUDED.reason,
           requested_at = EXCLUDED.requested_at, rule_id = NULL`,
    [holderId, amountCents, period, String(reason || '').slice(0, 500), now.toISOString()],
  )

  return cashStateFor(client, holderId)
}

export async function withdrawCashRequest(client, holderId) {
  const cash = await cashStateFor(client, holderId)
  if (cash.status !== 'REQUESTED') throw domainError('There is no pending cash request.', 409)
  await client.query(`UPDATE cardholder_cash SET status = 'NONE' WHERE cardholder_id = $1`, [holderId])
  return cashStateFor(client, holderId)
}

/** APPROVE adds the cardholder to a cash rule (or moves them to another); REJECT a request; REVOKE removes them. */
export async function decideCash(client, holderId, { decision, ruleId, note, actor, now = new Date() }) {
  const holder = await getCardholder(client, holderId)
  if (!holder) throw domainError('Unknown cardholder', 404)

  const cash = await cashStateFor(client, holderId)
  const stamp = [now.toISOString(), actor || null, String(note || '').slice(0, 500)]

  if (decision === 'APPROVE') {
    const rule = await cashRuleById(client, ruleId)
    if (!rule) throw domainError('Choose an existing cash rule.')
    if (cash.status === 'APPROVED' && cash.ruleId === rule.id) return cash

    await client.query(
      `INSERT INTO cardholder_cash (cardholder_id, status, rule_id, decided_at, decided_by, note)
       VALUES ($1,'APPROVED',$2,$3,$4,$5)
       ON CONFLICT (cardholder_id) DO UPDATE
         SET status = 'APPROVED', rule_id = EXCLUDED.rule_id, decided_at = EXCLUDED.decided_at,
             decided_by = EXCLUDED.decided_by, note = EXCLUDED.note`,
      [holderId, rule.id, ...stamp],
    )
    await notify(client, {
      holderId,
      title: 'Cash withdrawals enabled',
      body: `${formatEur(rule.limitCents)} per ${rule.period.toLowerCase()}${stamp[2] ? ` · ${stamp[2]}` : ''}`,
      kind: 'cash',
    })
  } else if (decision === 'REJECT') {
    if (cash.status !== 'REQUESTED') throw domainError('Only pending requests can be rejected.', 409)
    await client.query(
      `UPDATE cardholder_cash SET status = 'REJECTED', decided_at = $2, decided_by = $3, note = $4 WHERE cardholder_id = $1`,
      [holderId, ...stamp],
    )
    await notify(client, { holderId, title: 'Cash request declined', body: stamp[2], kind: 'cash' })
  } else if (decision === 'REVOKE') {
    if (cash.status !== 'APPROVED') throw domainError('Cash is not enabled for this cardholder.', 409)
    await client.query(
      `UPDATE cardholder_cash SET status = 'REVOKED', rule_id = NULL, decided_at = $2, decided_by = $3, note = $4 WHERE cardholder_id = $1`,
      [holderId, ...stamp],
    )
    await notify(client, { holderId, title: 'Cash withdrawals disabled', body: stamp[2], kind: 'cash' })
  } else {
    throw domainError('Decision must be APPROVE, REJECT or REVOKE.')
  }

  return cashStateFor(client, holderId)
}

/** Oldest envelope with enough money whose connection allows cash. */
export async function cashEnvelopeFor(client, holderId, cents) {
  const connections = await listConnections(client)
  const cashConnections = new Set(connections.filter((c) => c.cashAllowed).map((c) => c.id))

  return (await envelopesFor(client, holderId))
    .filter((e) => cashConnections.has(e.connectionId) && e.balanceCents >= cents)
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))[0]
}

/**
 * Authorization with a cash part (ATM withdrawal or purchase with cashback). The cash part
 * must fit the approved budget and comes from an envelope whose connection allows cash;
 * the rest follows the normal envelope rules.
 */
async function authorizeWithCash(client, holder, { amountCents, cashCents, merchant, envelopes, transactions, limitFor, now }) {
  if (holder.card?.state && holder.card.state !== 'OPEN') {
    return { approved: false, detailedResults: ['CARD_PAUSED'], asaResult: 'CARD_PAUSED', reason: 'Card is frozen.' }
  }

  const usage = await cashUsageFor(client, holder.id, now)
  if (!usage) {
    return { approved: false, detailedResults: ['CASH_NOT_ENABLED'], asaResult: 'UNAUTHORIZED_MERCHANT', reason: 'Cash withdrawals are not enabled for this card.' }
  }
  if (cashCents > usage.remainingCents) {
    return { approved: false, detailedResults: ['CASH_LIMIT_EXCEEDED'], asaResult: 'VELOCITY_EXCEEDED', reason: `Cash budget has ${formatEur(usage.remainingCents)} left.` }
  }

  const cashEnvelope = await cashEnvelopeFor(client, holder.id, cashCents)
  if (!cashEnvelope) {
    return { approved: false, detailedResults: ['INSUFFICIENT_FUNDS'], asaResult: 'INSUFFICIENT_FUNDS', reason: 'No envelope may be paid out as cash.' }
  }

  const goodsCents = amountCents - cashCents
  if (goodsCents <= 0) {
    return { approved: true, approvedAmountCents: amountCents, envelopeId: cashEnvelope.id, cashEnvelopeId: cashEnvelope.id, cashCents, detailedResults: ['APPROVED'], asaResult: 'APPROVED' }
  }

  // The cash part is already committed, so the goods decision sees the envelope without it.
  const remaining = envelopes.map((e) => (e.id === cashEnvelope.id ? { ...e, balanceCents: e.balanceCents - cashCents } : e))
  const goods = authorizeSpend(remaining, {
    amountCents: goodsCents,
    mcc: merchant.mcc,
    country: merchant.country,
    transactions,
    dailyLimitCents: limitFor,
    cardState: holder.card?.state,
    now,
  })

  if (!goods.approved) return goods
  return { ...goods, approvedAmountCents: amountCents, cashEnvelopeId: cashEnvelope.id, cashCents }
}

// ---------------------------------------------------------------- transactions

async function logAsa(client, entry) {
  await client.query(
    `INSERT INTO asa_log (at, cardholder_id, merchant, mcc, amount_cents, decision, response, source)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      entry.at,
      entry.cardholderId ?? null,
      entry.merchant.descriptor,
      entry.merchant.mcc,
      entry.amountCents,
      JSON.stringify(entry.decision ?? {}),
      JSON.stringify(entry.response ?? {}),
      entry.source ?? null,
    ],
  )
  await client.query(`DELETE FROM asa_log WHERE id NOT IN (SELECT id FROM asa_log ORDER BY at DESC LIMIT $1)`, [ASA_LOG_KEEP])
}

/**
 * Book the difference between what a transaction currently occupies and what it should.
 *
 * The journal is written first and is the record; the envelope balances are the projection
 * that follows it. A part with no envelope to carry it lands in unallocated, exactly as
 * the document version did, and reconciliation reports it.
 */
export async function settleDebit(client, txn, { at, source } = {}) {
  const total = desiredDebit(txn)
  // The cash part of a purchase is booked on its own envelope; refunds and reversals undo both parts.
  const cashTarget = txn.cashEnvelopeId && txn.kind !== 'RETURN' && total > 0 ? Math.min(txn.cashCents || 0, total) : 0
  const cashBooked = txn.cashDebitedCents || 0
  const goodsBooked = (txn.debitedCents || 0) - cashBooked
  const cashDelta = cashTarget - cashBooked
  const goodsDelta = total - cashTarget - goodsBooked

  if (!cashDelta && !goodsDelta) return 0

  await postTransactionDelta(client, {
    transactionId: txn.id,
    cardholderId: txn.cardholderId,
    envelopeId: txn.envelopeId,
    cashEnvelopeId: txn.cashEnvelopeId,
    goodsDelta,
    cashDelta,
    bookedTotal: total,
    bookedCash: cashTarget,
    at,
    kind: total < 0 ? 'REFUND' : 'SETTLEMENT',
    source,
  })

  let unallocatedDelta = 0
  if (goodsDelta) {
    const moved = txn.envelopeId ? await applyEnvelopeDelta(client, txn.envelopeId, goodsDelta) : null
    if (!moved) unallocatedDelta += goodsDelta
  }
  if (cashDelta) {
    const moved = txn.cashEnvelopeId ? await applyEnvelopeDelta(client, txn.cashEnvelopeId, cashDelta) : null
    if (!moved) unallocatedDelta += cashDelta
  }

  await applyBookedAmounts(client, {
    transactionId: txn.id,
    debitedCents: total,
    cashDebitedCents: txn.cashEnvelopeId || cashBooked ? cashTarget : 0,
    unallocatedDelta,
  })

  return cashDelta + goodsDelta
}

/** ASA decision plus local bookkeeping. Same engine serves real ASA posts and the sandbox simulator. */
export async function authorizeAsa(client, asa, { now = new Date(), source = 'asa' } = {}) {
  const token = asa.token || null

  // A replayed ASA post must return the same answer, not decide again.
  if (token) {
    const existing = await getTransaction(client, token)
    if (existing?.asaResponse) return existing.asaResponse
  }

  const cardToken = asa.card?.token || asa.card_token
  const holder = await holderByCard(client, cardToken)
  const merchant = merchantOf(asa.merchant)
  const amountCents = Math.abs(asa.amounts?.cardholder?.amount ?? asa.amount ?? 0)
  const status = asa.status || 'AUTHORIZATION'
  const at = now.toISOString()

  if (status === 'BALANCE_INQUIRY') {
    const total = holder ? (await envelopesFor(client, holder.id)).reduce((s, e) => s + Math.max(0, e.balanceCents), 0) : 0
    const response = { result: holder ? 'APPROVED' : 'UNAUTHORIZED_MERCHANT', ...(token ? { token } : {}), balance: { amount: total, available: total } }
    await logAsa(client, { at, merchant, amountCents, response, decision: { approved: Boolean(holder), reason: 'Balance inquiry' }, source, cardholderId: holder?.id })
    return response
  }

  if (CREDIT_KINDS.has(status)) {
    const response = { result: 'APPROVED', ...(token ? { token } : {}) }
    await logAsa(client, { at, merchant, amountCents, response, decision: { approved: true, reason: 'Credit authorization' }, source, cardholderId: holder?.id })
    return response
  }

  // Cash part: the whole amount for cash and quasi-cash merchants, otherwise Lithic's cash_amount (cashback).
  const cashCents = cashPartOf({ amountCents, mcc: merchant.mcc, cashAmount: asa.cash_amount ?? asa.cashback })

  let decision
  if (!holder) {
    decision = {
      approved: false,
      detailedResults: ['UNKNOWN_CARD'],
      asaResult: 'UNAUTHORIZED_MERCHANT',
      reason: 'Card is not managed by Stipend.',
    }
  } else {
    // Lock this cardholder's envelopes for the rest of the transaction. Two purchases on
    // the same card queue here; purchases on other cards are unaffected.
    const envelopes = await envelopesFor(client, holder.id, { forUpdate: true })
    // The engine's daily cap only looks at spend since local midnight, so that is all it
    // is given. Loading the cardholder's whole history here would grow without bound on a
    // path that has to answer inside the ASA deadline.
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const transactions = await transactionsSince(client, holder.id, dayStart.toISOString())
    const limitFor = await dailyLimitFor(client)

    decision =
      cashCents > 0
        ? await authorizeWithCash(client, holder, { amountCents, cashCents, merchant, envelopes, transactions, limitFor, now })
        : authorizeSpend(envelopes, {
            amountCents,
            mcc: merchant.mcc,
            country: merchant.country,
            transactions,
            dailyLimitCents: limitFor,
            cardState: holder.card?.state,
            partialApprovalCapable: Boolean(asa.pos?.terminal?.partial_approval_capable),
            now,
          })
  }

  const response = toAsaResponse(decision, asa)
  await logAsa(client, { at, merchant, amountCents, response, decision, source, cardholderId: holder?.id })

  if (holder) {
    const txn = await upsertTransactionRow(client, {
      id: token || id('txn'),
      cardholderId: holder.id,
      cardToken,
      created: at,
      merchant,
      kind: 'PURCHASE',
      requestedCents: amountCents,
      amountCents: decision.approved ? decision.approvedAmountCents ?? amountCents : amountCents,
      currency: 'EUR',
      status: decision.approved ? 'PENDING' : 'DECLINED',
      result: decision.approved ? 'APPROVED' : 'DECLINED',
      detailedResults: decision.detailedResults,
      envelopeId: decision.envelopeId ?? null,
      cashCents,
      cashEnvelopeId: decision.cashEnvelopeId ?? null,
      note: decision.approved ? (decision.partial ? decision.reason : null) : decision.reason,
      asaResult: decision.asaResult,
      asaResponse: response,
      source,
      live: Boolean(token),
    })

    await settleDebit(client, txn, { at, source })

    if (!decision.approved) {
      await openCase(client, {
        title: decision.asaResult === 'UNAUTHORIZED_MERCHANT' ? 'MCC restriction' : decision.asaResult,
        merchant: merchant.descriptor,
        mcc: merchant.mcc,
        amountCents,
        detailedResults: decision.detailedResults,
        cardholderId: holder.id,
        transactionId: txn.id,
      })
      await notify(client, { holderId: holder.id, title: `${merchant.descriptor || 'Purchase'} declined`, body: decision.reason, kind: 'decline', at })
    }
  }

  return response
}

/** Fold a Lithic transaction (webhook, sync or simulate) into local state. */
export async function reconcileTransaction(client, lithicTxn, { source = 'sync' } = {}) {
  const mapped = mapLithicTransaction(lithicTxn)
  const holder = await holderByCard(client, mapped.cardToken)
  const current = await getTransaction(client, mapped.id, { forUpdate: true })
  if (!holder && !current) return null

  const holderId = current?.cardholderId || holder.id
  let envelopeId = current?.envelopeId ?? null

  // Transactions seen without an ASA decision: cash categories are cash in full (Lithic's rules already capped them).
  const cash = current
    ? { cashCents: current.cashCents || 0, cashEnvelopeId: current.cashEnvelopeId || null }
    : mapped.kind === 'PURCHASE' && isCashMcc(mapped.merchant.mcc)
      ? { cashCents: mapped.amountCents, cashEnvelopeId: null }
      : { cashCents: 0, cashEnvelopeId: null }

  if (!current && cash.cashCents && mapped.status !== 'DECLINED') {
    cash.cashEnvelopeId = (await cashEnvelopeFor(client, holderId, cash.cashCents))?.id || null
    envelopeId = cash.cashEnvelopeId
  }

  if (!envelopeId && mapped.status !== 'DECLINED') {
    const envelopes = await envelopesFor(client, holderId, { forUpdate: true })
    if (mapped.kind === 'RETURN') {
      // Refunds go back to the envelope that paid this merchant; anything else waits for an operator.
      const { rows } = await client.query(
        `SELECT envelope_id, merchant FROM transactions
          WHERE cardholder_id = $1 AND kind = 'PURCHASE' AND envelope_id IS NOT NULL
            AND status <> ALL ('{DECLINED,VOIDED,EXPIRED}')
          ORDER BY created_at DESC`,
        [holderId],
      )
      const byDescriptor = rows.find((r) => r.merchant?.descriptor && r.merchant.descriptor === mapped.merchant.descriptor)
      const byMcc = rows.find((r) => r.merchant?.mcc === mapped.merchant.mcc)
      envelopeId = (byDescriptor ?? byMcc)?.envelope_id ?? null
    } else {
      const covers = envelopesCovering(envelopes, mapped.merchant.mcc, mapped.merchant.country)
      envelopeId = covers.find((e) => e.balanceCents >= mapped.amountCents)?.id || null
    }
  }

  const txn = await upsertTransactionRow(client, {
    ...mapped,
    cardholderId: holderId,
    envelopeId,
    ...cash,
    note: current?.note && mapped.status === current.status ? current.note : current?.note ?? null,
    asaResult: current?.asaResult,
    asaResponse: current?.asaResponse,
    requestedCents: current?.requestedCents ?? mapped.amountCents,
    source: current?.source || source,
  })

  const delta = await settleDebit(client, txn, { at: mapped.updated ?? mapped.created, source })
  const after = await getTransaction(client, txn.id)

  if (after.unallocatedCents && !current?.unallocatedCents && desiredDebit(after) < 0) {
    await client.query(`UPDATE transactions SET review = 'NEEDS_ENVELOPE' WHERE id = $1`, [after.id])
    await openCase(client, {
      title: 'Refund needs an envelope',
      kind: 'refund-review',
      merchant: after.merchant.descriptor,
      mcc: after.merchant.mcc,
      amountCents: after.amountCents,
      detailedResults: after.detailedResults,
      cardholderId: holderId,
      transactionId: after.id,
    })
  }

  if (after.unallocatedCents && !current?.unallocatedCents && desiredDebit(after) > 0) {
    await openCase(client, {
      title: 'Approved outside envelopes',
      merchant: after.merchant.descriptor,
      mcc: after.merchant.mcc,
      amountCents: after.amountCents,
      detailedResults: after.detailedResults,
      cardholderId: holderId,
      transactionId: after.id,
    })
  }

  if (current && current.status !== after.status) {
    const label = { VOIDED: 'reversed', EXPIRED: 'expired', SETTLED: 'settled', DECLINED: 'declined' }[after.status]
    if (label && after.status !== 'SETTLED') {
      await notify(client, {
        holderId,
        title: `${after.merchant.descriptor || 'Purchase'} ${label}`,
        body: delta < 0 ? `${formatEur(-delta)} back in your envelope.` : '',
        kind: 'transaction',
      })
    }
  }

  if (!current && after.kind === 'RETURN' && desiredDebit(after) < 0) {
    await notify(client, { holderId, title: `Refund from ${after.merchant.descriptor || 'merchant'}`, body: formatEur(after.amountCents), kind: 'refund' })
  }

  return after
}

/** Operator assigns an unallocated refund (or purchase) to one of the cardholder's envelopes. */
export async function allocateTransaction(client, { transactionId, envelopeId, actor }) {
  const txn = await getTransaction(client, transactionId, { forUpdate: true })
  if (!txn) throw domainError('Unknown transaction', 404)

  const envelope = await getEnvelope(client, envelopeId, { forUpdate: true })
  if (!envelope || envelope.cardholderId !== txn.cardholderId) {
    throw domainError('Envelope does not belong to this cardholder', 400)
  }

  const pending = txn.unallocatedCents || 0
  if (!pending) throw domainError('Nothing to allocate for this transaction', 409)

  await applyEnvelopeDelta(client, envelope.id, pending)
  await postAllocation(client, {
    transactionId: txn.id,
    cardholderId: txn.cardholderId,
    envelopeId: envelope.id,
    amountCents: pending,
    actor,
  })

  await client.query(
    `UPDATE transactions
        SET envelope_id = $2, unallocated_cents = 0, review = 'RESOLVED', allocated_by = $3, updated_at = now()
      WHERE id = $1`,
    [txn.id, envelope.id, actor || null],
  )

  await closeCasesFor(client, txn.id, `Allocated to ${envelope.connectionName}`)

  if (pending < 0) {
    await notify(client, {
      holderId: txn.cardholderId,
      title: `Refund from ${txn.merchant?.descriptor || 'merchant'}`,
      body: `${formatEur(-pending)} added to ${envelope.connectionName}.`,
      kind: 'refund',
    })
  }

  return getTransaction(client, txn.id)
}

// Re-exported so callers that only needed a list do not reach past this module.
export { creditsFor, transactionsFor }
