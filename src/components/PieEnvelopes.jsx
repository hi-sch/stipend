import { useMemo, useState } from 'react'
import { eur, eurPlain } from '../lib/format.js'
import { mccName } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

const TAU = Math.PI * 2
const CX = 110
const CY = 110
const R = 78
const STROKE = 28

function polar(cx, cy, r, a) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function arcPath(start, end) {
  const a0 = start - Math.PI / 2
  const a1 = end - Math.PI / 2
  const [x0, y0] = polar(CX, CY, R, a0)
  const [x1, y1] = polar(CX, CY, R, a1)
  const large = end - start > Math.PI ? 1 : 0
  return `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`
}

export default function PieEnvelopes({ envelopes, onSelect }) {
  const { t } = useI18n()
  const [tip, setTip] = useState(null)
  const [active, setActive] = useState(null)

  const total = envelopes.reduce((s, e) => s + e.balanceCents, 0)
  const slices = useMemo(() => {
    let cursor = 0
    return envelopes
      .filter((e) => e.balanceCents > 0)
      .map((e) => {
        const frac = total ? e.balanceCents / total : 0
        const start = cursor * TAU
        cursor += frac
        const end = cursor * TAU
        return { ...e, frac, start, end }
      })
  }, [envelopes, total])

  function open(env, event) {
    setActive(env.id)
    onSelect?.(env)
    const r = event.currentTarget.getBoundingClientRect?.()
    const x = event.clientX ?? (r ? r.left + r.width / 2 : 0)
    const y = event.clientY ?? (r ? r.top : 0)
    setTip({ env, x: Math.min(x + 12, window.innerWidth - 360), y: y + 12 })
  }

  return (
    <div className="pie-wrap">
      <svg className="pie-svg" viewBox="0 0 220 220" role="img" aria-label={t('dash.availableBy')}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#eceef2" strokeWidth={STROKE} />
        {slices.map((s) => (
          <path
            key={s.id}
            d={arcPath(s.start, s.end === s.start ? s.start + 0.02 : s.end)}
            fill="none"
            stroke={s.color}
            strokeWidth={active === s.id ? STROKE + 6 : STROKE}
            strokeLinecap="butt"
            style={{ cursor: 'pointer' }}
            onClick={(e) => open(s, e)}
          >
            <title>{`${s.connectionName}: ${eur(s.balanceCents)}`}</title>
          </path>
        ))}
        <text x={CX} y={CY - 6} textAnchor="middle" fontSize="13" fill="#6b717c">
          {t('dash.available')}
        </text>
        <text x={CX} y={CY + 18} textAnchor="middle" fontSize="18" fontWeight="700" fill="#141416">
          {eurPlain(total)}
        </text>
      </svg>
      <div className="legend">
        {envelopes.map((e) => (
          <button
            key={e.id}
            type="button"
            className={active === e.id ? 'on' : ''}
            onClick={(ev) => open(e, ev)}
          >
            <span className="swatch" style={{ background: e.color }} />
            <span>
              <span className="name">{e.connectionName}</span>
              <span className="mccs">
                {t('dash.merchantCodes', { count: e.mccs.length })}
              </span>
            </span>
            <span className="amt">{eur(e.balanceCents)}</span>
          </button>
        ))}
      </div>
      {tip && (
        <div
          className="tooltip"
          style={{ left: tip.x, top: tip.y }}
          role="status"
        >
          <h4>{tip.env.connectionName}</h4>
          <p>
            {eur(tip.env.balanceCents)} left · {tip.env.mccs.length} allowed MCCs
          </p>
          <div className="chips">
            {tip.env.mccs.slice(0, 10).map((code) => (
              <span className="chip dark" key={code}>
                {code} {mccName(code)}
              </span>
            ))}
            {tip.env.mccs.length > 10 && (
              <span className="chip dark">+{tip.env.mccs.length - 10} more</span>
            )}
          </div>
        </div>
      )}
      {tip && (
        <button
          type="button"
          aria-label="Dismiss MCC list"
          onClick={() => {
            setTip(null)
            setActive(null)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            border: 0,
            zIndex: 30,
          }}
        />
      )}
    </div>
  )
}
