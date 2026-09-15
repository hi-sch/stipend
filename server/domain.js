import { CASH_PERIODS, cashPartOf, isCashMcc } from '../src/lib/cash.js'
import { wantsEmail } from '../src/lib/alerts.js'
import { authorizeSpend, envelopesCovering, DAILY_LIMIT_CENTS, toAsaResponse } from '../src/lib/auth.js'
import { makeIban } from '../src/lib/pain001.js'
import { createHash, randomUUID } from 'node:crypto'

// Pure business rules over the server state. Every function mutates the draft it is given
// (inside db.mutate) and never talks to Lithic.

const PALETTE = ['#7C6CF0', '#C9894A', '#2F9E8A', '#3D7EDB', '#D46B8C', '#E0A21A', '#6E8B3D']
const CREDIT_KINDS = new Set(['RETURN', 'CREDIT_AUTHORIZATION', 'FINANCIAL_CREDIT_AUTHORIZATION', 'CREDIT_AUTHORIZATION_ADVICE'])

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export function virtualIbanFor(cardholderId) {
  const digits = BigInt(`0x${createHash('sha256').update(cardholderId).digest('hex').slice(0, 12)}`).toString().padStart(10, '0').slice(-10)
  return makeIban('DE', `50010517${digits}`)
}

export function holderById(state, holderId) {
  return (state.cardholders || []).find((c) => c.id === holderId) || null
}

export function holderByCard(state, cardToken) {
  if (!cardToken) return null
  return (state.cardholders || []).find((c) => c.card?.token === cardToken) || null
}

export function envelopesFor(state, holderId) {
  return (state.envelopes || []).filter((e) => e.cardholderId === holderId)
}

export function allowlistFor(state, holderId) {
  const list = envelopesFor(state, holderId).filter((e) => e.balanceCents > 0)
  return {
    mccs: [...new Set(list.flatMap((e) => e.mccs || []))].sort(),
    countries: [...new Set(list.flatMap((e) => e.countries || []))].sort(),
    unrestricted: list.some((e) => !(e.mccs || []).length),
  }
}

export function dailyLimitFor(state) {
  return (envelope) => (state.connections || []).find((c) => c.id === envelope.connectionId)?.dailyLimitCents ?? DAILY_LIMIT_CENTS
}

export function notify(state, { holderId, title, body, kind = 'info', at = new Date().toISOString() }) {
  const note = { id: id('ntf'), holderId: holderId || null, title, body: body || '', kind, at, read: false }
  state.notifications = [note, ...(state.notifications || [])].slice(0, 300)
  const holder = holderId && holderById(state, holderId)
  if (holder && wantsEmail(holder.prefs, kind)) {
    state.emailOutbox = [
      { id: id('mail'), to: holder.email, subject: title, body: body || '', at, channel: 'smtp', status: 'queued', attempts: 0 },
      ...(state.emailOutbox || []),
    ].slice(0, 200)
  }
  return note
}

export function openCase(state, fields) {
  const row = { id: id('case'), status: 'OPEN', at: new Date().toISOString(), ...fields }
  state.cases = [row, ...(state.cases || [])].slice(0, 500)
  return row
}

/** Match a credit line to a cardholder by explicit reference first, then by Stipend virtual IBAN. */
export function resolveBeneficiary(state, { beneficiaryRef, iban }) {
  const ref = String(beneficiaryRef || '').trim()
  if (ref) {
    const byRef = (state.cardholders || []).find((c) => c.beneficiaryRef && c.beneficiaryRef === ref)
    if (byRef) return byRef
  }
  const normalized = String(iban || '').replace(/\s/g, '').toUpperCase()
  if (normalized) {
    const byIban = (state.cardholders || []).find((c) => c.iban === normalized)
    if (byIban) return byIban
  }
  return null
}

export function isDuplicateCredit(state, connectionId, endToEndId) {
  return Boolean(endToEndId) && (state.credits || []).some((c) => c.connectionId === connectionId && c.endToEndId === endToEndId)
}

export function applyCredit(state, { connection, holder, amountCents, endToEndId, remittance, purpose, protocol, msgId, transfer, now = new Date() }) {
  const at = now.toISOString()
  const credit = {
    id: id('crd'),
    created: at,
    connectionId: connection.id,
    cardholderId: holder.id,
    amountCents,
    recalledCents: 0,
    currency: 'EUR',
    endToEndId,
    msgId: msgId || null,
    protocol: protocol || connection.protocol,
    purpose: purpose || connection.purpose,
    remittance: remittance || `Credit via ${connection.name}`,
    status: 'SETTLED',
    lithicTransfer: transfer || null,
  }
  let envelope = (state.envelopes || []).find((e) => e.connectionId === connection.id && e.cardholderId === holder.id)
  if (envelope) {
    envelope.balanceCents += amountCents
    envelope.receivedAt = at
    envelope.mccs = connection.mccs
    envelope.countries = connection.countries || []
  } else {
    envelope = {
      id: id('env'),
      connectionId: connection.id,
      connectionName: connection.name,
      cardholderId: holder.id,
      balanceCents: amountCents,
      spentCents: 0,
      mccs: connection.mccs,
      countries: connection.countries || [],
      receivedAt: at,
      color: PALETTE[envelopesFor(state, holder.id).length % PALETTE.length],
    }
    state.envelopes = [envelope, ...(state.envelopes || [])]
  }
  credit.envelopeId = envelope.id
  state.credits = [credit, ...(state.credits || [])]
  notify(state, {
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
export function recallCredit(state, { credit, reason, now = new Date() }) {
  if (credit.status === 'RECALLED') return { status: 'RJCR', reason: 'ARDT', detail: 'Already recalled', recalledCents: 0 }
  const envelope = (state.envelopes || []).find((e) => e.id === credit.envelopeId) ||
    (state.envelopes || []).find((e) => e.connectionId === credit.connectionId && e.cardholderId === credit.cardholderId)
  const outstanding = credit.amountCents - (credit.recalledCents || 0)
  const available = Math.max(0, envelope?.balanceCents || 0)
  const take = Math.min(outstanding, available)
  if (envelope) envelope.balanceCents -= take
  credit.recalledCents = (credit.recalledCents || 0) + take
  credit.status = credit.recalledCents >= credit.amountCents ? 'RECALLED' : take > 0 ? 'PARTIALLY_RECALLED' : credit.status
  credit.recall = { at: now.toISOString(), reason, recalledCents: take }
  if (take > 0) {
    notify(state, {
      holderId: credit.cardholderId,
      title: 'Credit recalled by paying agency',
      body: `${formatEur(take)} returned (${reason}).`,
      kind: 'recall',
    })
  }
  if (take === 0) return { status: 'RJCR', reason: 'NOAS', detail: 'Envelope already spent', recalledCents: 0 }
  return { status: take === outstanding ? 'CNCL' : 'PDCR', reason: take === outstanding ? null : 'NOAS', recalledCents: take }
}

function merchantOf(source = {}) {
  return {
    descriptor: source.descriptor || '',
    city: source.city || '',
    country: source.country || '',
    mcc: source.mcc || '',
  }
}

// ---------- cash budget ----------

/** Start of the current cash window (UTC). Lithic's own cash velocity rules, in Eastern Time, stay authoritative. */
export function cashPeriodStart(period, now = new Date()) {
  const d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  if (period === 'WEEK') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  if (period === 'MONTH') d.setUTCDate(1)
  return d
}

function cashError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

export const cashRuleById = (state, ruleId) => (state.cashRules || []).find((r) => r.id === ruleId)

/** The cash rule a cardholder belongs to, or null when cash is off. */
export function cashPolicyFor(state, holderId) {
  const cash = holderById(state, holderId)?.cash
  if (cash?.status !== 'APPROVED') return null
  return cashRuleById(state, cash.ruleId) || null
}

export const cashRuleMembers = (state, ruleId) => (state.cardholders || []).filter((h) => h.cash?.status === 'APPROVED' && h.cash.ruleId === ruleId)

export function cashUsageFor(state, holderId, now = new Date()) {
  const rule = cashPolicyFor(state, holderId)
  if (!rule) return null
  const start = cashPeriodStart(rule.period, now)
  const usedCents = (state.transactions || [])
    .filter((t) => t.cardholderId === holderId && t.cashCents > 0 && !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) && new Date(t.created) >= start)
    .reduce((s, t) => s + t.cashCents, 0)
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
export function withCash(state, holder) {
  if (!holder) return holder
  const rule = holder.cash?.status === 'APPROVED' ? cashRuleById(state, holder.cash.ruleId) : null
  const cash = holder.cash ? { ...holder.cash, ...(rule ? { limitCents: rule.limitCents, period: rule.period, ruleName: rule.name } : {}) } : { status: 'NONE' }
  return { ...holder, cash }
}

function validRule({ name, limitCents, period }) {
  const clean = String(name || '').trim().slice(0, 80)
  if (!clean) throw cashError('Give the cash rule a name.')
  if (!Number.isInteger(limitCents) || limitCents <= 0) throw cashError('Limit must be a positive number of cents.')
  if (!CASH_PERIODS.includes(period)) throw cashError('Period must be DAY, WEEK or MONTH.')
  return { name: clean, limitCents, period }
}

export function createCashRule(state, fields, { now = new Date() } = {}) {
  const rule = { id: `cash_${randomUUID().slice(0, 8)}`, ...validRule(fields), createdAt: now.toISOString() }
  ;(state.cashRules ||= []).push(rule)
  return rule
}

export function updateCashRule(state, ruleId, fields, { now = new Date() } = {}) {
  const rule = cashRuleById(state, ruleId)
  if (!rule) throw cashError('Unknown cash rule', 404)
  Object.assign(rule, validRule({ ...rule, ...fields }), { updatedAt: now.toISOString() })
  return rule
}

export function deleteCashRule(state, ruleId) {
  if (!cashRuleById(state, ruleId)) throw cashError('Unknown cash rule', 404)
  const members = cashRuleMembers(state, ruleId)
  if (members.length) throw cashError(`Remove the ${members.length} cardholder(s) from this rule first.`, 409)
  state.cashRules = state.cashRules.filter((r) => r.id !== ruleId)
}

export function requestCash(state, holderId, { amountCents, period, reason, now = new Date() }) {
  const holder = holderById(state, holderId)
  if (!holder) throw cashError('Unknown cardholder', 404)
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw cashError('Amount must be a positive number of cents.')
  if (!CASH_PERIODS.includes(period)) throw cashError('Period must be DAY, WEEK or MONTH.')
  const status = holder.cash?.status
  if (status === 'REQUESTED') throw cashError('A cash request is already waiting for review.', 409)
  if (status === 'APPROVED') throw cashError('This card already has a cash budget. Ask your program to change it.', 409)
  holder.cash = {
    status: 'REQUESTED',
    requestedCents: amountCents,
    requestedPeriod: period,
    reason: String(reason || '').slice(0, 500),
    requestedAt: now.toISOString(),
  }
  return holder.cash
}

export function withdrawCashRequest(state, holderId) {
  const holder = holderById(state, holderId)
  if (holder?.cash?.status !== 'REQUESTED') throw cashError('There is no pending cash request.', 409)
  holder.cash = { ...holder.cash, status: 'NONE' }
  return holder.cash
}

/** APPROVE adds the cardholder to a cash rule (or moves them to another); REJECT a request; REVOKE removes them. */
export function decideCash(state, holderId, { decision, ruleId, note, actor, now = new Date() }) {
  const holder = holderById(state, holderId)
  if (!holder) throw cashError('Unknown cardholder', 404)
  const cash = holder.cash || { status: 'NONE' }
  const stamp = { decidedAt: now.toISOString(), decidedBy: actor || null, note: String(note || '').slice(0, 500) }
  if (decision === 'APPROVE') {
    const rule = cashRuleById(state, ruleId)
    if (!rule) throw cashError('Choose an existing cash rule.')
    if (cash.status === 'APPROVED' && cash.ruleId === rule.id) return cash
    holder.cash = { ...cash, ...stamp, status: 'APPROVED', ruleId: rule.id }
    notify(state, { holderId, title: 'Cash withdrawals enabled', body: `${formatEur(rule.limitCents)} per ${rule.period.toLowerCase()}${stamp.note ? ` · ${stamp.note}` : ''}`, kind: 'cash' })
  } else if (decision === 'REJECT') {
    if (cash.status !== 'REQUESTED') throw cashError('Only pending requests can be rejected.', 409)
    holder.cash = { ...cash, ...stamp, status: 'REJECTED' }
    notify(state, { holderId, title: 'Cash request declined', body: stamp.note, kind: 'cash' })
  } else if (decision === 'REVOKE') {
    if (cash.status !== 'APPROVED') throw cashError('Cash is not enabled for this cardholder.', 409)
    holder.cash = { ...cash, ...stamp, status: 'REVOKED', ruleId: null }
    notify(state, { holderId, title: 'Cash withdrawals disabled', body: stamp.note, kind: 'cash' })
  } else {
    throw cashError('Decision must be APPROVE, REJECT or REVOKE.')
  }
  return holder.cash
}

/** Oldest envelope with enough money whose connection allows cash. */
export function cashEnvelopeFor(state, holderId, cents) {
  const cashConnections = new Set((state.connections || []).filter((c) => c.cashAllowed).map((c) => c.id))
  return envelopesFor(state, holderId)
    .filter((e) => cashConnections.has(e.connectionId) && e.balanceCents >= cents)
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))[0]
}

/**
 * Authorization with a cash part (ATM withdrawal or purchase with cashback). The cash part must fit the
 * approved budget and comes from an envelope whose connection allows cash; the rest follows the
 * normal envelope rules.
 */
function authorizeWithCash(state, holder, { amountCents, cashCents, merchant, now }) {
  if (holder.card?.state && holder.card.state !== 'OPEN') {
    return { approved: false, detailedResults: ['CARD_PAUSED'], asaResult: 'CARD_PAUSED', reason: 'Card is frozen.' }
  }
  const usage = cashUsageFor(state, holder.id, now)
  if (!usage) {
    return { approved: false, detailedResults: ['CASH_NOT_ENABLED'], asaResult: 'UNAUTHORIZED_MERCHANT', reason: 'Cash withdrawals are not enabled for this card.' }
  }
  if (cashCents > usage.remainingCents) {
    return { approved: false, detailedResults: ['CASH_LIMIT_EXCEEDED'], asaResult: 'VELOCITY_EXCEEDED', reason: `Cash budget has ${formatEur(usage.remainingCents)} left.` }
  }
  const envelopes = envelopesFor(state, holder.id)
  const cashEnvelope = cashEnvelopeFor(state, holder.id, cashCents)
  if (!cashEnvelope) {
    return { approved: false, detailedResults: ['INSUFFICIENT_FUNDS'], asaResult: 'INSUFFICIENT_FUNDS', reason: 'No envelope may be paid out as cash.' }
  }
  const goodsCents = amountCents - cashCents
  if (goodsCents <= 0) {
    return { approved: true, approvedAmountCents: amountCents, envelopeId: cashEnvelope.id, cashEnvelopeId: cashEnvelope.id, cashCents, detailedResults: ['APPROVED'], asaResult: 'APPROVED' }
  }
  const remaining = envelopes.map((e) => (e.id === cashEnvelope.id ? { ...e, balanceCents: e.balanceCents - cashCents } : e))
  const goods = authorizeSpend(remaining, {
    amountCents: goodsCents,
    mcc: merchant.mcc,
    country: merchant.country,
    transactions: (state.transactions || []).filter((t) => t.cardholderId === holder.id),
    dailyLimitCents: dailyLimitFor(state),
    cardState: holder.card?.state,
    now,
  })
  if (!goods.approved) return goods
  return { ...goods, approvedAmountCents: amountCents, cashEnvelopeId: cashEnvelope.id, cashCents }
}

/** ASA decision + local bookkeeping. Same engine serves real ASA posts and the sandbox simulator. */
export function authorizeAsa(state, asa, { now = new Date(), source = 'asa' } = {}) {
  const token = asa.token || null
  const existing = token && (state.transactions || []).find((t) => t.id === token && t.asaResponse)
  if (existing) return existing.asaResponse

  const cardToken = asa.card?.token || asa.card_token
  const holder = holderByCard(state, cardToken)
  const merchant = merchantOf(asa.merchant)
  const amountCents = Math.abs(asa.amounts?.cardholder?.amount ?? asa.amount ?? 0)
  const status = asa.status || 'AUTHORIZATION'
  const at = now.toISOString()

  if (status === 'BALANCE_INQUIRY') {
    const total = holder ? envelopesFor(state, holder.id).reduce((s, e) => s + Math.max(0, e.balanceCents), 0) : 0
    const response = { result: holder ? 'APPROVED' : 'UNAUTHORIZED_MERCHANT', ...(token ? { token } : {}), balance: { amount: total, available: total } }
    logAsa(state, { at, merchant, amountCents, response, decision: { approved: Boolean(holder), reason: 'Balance inquiry' }, source })
    return response
  }

  if (CREDIT_KINDS.has(status)) {
    const response = { result: 'APPROVED', ...(token ? { token } : {}) }
    logAsa(state, { at, merchant, amountCents, response, decision: { approved: true, reason: 'Credit authorization' }, source })
    return response
  }

  // Cash part: the whole amount for cash and quasi-cash merchants, otherwise Lithic's cash_amount (cashback).
  const cashCents = cashPartOf({ amountCents, mcc: merchant.mcc, cashAmount: asa.cash_amount ?? asa.cashback })

  const decision = holder && cashCents > 0
    ? authorizeWithCash(state, holder, { amountCents, cashCents, merchant, now })
    : holder
    ? authorizeSpend(envelopesFor(state, holder.id), {
        amountCents,
        mcc: merchant.mcc,
        country: merchant.country,
        transactions: (state.transactions || []).filter((t) => t.cardholderId === holder.id),
        dailyLimitCents: dailyLimitFor(state),
        cardState: holder.card?.state,
        partialApprovalCapable: Boolean(asa.pos?.terminal?.partial_approval_capable),
        now,
      })
    : {
        approved: false,
        detailedResults: ['UNKNOWN_CARD'],
        asaResult: 'UNAUTHORIZED_MERCHANT',
        reason: 'Card is not managed by Stipend.',
      }
  const response = toAsaResponse(decision, asa)
  logAsa(state, { at, merchant, amountCents, response, decision, source, cardholderId: holder?.id })

  if (holder) {
    const txn = upsertTransaction(state, {
      id: token || id('txn'),
      cardholderId: holder.id,
      cardToken,
      created: at,
      updated: at,
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
    settleDebit(state, txn)
    if (!decision.approved) {
      openCase(state, {
        title: decision.asaResult === 'UNAUTHORIZED_MERCHANT' ? 'MCC restriction' : decision.asaResult,
        merchant: merchant.descriptor,
        mcc: merchant.mcc,
        amountCents,
        detailedResults: decision.detailedResults,
        cardholderId: holder.id,
        transactionId: txn.id,
      })
      notify(state, { holderId: holder.id, title: `${merchant.descriptor || 'Purchase'} declined`, body: decision.reason, kind: 'decline', at })
    }
  }
  return response
}

function logAsa(state, entry) {
  state.asaLog = [{ id: id('asa'), ...entry, merchant: entry.merchant.descriptor, mcc: entry.merchant.mcc }, ...(state.asaLog || [])].slice(0, 300)
}

function upsertTransaction(state, row) {
  const list = state.transactions || (state.transactions = [])
  const index = list.findIndex((t) => t.id === row.id)
  if (index === -1) {
    const txn = { debitedCents: 0, events: [], ...row }
    list.unshift(txn)
    return txn
  }
  Object.assign(list[index], row, { debitedCents: list[index].debitedCents || 0 })
  return list[index]
}

/** How much of the envelope this transaction should currently occupy (negative = refund). */
export function desiredDebit(txn) {
  if (['DECLINED', 'VOIDED', 'EXPIRED'].includes(txn.status)) return 0
  if (txn.kind === 'RETURN') return -Math.abs(txn.amountCents || 0)
  return Math.abs(txn.amountCents || 0)
}

/** Apply only the difference between what is booked and what should be booked, so replays are harmless. */
export function settleDebit(state, txn) {
  const total = desiredDebit(txn)
  // The cash part of a purchase is booked on its own envelope; refunds and reversals undo both parts.
  const cashTarget = txn.cashEnvelopeId && txn.kind !== 'RETURN' && total > 0 ? Math.min(txn.cashCents || 0, total) : 0
  const cashBooked = txn.cashDebitedCents || 0
  const goodsBooked = (txn.debitedCents || 0) - cashBooked
  const cashDelta = cashTarget - cashBooked
  const goodsDelta = total - cashTarget - goodsBooked
  bookDelta(state, txn, txn.cashEnvelopeId, cashDelta)
  bookDelta(state, txn, txn.envelopeId, goodsDelta)
  if (txn.cashEnvelopeId || cashBooked) txn.cashDebitedCents = cashTarget
  txn.debitedCents = total
  return cashDelta + goodsDelta
}

function bookDelta(state, txn, envelopeId, delta) {
  if (!delta) return
  const envelope = (state.envelopes || []).find((e) => e.id === envelopeId)
  if (!envelope) {
    txn.unallocatedCents = (txn.unallocatedCents || 0) + delta
    return
  }
  envelope.balanceCents -= delta
  envelope.spentCents = Math.max(0, (envelope.spentCents || 0) + delta)
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

/** Fold a Lithic transaction (webhook, sync or simulate) into local state. */
export function reconcileTransaction(state, lithicTxn, { source = 'sync' } = {}) {
  const mapped = mapLithicTransaction(lithicTxn)
  const holder = holderByCard(state, mapped.cardToken)
  const current = (state.transactions || []).find((t) => t.id === mapped.id)
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
    cash.cashEnvelopeId = cashEnvelopeFor(state, holderId, cash.cashCents)?.id || null
    envelopeId = cash.cashEnvelopeId
  }
  if (!envelopeId && mapped.status !== 'DECLINED') {
    const covers = envelopesCovering(envelopesFor(state, holderId), mapped.merchant.mcc, mapped.merchant.country)
    if (mapped.kind === 'RETURN') {
      // Refunds go back to the envelope that paid this merchant; anything else waits for an operator.
      const same = (t) => t.cardholderId === holderId && t.kind === 'PURCHASE' && t.envelopeId && !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status)
      const previous =
        (state.transactions || []).find((t) => same(t) && t.merchant?.descriptor && t.merchant.descriptor === mapped.merchant.descriptor) ||
        (state.transactions || []).find((t) => same(t) && t.merchant?.mcc === mapped.merchant.mcc)
      envelopeId = previous?.envelopeId || null
    } else {
      envelopeId = covers.find((e) => e.balanceCents >= mapped.amountCents)?.id || null
    }
  }
  const txn = upsertTransaction(state, {
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
  const delta = settleDebit(state, txn)
  if (txn.unallocatedCents && !current?.unallocatedCents && desiredDebit(txn) < 0) {
    txn.review = 'NEEDS_ENVELOPE'
    openCase(state, {
      title: 'Refund needs an envelope',
      kind: 'refund-review',
      merchant: txn.merchant.descriptor,
      mcc: txn.merchant.mcc,
      amountCents: txn.amountCents,
      detailedResults: txn.detailedResults,
      cardholderId: holderId,
      transactionId: txn.id,
    })
  }
  if (txn.unallocatedCents && !current?.unallocatedCents && desiredDebit(txn) > 0) {
    openCase(state, {
      title: 'Approved outside envelopes',
      merchant: txn.merchant.descriptor,
      mcc: txn.merchant.mcc,
      amountCents: txn.amountCents,
      detailedResults: txn.detailedResults,
      cardholderId: holderId,
      transactionId: txn.id,
    })
  }
  if (current && current.status !== txn.status) {
    const label = { VOIDED: 'reversed', EXPIRED: 'expired', SETTLED: 'settled', DECLINED: 'declined' }[txn.status]
    if (label && txn.status !== 'SETTLED') {
      notify(state, {
        holderId,
        title: `${txn.merchant.descriptor || 'Purchase'} ${label}`,
        body: delta < 0 ? `${formatEur(-delta)} back in your envelope.` : '',
        kind: 'transaction',
      })
    }
  }
  if (!current && txn.kind === 'RETURN' && desiredDebit(txn) < 0) {
    notify(state, { holderId, title: `Refund from ${txn.merchant.descriptor || 'merchant'}`, body: formatEur(txn.amountCents), kind: 'refund' })
  }
  return txn
}

/** Operator assigns an unallocated refund (or purchase) to one of the cardholder's envelopes. */
export function allocateTransaction(state, { transactionId, envelopeId, actor }) {
  const txn = (state.transactions || []).find((t) => t.id === transactionId)
  if (!txn) throw Object.assign(new Error('Unknown transaction'), { status: 404 })
  const envelope = (state.envelopes || []).find((e) => e.id === envelopeId && e.cardholderId === txn.cardholderId)
  if (!envelope) throw Object.assign(new Error('Envelope does not belong to this cardholder'), { status: 400 })
  const pending = txn.unallocatedCents || 0
  if (!pending) throw Object.assign(new Error('Nothing to allocate for this transaction'), { status: 409 })
  envelope.balanceCents -= pending
  envelope.spentCents = Math.max(0, (envelope.spentCents || 0) + pending)
  txn.envelopeId = envelope.id
  txn.unallocatedCents = 0
  txn.review = 'RESOLVED'
  txn.allocatedBy = actor || null
  for (const c of state.cases || []) {
    if (c.transactionId === txn.id && c.status !== 'CLOSED') {
      c.status = 'CLOSED'
      c.resolution = `Allocated to ${envelope.connectionName}`
    }
  }
  if (pending < 0) {
    notify(state, { holderId: txn.cardholderId, title: `Refund from ${txn.merchant?.descriptor || 'merchant'}`, body: `${formatEur(-pending)} added to ${envelope.connectionName}.`, kind: 'refund' })
  }
  return txn
}

export function formatEur(cents) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100)
}
