import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { AGENCIES, PROTOCOLS, defaultCountriesFor } from '../../data/agencies.js'
import MccPicker from '../../components/MccPicker.jsx'
import CountryPicker from '../../components/CountryPicker.jsx'
import { ErrorText } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function NewConnection() {
  const { tx } = useI18n()
  const { country, act, appSettings } = useStore()
  const [params] = useSearchParams()
  const preset = AGENCIES.find((a) => a.id === params.get('agency'))
  const nav = useNavigate()
  const [agencyId, setAgencyId] = useState(preset?.id || '')
  const [name, setName] = useState(preset?.name ?? '')
  const [agency, setAgency] = useState(preset?.agency ?? '')
  const [protocol, setProtocol] = useState('pain001')
  const [mccs, setMccs] = useState(preset?.mccs ?? [])
  const [countries, setCountries] = useState(defaultCountriesFor(preset?.country || country))
  const [purpose, setPurpose] = useState(preset?.purpose ?? 'SSBE')
  const [dailyLimit, setDailyLimit] = useState(((appSettings?.defaultDailyLimitCents ?? 15000) / 100).toFixed(2))
  const [cashAllowed, setCashAllowed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const relevant = useMemo(() => AGENCIES.filter((a) => a.country === country), [country])
  const chosen = AGENCIES.find((a) => a.id === agencyId)

  function applyAgency(id) {
    setAgencyId(id)
    const a = AGENCIES.find((x) => x.id === id)
    if (!a) return
    setName(a.name)
    setAgency(a.agency)
    setMccs(a.mccs)
    setCountries(defaultCountriesFor(a.country))
    setPurpose(a.purpose)
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await act('POST', '/api/admin/connections', {
        id: chosen?.id,
        name,
        agency,
        country: chosen?.country || country,
        protocol,
        mccs,
        countries,
        purpose,
        system: chosen?.system,
        dailyLimitCents: Math.round(parseFloat(dailyLimit.replace(',', '.')) * 100),
        cashAllowed,
      })
      nav(`/admin/connections/${created.id}`, { state: { secret: created.hmacSecret } })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{tx("New connection")}</h2>
      <p className="muted">{tx("Cardholders see the connection name on incoming credits. MCCs and countries become the Lithic auth-rule allowlist.")}</p>
      <div className="field">
        <label htmlFor="agency-preset">{tx("Start from a {0} agency", { 0: country })}</label>
        <select id="agency-preset" value={agencyId} onChange={(e) => applyAgency(e.target.value)}>
          <option value="">{tx("Custom")}</option>
          {relevant.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="name">{tx("Name shown to cardholders")}</label>
          <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="agency">{tx("Paying agency")}</label>
          <input id="agency" required value={agency} onChange={(e) => setAgency(e.target.value)} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="protocol">{tx("Inbound protocol")}</label>
          <select id="protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            {PROTOCOLS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <small className="muted">{PROTOCOLS.find((p) => p.id === protocol)?.hint}</small>
        </div>
        <div className="field">
          <label htmlFor="purpose">{tx("ISO 20022 purpose")}</label>
          <select id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="SSBE">{tx("SSBE — social security benefit")}</option>
            <option value="GOVT">{tx("GOVT — government payment")}</option>
            <option value="PENS">{tx("PENS — pension")}</option>
          </select>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="daily">{tx("Daily spend cap per cardholder (EUR)")}</label>
        <input id="daily" inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={cashAllowed} onChange={(e) => setCashAllowed(e.target.checked)} />
        {tx("Cash may be withdrawn from this connection's envelopes")}
      </label>
      <h3>{tx("Allowed countries")}</h3>
      <CountryPicker value={countries} onChange={setCountries} />
      <h3>{tx("Allowed merchant category codes")}</h3>
      <MccPicker value={mccs} onChange={setMccs} />
      <ErrorText error={error} />
      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="btn" type="submit" disabled={busy || !name || !mccs.length}>{tx("Create connection")}</button>
      </div>
    </form>
  )
}
