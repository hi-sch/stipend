import { SPEND_COUNTRIES } from '../data/agencies.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function CountryPicker({ value, onChange }) {
  const { tx } = useI18n()
  const selected = new Set(value)

  function toggle(code) {
    const next = new Set(selected)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    onChange([...next])
  }

  return (
    <div>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>{tx("Empty means no country restriction. Lithic matches ISO 3166-1 alpha-3 on the card acceptor.")}</p>
      <div className="mcc-grid">
        {SPEND_COUNTRIES.map((c) => (
          <button
            key={c.code}
            type="button"
            className={`mcc-opt ${selected.has(c.code) ? 'on' : ''}`}
            onClick={() => toggle(c.code)}
          >
            {c.code} {c.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" className="btn ghost" onClick={() => onChange([])}>{tx("Clear (anywhere)")}</button>
      </div>
    </div>
  )
}
