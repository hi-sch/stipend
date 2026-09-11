import { useEffect, useMemo, useRef, useState } from 'react'
import { MCC_GROUPS, mccName } from '../data/mccs.js'

const EXTRA = [
  ['5816', 'Digital goods (blocked demo)'],
  ['7995', 'Betting (blocked demo)'],
]

export const MCC_OPTIONS = [
  ...MCC_GROUPS.flatMap((g) => g.codes.map(([code, name]) => ({ code, name, group: g.label }))),
  ...EXTRA.map(([code, name]) => ({ code, name, group: 'Restricted' })),
]

export default function MccSelect({ id, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrap = useRef(null)
  const selected = MCC_OPTIONS.find((o) => o.code === value)
  const label = selected ? `${selected.code} — ${selected.name}` : value

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return MCC_OPTIONS
    return MCC_OPTIONS.filter(
      (o) => o.code.includes(needle) || o.name.toLowerCase().includes(needle) || o.group.toLowerCase().includes(needle),
    )
  }, [q])

  useEffect(() => {
    function onDoc(e) {
      if (!wrap.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="mcc-select" ref={wrap}>
      <button
        id={id}
        type="button"
        className="mcc-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
      </button>
      {open && (
        <div className="mcc-select-menu" role="listbox">
          <input
            className="mcc-select-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search MCC or name"
            autoFocus
          />
          {filtered.map((o) => (
            <button
              key={o.code}
              type="button"
              role="option"
              aria-selected={o.code === value}
              className={o.code === value ? 'on' : ''}
              onClick={() => {
                onChange(o.code)
                setOpen(false)
                setQ('')
              }}
            >
              <strong>{o.code}</strong>
              <span>{o.name}</span>
            </button>
          ))}
          {!filtered.length && <p className="empty">No matching MCC</p>}
        </div>
      )}
    </div>
  )
}

export { mccName }
