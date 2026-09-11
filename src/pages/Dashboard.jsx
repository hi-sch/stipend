import { useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ShoppingBag01Icon, Home01Icon, HeartPulseIcon } from '@hugeicons/core-free-icons'
import PieEnvelopes from '../components/PieEnvelopes.jsx'
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
  const { envelopes, transactions, cardholder } = useStore()
  const [q, setQ] = useState('')
  const [range, setRange] = useState('week')

  const total = envelopes.reduce((s, e) => s + e.balanceCents, 0)
  const spent = envelopes.reduce((s, e) => s + e.spentCents, 0)
  const food = envelopes.find((e) => e.connectionId === 'de-jobcenter')
  const housing = envelopes.find((e) => e.connectionId === 'de-wohngeld')
  const health = envelopes.find((e) => e.connectionId === 'de-gkv')

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
        <article className="kpi lilac">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={ShoppingBag01Icon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>Jobcenter Bürgergeld</h3>
          <div className="meta">{t('dash.livingCosts', { count: food?.mccs.length ?? 0 })}</div>
          <div className="amount">
            {eur(food?.balanceCents ?? 0)}
            <span className="delta up">{t('dash.spendable')}</span>
          </div>
          <Spark color="#5b4fe0" />
          <div className="kpi-foot">
            <span>{t('dash.spent', { amount: eur(food?.spentCents ?? 0) })}</span>
            <span>{t('dash.foodHousehold')}</span>
          </div>
        </article>
        <article className="kpi peach">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={Home01Icon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>Wohngeldstelle</h3>
          <div className="meta">{t('dash.rentHousing', { count: housing?.mccs.length ?? 0 })}</div>
          <div className="amount">
            {eur(housing?.balanceCents ?? 0)}
            <span className="delta up">{t('dash.earmarked')}</span>
          </div>
          <Spark color="#c9894a" />
          <div className="kpi-foot">
            <span>{t('dash.rentPending')}</span>
            <span>MCC 6513</span>
          </div>
        </article>
        <article className="kpi dark">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={HeartPulseIcon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>{t('dash.totalAvailable')}</h3>
          <div className="meta">
            {t('dash.envelopesHealth', { count: envelopes.length, amount: eur(health?.balanceCents ?? 0) })}
          </div>
          <div className="amount">{eur(total)}</div>
          <Spark color="#9aa0a8" light />
          <div className="kpi-foot">
            <span>{t('dash.spentPeriod', { amount: eur(spent) })}</span>
            <span>{cardholder.card.lastFour}</span>
          </div>
        </article>
      </section>

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
          <CardFace card={cardholder.card} holder={`${cardholder.firstName} ${cardholder.lastName}`} />
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

function Spark({ color, light }) {
  return (
    <svg className="spark" width="88" height="28" viewBox="0 0 88 28" aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        points="0,18 12,16 24,20 36,10 48,14 60,8 72,12 88,6"
      />
      {light ? null : <circle cx="88" cy="6" r="3" fill={color} />}
    </svg>
  )
}

function inRange(t, start, end) {
  return t.status !== 'DECLINED' && t.created >= start && t.created < end
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

  const peak = Math.max(
    1,
    ...layers[0].values.map((_, i) => layers.reduce((s, l) => s + l.values[i], 0)),
  )
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
    .filter((t) => t.status !== 'DECLINED')
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
    if (t.status === 'DECLINED') return
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
