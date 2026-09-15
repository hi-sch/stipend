import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { del, get, patch, post } from '../../api.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { ActionButton, ErrorText, KeyValues, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Asa() {
  const { tx } = useI18n()
  const { asaLog, lithic, refresh, publicOrigin } = useStore()
  const status = useLoad(() => get('/api/admin/asa'), [])
  const [url, setUrl] = useState(`${publicOrigin}/api/asa`)
  const [error, setError] = useState('')
  const endpoint = status.data?.endpoint

  async function run(fn) {
    setError('')
    try {
      await fn()
      await Promise.all([status.reload(), refresh()])
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="page-stack">
      <div className="grid-2">
        <Section title={tx("Auth Stream Access")} hint={tx("Lithic sends every authorization to Stipend, which picks the envelope, enforces daily caps and can partially approve. Responses must arrive within 6 seconds.")}>
          <KeyValues
            rows={[
              [tx("Mode"), lithic?.asaEnrolled ? 'Lithic calls /api/asa' : 'Local: Stipend decides right after sandbox authorizations'],
              [tx("Enrolled URL"), endpoint?.url || '—'],
              [tx("Status"), <StatusBadge key="e" status={endpoint?.enrolled ? 'enrolled' : 'no'} />],
              [tx("Signature secret"), status.data?.secretConfigured ? <code key="s">{status.data.secretPreview}</code> : 'not stored'],
            ]}
          />
          {lithic?.asaEnrolled && !lithic?.asaReachable && (
            <ErrorText error={`Lithic cannot reach ${lithic.asaUrl}. While this stays enrolled, every authorization on the program declines. Disenroll it, or enroll a public HTTPS tunnel URL.`} />
          )}
          <ErrorText error={status.error || endpoint?.error} />
        </Section>
        <Section title={tx("Enrollment")} hint={tx("Lithic needs a public HTTPS URL. In development, expose the dev server with a tunnel and paste the tunnel URL.")}>
          <div className="field">
            <label htmlFor="asa-url">{tx("Responder URL")}</label>
            <input id="asa-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="toolbar">
            <ActionButton className="btn" disabled={!lithic?.configured} onClick={() => run(() => post('/api/admin/asa/enroll', { url }))}>{tx("Enroll")}</ActionButton>
            <ActionButton className="btn danger" disabled={!endpoint?.enrolled} confirmText={tx("Disenroll ASA? Lithic will stop asking Stipend.")} onClick={() => run(() => del('/api/admin/asa'))}>{tx("Disenroll")}</ActionButton>
            <ActionButton disabled={!lithic?.configured} onClick={() => run(() => post('/api/admin/asa/secret', {}))}>{tx("Fetch secret")}</ActionButton>
            <ActionButton disabled={!lithic?.configured} confirmText={tx("Rotate the ASA secret?")} onClick={() => run(() => post('/api/admin/asa/secret', { rotate: true }))}>{tx("Rotate secret")}</ActionButton>
          </div>
          <ErrorText error={error} />
        </Section>
      </div>
      <Responders />
      <Section title={tx("Recent decisions")}>
        {!asaLog.length && <p className="empty">{tx("No decisions yet. Try a purchase from the cardholder app.")}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("When")}</th>
                <th>{tx("Source")}</th>
                <th>{tx("Merchant")}</th>
                <th>MCC</th>
                <th>{tx("Result")}</th>
                <th>{tx("Reason")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Amount")}</th>
              </tr>
            </thead>
            <tbody>
              {asaLog.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.at)}</td>
                  <td>{row.source}</td>
                  <td>{row.merchant}</td>
                  <td>{row.mcc}</td>
                  <td>
                    <StatusBadge status={row.response?.result} />
                    {row.response?.approved_amount ? <div className="muted" style={{ fontSize: '0.78rem' }}>{tx("partial {0}", { 0: eur(row.response.approved_amount) })}</div> : null}
                  </td>
                  <td style={{ fontSize: '0.85rem' }}>{row.decision?.reason || ''}</td>
                  <td style={{ textAlign: 'right' }}>{eur(row.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

const RESPONDERS = [
  ['three-ds', '3-D Secure decisioning', 'Lithic asks Stipend before each online checkout: decline merchants no envelope pays, challenge large amounts, approve the rest.'],
  ['tokenization', 'Tokenization decisioning', 'Lithic asks Stipend before a card is added to a wallet: only open cards, following the wallet recommendation or a stricter policy.'],
]

function Responders() {
  const { tx } = useI18n()
  const { lithic, publicOrigin } = useStore()
  const data = useLoad(() => get('/api/admin/responders'), [])
  const [urls, setUrls] = useState({})
  const [error, setError] = useState('')
  const policy = data.data?.policy
  const [threshold, setThreshold] = useState('')
  const [mode, setMode] = useState('')

  async function run(fn) {
    setError('')
    try {
      await fn()
      await data.reload()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="stack">
      <div className="grid-2">
        {RESPONDERS.map(([kind, title, hint]) => {
          const info = data.data?.[kind]
          const url = urls[kind] ?? `${publicOrigin}${info?.path || `/api/responders/${kind}`}`
          return (
            <Section key={kind} title={title} hint={hint}>
              <KeyValues
                rows={[
                  [tx("Status"), <StatusBadge key="s" status={info?.endpoint?.enrolled ? 'enrolled' : 'no'} />],
                  [tx("Enrolled URL"), info?.endpoint?.url || '—'],
                  [tx("Signature secret"), info?.secretConfigured ? 'stored' : 'not stored'],
                ]}
              />
              <div className="field">
                <label htmlFor={`url-${kind}`}>{tx("Responder URL")}</label>
                <input id={`url-${kind}`} value={url} onChange={(e) => setUrls({ ...urls, [kind]: e.target.value })} />
              </div>
              <div className="toolbar">
                <ActionButton className="btn" disabled={!lithic?.configured} onClick={() => run(() => post(`/api/admin/responders/${kind}/enroll`, { url }))}>{tx("Enroll")}</ActionButton>
                <ActionButton className="btn danger" disabled={!info?.endpoint?.enrolled} confirmText={tx("Disenroll {0}?", { 0: title })} onClick={() => run(() => del(`/api/admin/responders/${kind}`))}>{tx("Disenroll")}</ActionButton>
                <ActionButton disabled={!lithic?.configured} onClick={() => run(() => post(`/api/admin/responders/${kind}/secret`, {}))}>{tx("Fetch secret")}</ActionButton>
                <ActionButton disabled={!lithic?.configured} confirmText={tx("Rotate the secret?")} onClick={() => run(() => post(`/api/admin/responders/${kind}/secret`, { rotate: true }))}>{tx("Rotate secret")}</ActionButton>
              </div>
            </Section>
          )
        })}
      </div>
      <Section title={tx("Decisioning policy")}>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            run(() =>
              patch('/api/admin/responders/settings', {
                threeDsChallengeAboveCents: threshold === '' ? undefined : Math.round(parseFloat(threshold.replace(',', '.')) * 100),
                tokenizationMode: mode || undefined,
              }),
            )
          }}
        >
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("Challenge online purchases above (EUR)")}</span>
            <input inputMode="decimal" value={threshold} placeholder={policy ? (policy.threeDsChallengeAboveCents / 100).toFixed(2) : ''} onChange={(e) => setThreshold(e.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("Wallet requests")}</span>
            <select value={mode || policy?.tokenizationMode || 'recommendation'} onChange={(e) => setMode(e.target.value)}>
              <option value="recommendation">{tx("Follow wallet recommendation")}</option>
              <option value="approve">{tx("Approve open cards")}</option>
              <option value="authenticate">{tx("Always require verification")}</option>
            </select>
          </label>
          <button className="btn" type="submit">{tx("Save policy")}</button>
        </form>
        <ErrorText error={error || data.error} />
        <table className="data" style={{ marginTop: 12 }}>
          <tbody>
            {(data.data?.log || []).map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.at)}</td>
                <td>{row.kind}</td>
                <td>{row.merchant || '—'}</td>
                <td>
                  <StatusBadge status={row.decision === 'APPROVE' ? 'yes' : row.decision === 'DECLINE' ? 'no' : row.decision} />
                </td>
                <td style={{ fontSize: '0.85rem' }}>{row.reason}</td>
              </tr>
            ))}
            {!(data.data?.log || []).length && (
              <tr>
                <td>
                  <p className="empty">{tx("No decisioning requests yet.")}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>
    </div>
  )
}
