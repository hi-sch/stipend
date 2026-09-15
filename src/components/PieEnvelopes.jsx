import { useMemo, useState } from 'react'
import { eur, eurPlain } from '../lib/format.js'
import { mccName } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

const TAU = Math.PI * 2
const CX = 110
const CY = 110
const R = 78
const STROKE = 28
const SELECT_SCALE = 1.1

function polar(cx, cy, r, a) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function ringRadii(scale = 1) {
  const stroke = STROKE * scale
  return { rOuter: R + stroke / 2, rInner: R - stroke / 2, stroke }
}

function arcPath(start, end) {
  const a0 = start - Math.PI / 2
  const a1 = end - Math.PI / 2
  const large = end - start > Math.PI ? 1 : 0
  const [x0, y0] = polar(CX, CY, R, a0)
  const [x1, y1] = polar(CX, CY, R, a1)
  return `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`
}

function donutPath(start, end, scale = 1) {
  const span = Math.max(end - start, 0.02)
  const { rOuter, rInner } = ringRadii(scale)
  const a0 = start - Math.PI / 2
  const a1 = start + span - Math.PI / 2
  const large = span > Math.PI ? 1 : 0
  const [ox0, oy0] = polar(CX, CY, rOuter, a0)
  const [ox1, oy1] = polar(CX, CY, rOuter, a1)
  const [ix0, iy0] = polar(CX, CY, rInner, a0)
  const [ix1, iy1] = polar(CX, CY, rInner, a1)
  return `M ${ox0} ${oy0} A ${rOuter} ${rOuter} 0 ${large} 1 ${ox1} ${oy1} L ${ix1} ${iy1} A ${rInner} ${rInner} 0 ${large} 0 ${ix0} ${iy0} Z`
}

export default function PieEnvelopes({ envelopes, onSelect }) {
  const { tx, t } = useI18n()
  const [tip, setTip] = useState(null)
  const [active, setActive] = useState(null)
  const [focusId, setFocusId] = useState(null)

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
        {slices.map((s, i) => {
          const scale = active === s.id ? SELECT_SCALE : 1
          const wedge = donutPath(s.start, s.end === s.start ? s.start + 0.02 : s.end, scale)
          return (
          <g key={s.id}>
            <path
              className="pie-hit"
              d={wedge}
              fill={focusId === s.id ? `${s.color}33` : 'transparent'}
              tabIndex={0}
              role="button"
              aria-label={`${s.connectionName}: ${eur(s.balanceCents)}`}
              onClick={(e) => open(s, e)}
              onFocus={() => setFocusId(s.id)}
              onBlur={() => setFocusId((id) => (id === s.id ? null : id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  open(s, e)
                }
              }}
            >
              <title>{`${s.connectionName}: ${eur(s.balanceCents)}`}</title>
            </path>
            <path
              className="pie-pattern"
              d={arcPath(s.start, s.end === s.start ? s.start + 0.02 : s.end)}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE * scale}
              strokeDasharray={i === 0 ? undefined : i === 1 ? '6 4' : '2 5'}
              strokeLinecap="butt"
            />
            {focusId === s.id ? (
              <path className="pie-focus" d={wedge} />
            ) : null}
          </g>
          )
        })}
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
                {t('dash.merchantCodes', { count: (e.mccs || []).length })}
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
          <p>{tx("{0} left · {1} allowed MCCs", { 0: eur(tip.env.balanceCents), 1: (tip.env.mccs || []).length })}</p>
          <div className="chips">
            {(tip.env.mccs || []).slice(0, 10).map((code) => (
              <span className="chip dark" key={code}>
                {code} {mccName(code)}
              </span>
            ))}
            {(tip.env.mccs || []).length > 10 && (
              <span className="chip dark">{tx("+{0} more", { 0: (tip.env.mccs || []).length - 10 })}</span>
            )}
          </div>
        </div>
      )}
      {tip && (
        <button
          type="button"
          aria-label={tx("Dismiss MCC list")}
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
