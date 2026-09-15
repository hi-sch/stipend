import { MCC_BY_CODE } from '../data/mccs.js'

export function countryAllowed(envelope, country) {
  if (!envelope.countries?.length) return true
  if (!country) return false
  return envelope.countries.includes(country)
}

export function envelopeCovers(envelope, mcc, country) {
  const mccs = envelope.mccs || []
  const mccOk = mccs.includes(mcc) || mccs.length === 0
  return mccOk && countryAllowed(envelope, country)
}

export function envelopesCovering(envelopes, mcc, country) {
  const live = envelopes.filter((e) => e.balanceCents > 0)
  const exact = live.filter((e) => (e.mccs || []).includes(mcc) && countryAllowed(e, country))
  if (exact.length) return sortSpecificOldest(exact)
  const open = live.filter((e) => !(e.mccs || []).length && countryAllowed(e, country))
  return sortSpecificOldest(open)
}

// Most specific allowlist first (fewest MCCs), then oldest credit.
function sortSpecificOldest(list) {
  return [...list].sort(
    (a, b) => (a.mccs || []).length - (b.mccs || []).length || new Date(a.receivedAt) - new Date(b.receivedAt),
  )
}

export const DAILY_LIMIT_CENTS = 15000

export function spentToday(transactions, envelopeId, now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return (transactions || [])
    .filter(
      (t) =>
        t.envelopeId === envelopeId &&
        !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) &&
        t.kind !== 'RETURN' &&
        new Date(t.created) >= start,
    )
    .reduce((s, t) => s + (t.amountCents || 0) - (t.cashCents || 0), 0)
}

/**
 * Envelope decision for one authorization.
 * dailyLimitCents may be a number or a function (envelope) => cents, so each connection can cap spend.
 * With partialApprovalCapable, a purchase larger than the best envelope is approved for what it can pay.
 */
export function authorizeSpend(
  envelopes,
  { amountCents, mcc, country, transactions, dailyLimitCents = DAILY_LIMIT_CENTS, cardState, partialApprovalCapable = false, now = new Date() },
) {
  const limitFor = (envelope) =>
    typeof dailyLimitCents === 'function' ? dailyLimitCents(envelope) ?? DAILY_LIMIT_CENTS : dailyLimitCents
  if (cardState && cardState !== 'OPEN') {
    return {
      approved: false,
      detailedResults: [cardState === 'CLOSED' ? 'CARD_CLOSED' : 'CARD_PAUSED'],
      asaResult: 'CARD_PAUSED',
      reason: cardState === 'CLOSED' ? 'Card is closed.' : 'Card is frozen.',
    }
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      approved: false,
      detailedResults: ['INVALID_AMOUNT'],
      asaResult: 'UNAUTHORIZED_MERCHANT',
      reason: 'Amount must be a positive number.',
    }
  }
  const covers = envelopesCovering(envelopes, mcc, country)
  if (!covers.length) {
    const mccLabel = MCC_BY_CODE[mcc] ? ` (${MCC_BY_CODE[mcc].name})` : ''
    const geo = country ? ` in ${country}` : ''
    return {
      approved: false,
      detailedResults: ['PROGRAM_USAGE_RESTRICTION', 'AUTH_RULE'],
      asaResult: 'UNAUTHORIZED_MERCHANT',
      reason: `No envelope allows MCC ${mcc}${mccLabel}${geo}.`,
    }
  }
  // Spend from the first covering envelope that can pay in full; report the fullest one otherwise.
  const envelope =
    covers.find((e) => e.balanceCents >= amountCents) ||
    [...covers].sort((a, b) => b.balanceCents - a.balanceCents)[0]
  const todaySpent = spentToday(transactions, envelope.id, now)
  const limit = limitFor(envelope)
  const headroom = Math.max(0, limit - todaySpent)
  if (envelope.balanceCents < amountCents || headroom < amountCents) {
    const payable = Math.min(envelope.balanceCents, headroom)
    if (partialApprovalCapable && payable > 0) {
      return {
        approved: true,
        partial: true,
        approvedAmountCents: payable,
        envelopeId: envelope.id,
        detailedResults: ['APPROVED'],
        asaResult: 'APPROVED',
        reason: `${envelope.connectionName} approved ${formatLeft(payable)} of ${formatLeft(amountCents)}.`,
      }
    }
  }
  if (envelope.balanceCents < amountCents) {
    return {
      approved: false,
      detailedResults: ['USER_TRANSACTION_LIMIT'],
      asaResult: 'INSUFFICIENT_FUNDS',
      reason: `${envelope.connectionName} has ${formatLeft(envelope.balanceCents)} left for this category.`,
      envelopeId: envelope.id,
    }
  }
  if (todaySpent + amountCents > limit) {
    return {
      approved: false,
      detailedResults: ['VELOCITY_EXCEEDED'],
      asaResult: 'VELOCITY_EXCEEDED',
      reason: `${envelope.connectionName} would exceed the daily ${formatLeft(limit)} velocity cap.`,
      envelopeId: envelope.id,
    }
  }
  return {
    approved: true,
    approvedAmountCents: amountCents,
    envelopeId: envelope.id,
    detailedResults: ['APPROVED'],
    asaResult: 'APPROVED',
  }
}

const ASA_RESULTS = new Set([
  'APPROVED',
  'CHALLENGE',
  'SUSPECTED_FRAUD',
  'AVS_INVALID',
  'INSUFFICIENT_FUNDS',
  'DRIVER_NUMBER_INVALID',
  'VEHICLE_NUMBER_INVALID',
  'CARD_PAUSED',
  'UNAUTHORIZED_MERCHANT',
  'VELOCITY_EXCEEDED',
])

export function toAsaResponse(decision, asaRequest = {}) {
  let result = decision.approved ? 'APPROVED' : decision.asaResult || 'UNAUTHORIZED_MERCHANT'
  if (!ASA_RESULTS.has(result)) result = 'UNAUTHORIZED_MERCHANT'
  const response = { result }
  if (asaRequest.token) response.token = asaRequest.token
  if (decision.approved && decision.partial) response.approved_amount = decision.approvedAmountCents
  return response
}

function formatLeft(cents) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
