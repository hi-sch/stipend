import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { PROTOCOLS } from '../../data/agencies.js'
import MccPicker from '../../components/MccPicker.jsx'
import CountryPicker from '../../components/CountryPicker.jsx'
import { ErrorText, useFocusTrap } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function ConnectionEditDialog({ connection, onClose }) {
  const { tx, t } = useI18n()
  const { act, appSettings } = useStore()
  const [name, setName] = useState(connection.name)
  const [agency, setAgency] = useState(connection.agency)
  const [protocol, setProtocol] = useState(connection.protocol)
  const [purpose, setPurpose] = useState(connection.purpose || 'SSBE')
  const [status, setStatus] = useState(connection.status)
  const [dailyLimit, setDailyLimit] = useState(((connection.dailyLimitCents ?? appSettings?.defaultDailyLimitCents ?? 15000) / 100).toFixed(2))
  const [cashAllowed, setCashAllowed] = useState(Boolean(connection.cashAllowed))
  const [mccs, setMccs] = useState(connection.mccs || [])
  const [countries, setCountries] = useState(connection.countries || [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useFocusTrap(onClose)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await act('PATCH', `/api/admin/connections/${connection.id}`, {
        name,
        agency,
        protocol,
        purpose,
        status,
        mccs,
        countries,
        dailyLimitCents: Math.round(parseFloat(String(dailyLimit).replace(',', '.')) * 100),
        cashAllowed,
      })
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <form ref={ref} className="card modal wide" role="dialog" aria-modal="true" aria-labelledby="edit-conn-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2 id="edit-conn-title">{tx("Edit {0}", { 0: connection.name })}</h2>
        <div className="row-2">
          <div className="field">
            <label htmlFor="edit-name">{tx("Name shown to cardholders")}</label>
            <input id="edit-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="edit-agency">{tx("Paying agency")}</label>
            <input id="edit-agency" required value={agency} onChange={(e) => setAgency(e.target.value)} />
          </div>
        </div>
        <div className="row-2">
          <div className="field">
            <label htmlFor="edit-protocol">{tx("Inbound protocol")}</label>
            <select id="edit-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {PROTOCOLS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="edit-purpose">{tx("ISO 20022 purpose")}</label>
            <select id="edit-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="SSBE">{tx("SSBE — social security benefit")}</option>
              <option value="GOVT">{tx("GOVT — government payment")}</option>
              <option value="PENS">{tx("PENS — pension")}</option>
            </select>
          </div>
        </div>
        <div className="row-2">
          <div className="field">
            <label htmlFor="edit-status">{tx("Status")}</label>
            <select id="edit-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="live">{tx("live")}</option>
              <option value="sandbox">{tx("sandbox")}</option>
              <option value="paused">{tx("paused (hook rejects credits)")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="edit-limit">{tx("Daily spend cap per cardholder (EUR)")}</label>
            <input id="edit-limit" inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
          </div>
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
        <div className="card-actions">
          <button className="btn ghost" type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn" type="submit" disabled={busy || !name || !mccs.length}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
