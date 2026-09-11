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
  const { labels, layers, tips } = chart
  const n = labels.length
  const totals = labels.map((_, i) => layers.reduce((s, l) => s + l.values[i], 0))
  const peak = Math.max(1, ...totals)
  const [hover, setHover] = useState(null)
  const slot = n <= 1 ? W : W / (n - 1)

  return (
    <div className="spend-spark">
      <div className="spend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Spend over time">
          <path
            d={linePath(totals, n, peak)}
            fill="none"
            stroke="#6b717c"
            strokeWidth="1.4"
            strokeLinejoin="miter"
            strokeLinecap="square"
            vectorEffect="non-scaling-stroke"
          />
          {hover != null && n > 1 && (
            <line
              x1={xAt(hover, n)}
              x2={xAt(hover, n)}
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
            />
          ))}
        </svg>
        {hover != null && (
          <div
            className="spend-tip"
            style={{
              left: `${n <= 1 ? 50 : (hover / (n - 1)) * 100}%`,
              transform: hover === 0 ? 'translateX(0)' : hover === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <strong>{tips?.[hover] || labels[hover]}</strong>
            <span>{eur(layers.reduce((s, l) => s + l.values[hover], 0))}</span>
            {layers
              .filter((l) => l.values[hover] > 0)
              .map((l) => (
                <div key={l.id}>
                  <i style={{ background: l.color }} />
                  {l.name} {eur(l.values[hover])}
                </div>
              ))}
          </div>
        )}
      </div>
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
      <div className="spend-hbar" role="img" aria-label="Spend by envelope">
        {segs.map((layer, i) => (
          <div
            key={layer.id}
            className={`spend-hbar-seg ${hover === i ? 'on' : ''}`}
            style={{
              width: `${(layer.cents / total) * 100}%`,
              background: layer.color,
            }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>
      {active && (
        <div className="spend-tip spend-tip-bar">
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
