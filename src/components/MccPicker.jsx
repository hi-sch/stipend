import { useMemo, useState } from 'react'
import { MCC_GROUPS, PRESETS, codesForGroups } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function MccPicker({ value, onChange }) {
  const { tx } = useI18n()
  const [q, setQ] = useState('')
  const selected = new Set(value)

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return MCC_GROUPS
    return MCC_GROUPS.map((g) => ({
      ...g,
      codes: g.codes.filter(
        ([code, name]) => code.includes(query) || name.toLowerCase().includes(query) || g.label.toLowerCase().includes(query),
      ),
    })).filter((g) => g.codes.length)
  }, [q])

  function toggle(code) {
    const next = new Set(selected)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    onChange([...next])
  }

  function applyPreset(key) {
    onChange(codesForGroups(PRESETS[key].groups))
  }

  function toggleGroup(group) {
    const codes = group.codes.map(([c]) => c)
    const allOn = codes.every((c) => selected.has(c))
    const next = new Set(selected)
    codes.forEach((c) => (allOn ? next.delete(c) : next.add(c)))
    onChange([...next])
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(PRESETS).map(([key, p]) => (
          <button key={key} type="button" className="btn ghost" onClick={() => applyPreset(key)}>
            {p.label}
          </button>
        ))}
        <button type="button" className="btn ghost" onClick={() => onChange([])}>{tx("Clear")}</button>
      </div>
      <label className="search" style={{ marginBottom: 12, display: 'flex' }}>
        <span style={{ color: 'var(--muted)' }}>{tx("Find MCC")}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("5411 or grocery")} />
      </label>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{selected.size}{' '}{tx("codes allowed")}</p>
      {groups.map((g) => (
        <div className="group" key={g.id}>
          <h3>
            <span>{g.label}</span>
            <button type="button" className="btn ghost" onClick={() => toggleGroup(g)}>{tx("Toggle group")}</button>
          </h3>
          <div className="mcc-grid">
            {g.codes.map(([code, name]) => (
              <button
                key={code}
                type="button"
                className={`mcc-opt ${selected.has(code) ? 'on' : ''}`}
                onClick={() => toggle(code)}
              >
                {code} {name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
