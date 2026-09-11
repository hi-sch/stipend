import { MCC_BY_CODE } from '../data/mccs.js'

export function countryAllowed(envelope, country) {
  if (!envelope.countries?.length) return true
  if (!country) return false
  return envelope.countries.includes(country)
}

export function envelopeCovers(envelope, mcc, country) {
  const mccOk = envelope.mccs.includes(mcc) || envelope.mccs.length === 0
  return mccOk && countryAllowed(envelope, country)
}

export function envelopesCovering(envelopes, mcc, country) {
  const live = envelopes.filter((e) => e.balanceCents > 0)
  const exact = live.filter((e) => e.mccs.includes(mcc) && countryAllowed(e, country))
  if (exact.length) return sortOldest(exact)
  const open = live.filter((e) => e.mccs.length === 0 && countryAllowed(e, country))
  return sortOldest(open)
}

function sortOldest(list) {
  return [...list].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt))
}

export function authorizeSpend(envelopes, { amountCents, mcc, country }) {
  const covers = envelopesCovering(envelopes, mcc, country)
  if (!covers.length) {
    const mccLabel = MCC_BY_CODE[mcc] ? ` (${MCC_BY_CODE[mcc].name})` : ''
    const geo = country ? ` in ${country}` : ''
    return {
      approved: false,
      detailedResults: ['PROGRAM_USAGE_RESTRICTION', 'AUTH_RULE'],
      reason: `No envelope allows MCC ${mcc}${mccLabel}${geo}.`,
    }
  }
  const envelope = covers[0]
  if (envelope.balanceCents < amountCents) {
    return {
      approved: false,
      detailedResults: ['USER_TRANSACTION_LIMIT'],
      reason: `${envelope.connectionName} has ${formatLeft(envelope.balanceCents)} left for this category.`,
      envelopeId: envelope.id,
    }
  }
  return {
    approved: true,
    envelopeId: envelope.id,
    detailedResults: ['APPROVED'],
  }
}

function formatLeft(cents) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

export function lithicAuthRule(mccs, countries = []) {
  const rules = [
    {
      type: 'CONDITIONAL_ACTION',
      event_stream: 'AUTHORIZATION',
      state: 'ACTIVE',
      parameters: {
        action: 'DECLINE',
        conditions: [{ attribute: 'MCC', operation: 'IS_NOT_ONE_OF', value: mccs }],
      },
    },
  ]
  if (countries.length) {
    rules.push({
      type: 'CONDITIONAL_ACTION',
      event_stream: 'AUTHORIZATION',
      state: 'ACTIVE',
      parameters: {
        action: 'DECLINE',
        conditions: [{ attribute: 'COUNTRY', operation: 'IS_NOT_ONE_OF', value: countries }],
      },
    })
  }
  return rules
}
