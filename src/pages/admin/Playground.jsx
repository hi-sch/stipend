import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { countryName, PROTOCOLS } from '../../data/agencies.js'
import { eur } from '../../lib/format.js'

export default function Playground() {
  const { connections, country, creditFromHook } = useStore()
  const scoped = connections.filter((c) => c.country === country)
  const [connectionId, setConnectionId] = useState(scoped[0]?.id ?? '')
  const [amount, setAmount] = useState('150.00')
  const [e2e, setE2e] = useState('E2E-TEST-')
  const [msg, setMsg] = useState(null)

  function submit(e) {
    e.preventDefault()
    const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100)
    const credit = creditFromHook({
      connectionId,
      amountCents: cents,
      endToEndId: e2e + Date.now().toString().slice(-5),
      remittance: 'Playground credit — synthetic',
    })
    setMsg(`Posted ${eur(credit.amountCents)} to the envelope. Cardholder Incoming will show the connection name.`)
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Hook playground</h2>
      <p style={{ color: 'var(--muted)', maxWidth: '68ch' }}>
        Agencies in {countryName(country)} would POST pain.001 or JSON to the connection hook. This form is the same
        credit, without leaving the console.
      </p>
      {!scoped.length && <p className="empty">Create a connection in this country first.</p>}
      <div className="field">
        <label htmlFor="conn">Connection</label>
        <select id="conn" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {scoped.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {PROTOCOLS.find((p) => p.id === c.protocol)?.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="amt">Amount (EUR)</label>
          <input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="e2e">End-to-end id prefix</label>
          <input id="e2e" value={e2e} onChange={(e) => setE2e(e.target.value)} />
        </div>
      </div>
      <button className="btn" type="submit" disabled={!connectionId}>
        Post credit
      </button>
      {msg && <p style={{ color: 'var(--ok)' }}>{msg}</p>}
    </form>
  )
}
