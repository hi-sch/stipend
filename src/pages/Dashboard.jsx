import { useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  BabyBottleIcon,
  Book02Icon,
  Bus01Icon,
  FlashIcon,
  HeartPulseIcon,
  Home01Icon,
  Plant01Icon,
  ShoppingBag01Icon,
  Sofa01Icon,
  TShirtIcon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons'
import PieEnvelopes from '../components/PieEnvelopes.jsx'
import CashLimit from '../components/CashLimit.jsx'
import CardFace from '../components/CardFace.jsx'
import SpendChart from '../components/SpendChart.jsx'
import TransactionTable, { TableTools } from '../components/TransactionTable.jsx'
import { useStore } from '../store.jsx'
import { eur } from '../lib/format.js'
import { mccGroupId } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'
import { getFormatLocale } from '../lib/format.js'

export default function Dashboard() {
  const { t, lang } = useI18n()
  const { envelopes, transactions, cardholder, cashUsage } = useStore()
  const [q, setQ] = useState('')
  const [range, setRange] = useState('week')

  const total = envelopes.reduce((s, e) => s + Math.max(0, e.balanceCents), 0)
  // The two tiles show the envelopes with the most money left.
  const ranked = useMemo(() => [...envelopes].sort((a, b) => b.balanceCents - a.balanceCents), [envelopes])
  const [primary, secondary] = ranked
  const recent = useMemo(() => dailySpend(transactions, 14), [transactions])
  const month = useMemo(() => monthSpend(transactions), [transactions])

  const names = Object.fromEntries(envelopes.map((e) => [e.id, e.connectionName]))

  const filtered = transactions.filter((t) => {
    const blob = `${t.merchant.descriptor} ${t.merchant.mcc}`.toLowerCase()
    return blob.includes(q.toLowerCase())
  })

  const chart = useMemo(() => periodChart(transactions, envelopes, range), [transactions, envelopes, range, lang])
  const top = useMemo(() => topMerchants(transactions), [transactions])
  const heat = useMemo(() => mccHeat(transactions), [transactions])

  return (
    <div className="dash">
      <p className="synth">{t('synth.amounts')}</p>
      <section className="kpis">
        <EnvelopeTile envelope={primary} tone="lilac" color="#5b4fe0" values={recent.byEnvelope[primary?.id]} spent={month.byEnvelope[primary?.id]} badge={t('dash.spendable')} />
        <EnvelopeTile envelope={secondary} tone="peach" color="#c9894a" values={recent.byEnvelope[secondary?.id]} spent={month.byEnvelope[secondary?.id]} badge={t('dash.earmarked')} />
        <article className="kpi dark">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={Wallet01Icon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>{t('dash.totalAvailable')}</h3>
          <div className="meta">{t('dash.totalMeta', { count: envelopes.length, amount: eur(month.total) })}</div>
          <div className="amount">{eur(total)}</div>
          <Spark color="#9aa0a8" values={recent.total} light />
          <div className="kpi-foot">
            <span>{t('dash.last14', { amount: eur(recent.total.reduce((a, b) => a + b, 0)) })}</span>
            <span>{cardholder.card?.lastFour || '····'}</span>
          </div>
        </article>
      </section>

      {cashUsage && (
        <section className="card" aria-label={t('cash.limitTitle')}>
          <CashLimit usage={cashUsage} />
        </section>
      )}

      <section className="grid-2 hero-pie">
        <div className="card">
          <div className="card-head">
            <h2>{t('dash.availableBy')}</h2>
          </div>
          <PieEnvelopes envelopes={envelopes} />
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 12 }}>
            {t('dash.pieHint')}
          </p>
        </div>
        <div className="card">
          <h2>{t('dash.card')}</h2>
          <CardFace card={cardholder.card || {}} holder={`${cardholder.firstName} ${cardholder.lastName}`} />
        </div>
      </section>

      <section className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>
                {range === 'day' ? t('dash.spendToday') : range === 'month' ? t('dash.spendMonth') : t('dash.spendWeek')}
              </h2>
              <div className="spend-total">{eur(chart.total)}</div>
            </div>
            <div className="seg">
              {['day', 'week', 'month'].map((k) => (
                <button key={k} className={range === k ? 'on' : ''} type="button" onClick={() => setRange(k)}>
                  {t(`common.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <SpendChart chart={chart} />
        </div>
        <div className="card">
          <h2>{t('dash.topMerchants')}</h2>
          {top.map((m) => (
            <div className="merchant-row" key={m.name}>
              <span>{m.name}</span>
              <span style={{ color: 'var(--muted)' }}>{t(`mccGroup.${m.groupId}`)}</span>
              <strong>{eur(m.amount)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('dash.recent')}</h2>
            <TableTools q={q} setQ={setQ} />
          </div>
          <TransactionTable rows={filtered.slice(0, 6)} envelopeName={(id) => names[id] || '—'} />
        </div>
        <div className="card">
          <h2>{t('dash.spendByCategory')}</h2>
          <p style={{ color: 'var(--muted)', marginTop: 0, fontSize: '0.85rem' }}>
            {t('dash.spendByCategoryHint')}
          </p>
          {heat.map((h) => (
            <div className="spend-row" key={h.id}>
              <div>
                <div className="label">{t(`mccGroup.${h.id}`)}</div>
                <div className="spend-track">
                  <div className="spend-fill" style={{ width: `${h.pct}%` }} />
                </div>
              </div>
              <div className="amt">{eur(h.cents)}</div>
            </div>
          ))}
          {!heat.length && <p className="empty">{t('dash.noSettled')}</p>}
        </div>
      </section>
    </div>
  )
}

const GROUP_ICONS = {
  food: ShoppingBag01Icon,
  housing: Home01Icon,
  health: HeartPulseIcon,
  transport: Bus01Icon,
  education: Book02Icon,
  childcare: BabyBottleIcon,
  energy: FlashIcon,
  clothing: TShirtIcon,
  household: Sofa01Icon,
  agri: Plant01Icon,
}

function dominantGroup(envelope) {
  const counts = {}
  for (const code of envelope?.mccs || []) counts[mccGroupId(code)] = (counts[mccGroupId(code)] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
}

function EnvelopeTile({ envelope, tone, color, values, spent, badge }) {
  const { t } = useI18n()
  const group = dominantGroup(envelope)
  return (
    <article className={`kpi ${tone}`}>
      <div className="kpi-head">
        <div className="kpi-ico">
          <HugeiconsIcon icon={GROUP_ICONS[group] || Wallet01Icon} size={18} color="currentColor" />
        </div>
      </div>
      <h3>{envelope?.connectionName || t('dash.noEnvelope')}</h3>
      <div className="meta">
        {envelope ? t('dash.tileMeta', { count: (envelope.mccs || []).length, group: t(`mccGroup.${group}`) }) : '\u00a0'}
      </div>
      <div className="amount">
        {eur(envelope?.balanceCents ?? 0)}
        {envelope && <span className="delta up">{badge}</span>}
      </div>
      <Spark color={color} values={values} />
      <div className="kpi-foot">
        <span>{t('dash.spentMonth', { amount: eur(spent ?? 0) })}</span>
        <span>{t('dash.namedEnvelope')}</span>
      </div>
    </article>
  )
}

/** 14-day spend sparkline; flat when nothing was spent. */
function Spark({ color, values = [], light }) {
  const W = 88
  const H = 28
  const list = values.length ? values : new Array(14).fill(0)
  const max = Math.max(0, ...list)
  const points = list.map((v, i) => [
    list.length === 1 ? W : (i / (list.length - 1)) * W,
    max ? H - 3 - (v / max) * (H - 8) : H - 4,
  ])
  const [lx, ly] = points[points.length - 1]
  return (
    <svg className="spark" width={W} height={H} viewBox={`-3 0 ${W + 6} ${H}`} aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" points={points.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')} />
      {light ? null : <circle cx={lx} cy={ly} r="3" fill={color} />}
    </svg>
  )
}

function counts(t) {
  return !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) && t.kind !== 'RETURN'
}

function dailySpend(transactions, days) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const byEnvelope = {}
  const total = new Array(days).fill(0)
  for (const t of transactions) {
    if (!counts(t)) continue
    const index = Math.floor((new Date(t.created) - start) / 86400000)
    if (index < 0 || index >= days) continue
    total[index] += t.amountCents
    if (t.envelopeId) {
      byEnvelope[t.envelopeId] = byEnvelope[t.envelopeId] || new Array(days).fill(0)
      byEnvelope[t.envelopeId][index] += t.amountCents
    }
  }
  return { byEnvelope, total }
}

function monthSpend(transactions) {
  const now = new Date()
  const byEnvelope = {}
  let total = 0
  for (const t of transactions) {
    const d = new Date(t.created)
    if (!counts(t) || d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) continue
    total += t.amountCents
    if (t.envelopeId) byEnvelope[t.envelopeId] = (byEnvelope[t.envelopeId] || 0) + t.amountCents
  }
  return { byEnvelope, total }
}

function inRange(t, start, end) {
  return !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) && t.kind !== 'RETURN' && t.created >= start && t.created < end
}

function periodChart(transactions, envelopes, range) {
  const buckets = makeBuckets(range)
  const windowStart = buckets[0].start
  const windowEnd = buckets[buckets.length - 1].end
  const live = transactions.filter((t) => inRange(t, windowStart, windowEnd))
  const total = live.reduce((s, t) => s + t.amountCents, 0)
  const layers = envelopes.map((e) => ({
    id: e.id,
    name: e.connectionName,
    color: e.color,
    values: buckets.map((b) =>
      live.filter((t) => t.envelopeId === e.id && t.created >= b.start && t.created < b.end).reduce((s, t) => s + t.amountCents, 0),
    ),
  }))

  const peak = layers[0]?.values?.length
    ? Math.max(1, ...layers[0].values.map((_, i) => layers.reduce((s, l) => s + (l.values[i] || 0), 0)))
    : 1
  return {
    kind: range,
    labels: buckets.map((b) => b.label),
    layers,
    peak,
    total,
    axis: axisTicks(range, buckets),
    tips: buckets.map((b) => b.tip),
  }
}

function axisTicks(range, buckets) {
  if (range === 'day') {
    return buckets.flatMap((b, at) => (at % 2 === 0 ? [{ label: b.label, at }] : []))
  }
  return buckets.map((b, at) => ({ label: b.label, at }))
}

function makeBuckets(range) {
  const now = new Date()
  if (range === 'day') {
    const origin = new Date(now)
    origin.setHours(0, 0, 0, 0)
    return [...Array(24)].map((_, i) => {
      const start = new Date(origin)
      start.setHours(i, 0, 0, 0)
      const end = new Date(origin)
      end.setHours(i + 1, 0, 0, 0)
      const from = String(i).padStart(2, '0')
      const to = String(i + 1).padStart(2, '0')
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        label: from,
        tip: `${from}–${to}`,
      }
    })
  }
  if (range === 'month') {
    const year = now.getFullYear()
    const month = now.getMonth()
    const days = new Date(year, month + 1, 0).getDate()
    return [...Array(days)].map((_, i) => {
      const start = new Date(year, month, i + 1)
      const end = new Date(year, month, i + 2)
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        label: String(i + 1),
        tip: start.toLocaleDateString(getFormatLocale(), { day: 'numeric', month: 'short' }),
      }
    })
  }
  return [...Array(7)].map((_, i) => {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (6 - i))
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: start.toLocaleDateString(getFormatLocale(), { weekday: 'short' }),
      tip: start.toLocaleDateString(getFormatLocale(), { weekday: 'short', day: 'numeric', month: 'short' }),
    }
  })
}

function topMerchants(transactions) {
  const map = new Map()
  transactions
    .filter((t) => !['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) && t.kind !== 'RETURN')
    .forEach((t) => {
      const cur = map.get(t.merchant.descriptor) || { name: t.merchant.descriptor, amount: 0, mcc: t.merchant.mcc }
      cur.amount += t.amountCents
      map.set(t.merchant.descriptor, cur)
    })
  return [...map.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 4)
    .map((m) => ({ ...m, groupId: mccGroupId(m.mcc) }))
}

function mccHeat(transactions) {
  const sums = new Map()
  transactions.forEach((t) => {
    if (['DECLINED', 'VOIDED', 'EXPIRED'].includes(t.status) || t.kind === 'RETURN') return
    const g = mccGroupId(t.merchant.mcc)
    sums.set(g, (sums.get(g) || 0) + t.amountCents)
  })
  const entries = [...sums.entries()].sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...entries.map(([, v]) => v))
  return entries.map(([id, cents]) => ({
    id,
    cents,
    pct: Math.round((cents / max) * 100),
  }))
}
