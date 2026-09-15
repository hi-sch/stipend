import { eur, formatDate } from '../lib/format.js'
import { useI18n } from '../i18n/I18n.jsx'

export function nextCashReset({ periodStart, period }) {
  const d = new Date(periodStart)
  if (period === 'DAY') d.setUTCDate(d.getUTCDate() + 1)
  else if (period === 'WEEK') d.setUTCDate(d.getUTCDate() + 7)
  else d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString()
}

/** Cash limit of the rule a cardholder belongs to: what is left, a meter, and when it resets. */
export default function CashLimit({ usage }) {
  const { t } = useI18n()
  if (!usage) return null
  const period = t(`cash.period${usage.period}`)
  const pct = usage.limitCents ? Math.min(100, Math.round((usage.usedCents / usage.limitCents) * 100)) : 0
  const summary = t('cash.limitOf', { left: eur(usage.remainingCents), limit: eur(usage.limitCents), period })
  return (
    <div className="cash-limit">
      <div className="cash-limit-head">
        <strong>{t('cash.limitTitle')}</strong>
        <span>{summary}</span>
      </div>
      <div className="cash-meter" role="meter" aria-label={t('cash.limitTitle')} aria-valuemin={0} aria-valuemax={usage.limitCents} aria-valuenow={usage.usedCents} aria-valuetext={summary}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <small className="muted">{t('cash.usedResets', { used: eur(usage.usedCents), date: formatDate(nextCashReset(usage)) })}</small>
    </div>
  )
}
