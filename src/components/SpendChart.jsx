import { useState } from 'react'
import { eur } from '../lib/format.js'
import { useI18n } from '../i18n/I18n.jsx'

const W = 100
const H = 18
const PAD_Y = 1.5

export default function SpendChart({ chart }) {
  const { t } = useI18n()
  if (!chart?.layers?.length) {
    return <p className="empty">{t('dash.noSpend')}</p>
  }
  return (
    <div className="spend-chart">
      <SparkArea chart={chart} />
      <Axis ticks={chart.axis} n={chart.labels.length} kind={chart.kind} />
      <StackedBar chart={chart} />
      <Legend layers={chart.layers} />
    </div>
  )
}

function SparkArea({ chart }) {
  const { t } = useI18n()
  const { labels, layers, tips } = chart
  const n = labels.length
  const totals = labels.map((_, i) => layers.reduce((s, l) => s + l.values[i], 0))
  const peak = Math.max(1, ...totals)
  const [hover, setHover] = useState(null)
  const slot = n <= 1 ? W : W / (n - 1)
  const active = hover != null ? hover : null
  const summary = labels
    .map((label, i) => `${tips?.[i] || label}: ${eur(totals[i])}`)
    .join('. ')

  function move(delta) {
    setHover((i) => {
      const cur = i == null ? (delta > 0 ? -1 : n) : i
      return Math.max(0, Math.min(n - 1, cur + delta))
    })
  }

  return (
    <div className="spend-spark">
      <div className="spend-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={`${t('dash.spendChartAria')}. ${summary}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault()
              move(1)
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault()
              move(-1)
            }
            if (e.key === 'Escape') setHover(null)
          }}
          onBlur={() => setHover(null)}
        >
          <path
            d={linePath(totals, n, peak)}
            fill="none"
            stroke="#6b717c"
            strokeWidth="1.4"
            strokeLinejoin="miter"
            strokeLinecap="square"
            vectorEffect="non-scaling-stroke"
          />
          {active != null && n > 1 && (
            <line
              x1={xAt(active, n)}
              x2={xAt(active, n)}
              y1={PAD_Y}
              y2={H - PAD_Y}
              stroke="#6b717c"
              strokeWidth="0.4"
              opacity="0.4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {labels.map((_, i) => (
            <rect
              key={i}
              x={xAt(i, n) - slot / 2}
              y="0"
              width={slot}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
            />
          ))}
        </svg>
        {active != null && (
          <div
            className="spend-tip"
            role="status"
            style={{
              left: `${n <= 1 ? 50 : (active / (n - 1)) * 100}%`,
              transform: active === 0 ? 'translateX(0)' : active === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <strong>{tips?.[active] || labels[active]}</strong>
            <span>{eur(layers.reduce((s, l) => s + l.values[active], 0))}</span>
            {layers
              .filter((l) => l.values[active] > 0)
              .map((l) => (
                <div key={l.id}>
                  <i style={{ background: l.color }} />
                  {l.name} {eur(l.values[active])}
                </div>
              ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{t('dash.spendChartAria')}</caption>
        <thead>
          <tr>
            <th>{t('incoming.when')}</th>
            {layers.map((l) => (
              <th key={l.id}>{l.name}</th>
            ))}
            <th>{t('table.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={label + i}>
              <td>{tips?.[i] || label}</td>
              {layers.map((l) => (
                <td key={l.id}>{eur(l.values[i])}</td>
              ))}
              <td>{eur(totals[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Axis({ ticks, n, kind }) {
  if (!ticks?.length) return null
  return (
    <div className={`spend-axis spend-axis-${kind || 'week'}`}>
      {ticks.map((tick) => {
        const at = tick.at ?? 0
        const pct = n <= 1 ? 0 : (at / (n - 1)) * 100
        const edge = at === 0 ? 'start' : at === n - 1 ? 'end' : 'mid'
        return (
          <span key={`${tick.label}-${at}`} className="spend-tick" data-edge={edge} style={{ left: `${pct}%` }}>
            <i />
            {tick.label}
          </span>
        )
      })}
    </div>
  )
}

function StackedBar({ chart }) {
  const { t } = useI18n()
  const { layers, total } = chart
  const [hover, setHover] = useState(null)
  const segs = layers
    .map((layer) => ({ ...layer, cents: layer.values.reduce((a, b) => a + b, 0) }))
    .filter((l) => l.cents > 0)
  if (!total || !segs.length) {
    return (
      <div className="spend-hbar-wrap">
        <p className="empty" style={{ margin: 0 }}>
          {t('dash.noSpend')}
        </p>
      </div>
    )
  }
  const active = hover != null ? segs[hover] : null

  return (
    <div className="spend-hbar-wrap">
      <div className="spend-hbar" role="list" aria-label={t('dash.spendByEnvelope')}>
        {segs.map((layer, i) => (
          <button
            key={layer.id}
            type="button"
            className={`spend-hbar-seg ${hover === i ? 'on' : ''}`}
            style={{
              width: `${(layer.cents / total) * 100}%`,
              background: layer.color,
            }}
            aria-label={`${layer.name}: ${eur(layer.cents)}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </div>
      {active && (
        <div className="spend-tip spend-tip-bar" role="status">
          <strong>{active.name}</strong>
          <span>{eur(active.cents)}</span>
        </div>
      )}
    </div>
  )
}

function Legend({ layers }) {
  const segs = layers
    .map((layer) => ({ ...layer, cents: layer.values.reduce((a, b) => a + b, 0) }))
    .filter((l) => l.cents > 0)
  if (!segs.length) return <div className="spend-hbar-legend" />
  return (
    <div className="spend-hbar-legend">
      {segs.map((layer) => (
        <span key={layer.id}>
          <i style={{ background: layer.color }} />
          {layer.name} {eur(layer.cents)}
        </span>
      ))}
    </div>
  )
}

function xAt(i, n) {
  if (n <= 1) return 0
  return (i / (n - 1)) * W
}

function yAt(value, peak) {
  const usable = H - PAD_Y * 2
  return H - PAD_Y - (value / Math.max(peak, 1)) * usable
}

function linePath(values, n, peak) {
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i, n)} ${yAt(v, peak)}`).join(' ')
}
