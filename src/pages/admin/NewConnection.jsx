import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { AGENCIES, PROTOCOLS, defaultCountriesFor } from '../../data/agencies.js'
import MccPicker from '../../components/MccPicker.jsx'
import CountryPicker from '../../components/CountryPicker.jsx'

export default function NewConnection() {
  const { country, createConnection } = useStore()
  const [params] = useSearchParams()
  const preset = AGENCIES.find((a) => a.id === params.get('agency'))
  const nav = useNavigate()
  const [name, setName] = useState(preset?.name ?? '')
  const [agency, setAgency] = useState(preset?.agency ?? '')
  const [protocol, setProtocol] = useState('pain001')
  const [mccs, setMccs] = useState(preset?.mccs ?? [])
  const [countries, setCountries] = useState(defaultCountriesFor(preset?.country || country))
  const [purpose, setPurpose] = useState(preset?.purpose ?? 'SSBE')

  const relevant = useMemo(() => AGENCIES.filter((a) => a.country === country), [country])

  function applyAgency(id) {
    const a = AGENCIES.find((x) => x.id === id)
    if (!a) return
    setName(a.name)
    setAgency(a.agency)
    setMccs(a.mccs)
    setCountries(defaultCountriesFor(a.country))
    setPurpose(a.purpose)
  }

  function submit(e) {
    e.preventDefault()
    const conn = createConnection({
      id: preset?.id,
      name,
      agency,
      country: preset?.country || country,
      protocol,
      mccs,
      countries,
      purpose,
      system: preset?.system,
    })
    nav(`/admin/connections/${conn.id}`)
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New connection</h2>
      <p style={{ color: 'var(--muted)' }}>
        Cardholders will see the connection name on incoming credits. MCCs and countries become the Lithic auth-rule
        allowlist.
      </p>
      <div className="field">
        <label htmlFor="agency-preset">Start from a {country} agency</label>
        <select
          id="agency-preset"
          defaultValue={preset?.id || ''}
          onChange={(e) => applyAgency(e.target.value)}
        >
          <option value="">Custom</option>
          {relevant.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="name">Name shown to cardholders</label>
          <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="agency">Paying agency</label>
          <input id="agency" required value={agency} onChange={(e) => setAgency(e.target.value)} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="protocol">Inbound protocol</label>
          <select id="protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            {PROTOCOLS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <small style={{ color: 'var(--muted)' }}>{PROTOCOLS.find((p) => p.id === protocol)?.hint}</small>
        </div>
        <div className="field">
          <label htmlFor="purpose">ISO 20022 purpose</label>
          <select id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="SSBE">SSBE — social security benefit</option>
            <option value="GOVT">GOVT — government payment</option>
            <option value="PENS">PENS — pension</option>
          </select>
        </div>
      </div>
      <h3>Allowed countries</h3>
      <CountryPicker value={countries} onChange={setCountries} />
      <h3>Allowed merchant category codes</h3>
      <MccPicker value={mccs} onChange={setMccs} />
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn" type="submit" disabled={!name || !mccs.length}>
          Create connection
        </button>
      </div>
    </form>
  )
}
