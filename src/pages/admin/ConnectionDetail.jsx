import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import MccPicker from '../../components/MccPicker.jsx'
import { PROTOCOLS } from '../../data/agencies.js'
import { hmacPreview, eur } from '../../lib/format.js'
import { samplePain001, sampleJson } from '../../lib/pain001.js'
import { lithicAuthRule } from '../../lib/auth.js'
import { mccName } from '../../data/mccs.js'
import CountryPicker from '../../components/CountryPicker.jsx'
import { SPEND_COUNTRIES } from '../../data/agencies.js'

export default function ConnectionDetail() {
  const { id } = useParams()
  const { connections, credits, envelopes, updateConnection } = useStore()
  const conn = connections.find((c) => c.id === id)
  const [copied, setCopied] = useState('')
  if (!conn) {
    return (
      <p>
        Unknown connection. <Link to="/admin/connections">Back</Link>
      </p>
    )
  }
  const env = envelopes.find((e) => e.connectionId === conn.id)
  const related = credits.filter((c) => c.connectionId === conn.id)
  const hook = `https://hooks.stipend.eu${conn.hookPath}`
  const pain = samplePain001({
    connectionName: conn.name,
    amountCents: 60000,
    endToEndId: 'E2E-DEMO-001',
    debtorName: conn.agency,
    purpose: conn.purpose,
  })
  const json = sampleJson({ connectionId: conn.id, amountCents: 60000, endToEndId: 'E2E-DEMO-001', purpose: conn.purpose })

  function copy(text, label) {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(''), 1600)
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h2 style={{ margin: 0 }}>{conn.name}</h2>
          <p style={{ color: 'var(--muted)', margin: '6px 0 0' }}>
            {conn.agency} · {conn.system}
          </p>
        </div>
        <select
          className="country-select"
          value={conn.status}
          onChange={(e) => updateConnection(conn.id, { status: e.target.value })}
        >
          <option value="live">live</option>
          <option value="sandbox">sandbox</option>
          <option value="paused">paused</option>
        </select>
      </div>
      <div className="kpis">
        <article className="kpi lilac">
          <h3>Envelope on Lena Vogt</h3>
          <div className="amount">{env ? eur(env.balanceCents) : 'No credits yet'}</div>
        </article>
        <article className="kpi peach">
          <h3>Credits received</h3>
          <div className="amount">{related.length}</div>
        </article>
        <article className="kpi dark">
          <h3>MCC allowlist</h3>
          <div className="amount">{conn.mccs.length}</div>
        </article>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Inbound hook</h2>
          <p style={{ color: 'var(--muted)' }}>
            Point the agency&apos;s payment run here instead of the bank. Same pain.001, different destination.
          </p>
          <div className="hook">{hook}</div>
          <p>
            HMAC secret <code>{hmacPreview(conn.hmacSecret)}</code>
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn ghost" type="button" onClick={() => copy(hook, 'url')}>
              Copy URL
            </button>
            <button className="btn ghost" type="button" onClick={() => copy(conn.hmacSecret, 'secret')}>
              Copy secret
            </button>
            {copied && <span style={{ color: 'var(--ok)' }}>Copied {copied}</span>}
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
            Protocol: {PROTOCOLS.find((p) => p.id === conn.protocol)?.label}. Purpose {conn.purpose}.
          </p>
          <h3>{conn.protocol === 'json' ? 'JSON body' : 'pain.001.001.09 sample'}</h3>
          <textarea readOnly value={conn.protocol === 'json' ? json : pain} />
        </div>
        <div className="card">
          <h2>Lithic auth rules</h2>
          <p style={{ color: 'var(--muted)' }}>
            Lithic geography is the card-acceptor <code>COUNTRY</code> (ISO 3166-1 alpha-3) on Auth Rules v2{' '}
            <code>CONDITIONAL_ACTION</code>, or v1 <code>allowed_countries</code> / <code>blocked_countries</code>.
            Finer geo: <code>SERVICE_LOCATION_STATE</code> and <code>SERVICE_LOCATION_POSTAL_CODE</code>. Velocity
            limits can include or exclude countries. Custom code can read <code>merchant.country</code>. Most
            restrictive of program / account / card wins; Lithic-wide blocked countries cannot be overridden.
            E-commerce acceptor country is less reliable than card-present.
          </p>
          <textarea readOnly value={JSON.stringify(lithicAuthRule(conn.mccs, conn.countries || []), null, 2)} />
          <div className="chips" style={{ marginTop: 10 }}>
            {(conn.countries || []).map((c) => (
              <span className="chip" key={c}>
                {c} {SPEND_COUNTRIES.find((x) => x.code === c)?.name ?? ''}
              </span>
            ))}
            {conn.mccs.slice(0, 8).map((c) => (
              <span className="chip" key={c}>
                {c} {mccName(c)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Allowed countries</h2>
        <CountryPicker
          value={conn.countries || []}
          onChange={(countries) => updateConnection(conn.id, { countries })}
        />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Edit merchant category codes</h2>
        <MccPicker value={conn.mccs} onChange={(mccs) => updateConnection(conn.id, { mccs })} />
      </div>
    </>
  )
}
