import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { COUNTRIES } from '../../data/agencies.js'
import { ErrorText, SecretOnce } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function NewCardholder() {
  const { tx } = useI18n()
  const { country, act, lithic } = useStore()
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', city: '', country, beneficiaryRef: '', issueCard: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null)
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setCreated(await act('POST', '/api/admin/cardholders', form))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <div className="card">
        <h2>{tx("Cardholder created")}</h2>
        <p>{tx("Give the cardholder their email address and this temporary password. They must choose a new one at first sign-in.")}</p>
        <SecretOnce label={tx("Temporary password")} value={created.temporaryPassword} />
        {created.issueError && <ErrorText error={`Card not issued yet: ${created.issueError}`} />}
        <div className="toolbar">
          <Link className="btn" to={`/admin/cardholders/${created.id}`}>{tx("Open cardholder")}</Link>
          <Link className="btn ghost" to="/admin/cardholders">{tx("Back to list")}</Link>
        </div>
      </div>
    )
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{tx("New cardholder")}</h2>
      <p className="muted">{tx("Creates a login, a Stipend IBAN and beneficiary reference for agency payments, and (with Lithic configured) a KYC_BYO account holder with a virtual card. Lithic sandbox KYC only accepts a US address, so a placeholder New York address is sent.")}</p>
      <div className="row-2">
        <div className="field">
          <label htmlFor="fn">{tx("First name")}</label>
          <input id="fn" required value={form.firstName} onChange={set('firstName')} />
        </div>
        <div className="field">
          <label htmlFor="ln">{tx("Last name")}</label>
          <input id="ln" required value={form.lastName} onChange={set('lastName')} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="em">{tx("Email (login)")}</label>
          <input id="em" type="email" required value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="ph">{tx("Phone")}</label>
          <input id="ph" value={form.phone} onChange={set('phone')} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="city">{tx("City")}</label>
          <input id="city" required value={form.city} onChange={set('city')} />
        </div>
        <div className="field">
          <label htmlFor="cc">{tx("Country")}</label>
          <select id="cc" value={form.country} onChange={set('country')}>
            {COUNTRIES.filter((c) => c.code !== 'EU').map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ref">{tx("Beneficiary reference (agency customer number, optional)")}</label>
        <input id="ref" value={form.beneficiaryRef} onChange={set('beneficiaryRef')} placeholder={tx("Generated when empty")} />
      </div>
      {lithic?.configured && (
        <label className="check">
          <input type="checkbox" checked={form.issueCard} onChange={set('issueCard')} />{' '}{tx("Issue a Lithic virtual card now")}</label>
      )}
      <ErrorText error={error} />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create cardholder'}
      </button>
    </form>
  )
}
