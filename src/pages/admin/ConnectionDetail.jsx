import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import ConnectionEditDialog from './ConnectionEditDialog.jsx'
import { PROTOCOLS, SPEND_COUNTRIES } from '../../data/agencies.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { samplePain001, sampleJson, sampleCamt056 } from '../../lib/pain001.js'
import { mccName } from '../../data/mccs.js'
import { fileToText, post } from '../../api.js'
import CodeEditor from '../../components/CodeEditor.jsx'
import { ActionButton, ErrorText, KeyValues, Section, SecretOnce, StatusBadge } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function ConnectionDetail() {
  const { tx } = useI18n()
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { connections, allCredits, cardholders, reports, act, refresh, publicOrigin, appSettings } = useStore()
  const conn = connections.find((c) => c.id === id)
  const [secret, setSecret] = useState(location.state?.secret || '')
  const [pendingDelete, setPendingDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [fileResult, setFileResult] = useState(null)
  const [fileError, setFileError] = useState('')
  const [sample, setSample] = useState('credit')

  if (!conn) {
    return (
      <p>{tx("Unknown connection.")}{' '}<Link to="/admin/connections">{tx("Back")}</Link>
      </p>
    )
  }
  const related = allCredits.filter((c) => c.connectionId === conn.id)
  const myReports = (reports || []).filter((r) => r.connectionId === conn.id)
  const origin = publicOrigin
  const holder = cardholders[0]
  const sampleText =
    sample === 'recall'
      ? sampleCamt056({ endToEndId: related[0]?.endToEndId || 'E2E-DEMO-001', amountCents: related[0]?.amountCents || 60000 })
      : conn.protocol === 'json'
        ? sampleJson({ connectionId: conn.id, amountCents: 60000, endToEndId: 'E2E-DEMO-001', purpose: conn.purpose, beneficiaryRef: holder?.beneficiaryRef })
        : samplePain001({ connectionName: conn.name, debtorName: conn.agency, purpose: conn.purpose, amountCents: 60000, endToEndId: 'E2E-DEMO-001', creditorName: holder ? `${holder.firstName} ${holder.lastName}` : undefined, creditorIban: holder?.iban, beneficiaryRef: holder?.beneficiaryRef })

  async function upload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setFileError('')
    setFileResult(null)
    try {
      setFileResult(await post(`/api/admin/connections/${conn.id}/files`, { content: await fileToText(file) }))
      await refresh()
    } catch (err) {
      setFileError(err.message)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h2 style={{ margin: 0 }}>{conn.name}</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {conn.agency} · {conn.system}
          </p>
        </div>
        <div className="row-actions">
          <StatusBadge status={conn.status} />
          <button className="btn ghost" type="button" onClick={() => setEditing(true)}>{tx("Edit")}</button>
          <button className="btn danger" type="button" onClick={() => setPendingDelete(true)}>{tx("Delete")}</button>
        </div>
      </div>

      <div className="grid-2">
        <Section title={tx("Inbound hooks")} hint={tx("Point the agency's payment run here instead of the bank. Requests are signed with HMAC-SHA256 in X-Stipend-Signature.")}>
          <KeyValues
            rows={[
              [tx("Credits (pain.001 or JSON)"), <code key="c">{`${origin}/api/hooks/credits/${conn.id}`}</code>],
              [tx("Recalls (camt.056)"), <code key="r">{`${origin}/api/hooks/recalls/${conn.id}`}</code>],
              [tx("Signing secret"), <code key="s">{conn.hmacSecretPreview}</code>],
              [tx("Protocol"), PROTOCOLS.find((p) => p.id === conn.protocol)?.label],
              [tx("Purpose"), conn.purpose],
              [tx("Daily cap"), eur(conn.dailyLimitCents ?? appSettings?.defaultDailyLimitCents ?? 15000)],
            ]}
          />
          <p className="muted" style={{ fontSize: '0.85rem' }}>{tx("Send")}{' '}<code>{tx("Accept: application/xml")}</code>{' '}{tx("to receive a pain.002 (credits) or camt.029 (recalls) status report instead of JSON.")}</p>
          <div className="toolbar">
            <ActionButton onClick={async () => setSecret((await post(`/api/admin/connections/${conn.id}/secret`, {})).hmacSecret)}>{tx("Reveal secret")}</ActionButton>
            <ActionButton
              className="btn danger"
              confirmText={tx("Rotate the secret? The agency must switch to the new one immediately.")}
              onClick={async () => {
                setSecret((await post(`/api/admin/connections/${conn.id}/secret`, { rotate: true })).hmacSecret)
                await refresh()
              }}
            >{tx("Rotate secret")}</ActionButton>
          </div>
          <SecretOnce label={tx("Signing secret")} value={secret} onDone={() => setSecret('')} />
        </Section>
        <Section title={tx("Upload a file")} hint={tx("Process a pain.001 batch or a camt.056 recall received outside the hook (for example from an EBICS download).")}>
          <div className="field">
            <label htmlFor="iso-file">{tx("pain.001, camt.056 or JSON file")}</label>
            <input id="iso-file" type="file" accept=".xml,.json,application/xml,text/xml,application/json" onChange={upload} />
          </div>
          <ErrorText error={fileError} />
          {fileResult && (
            <div className="stack">
              <p>
                {fileResult.kind} · <StatusBadge status={fileResult.groupStatus || 'processed'} />{' '}
                {fileResult.reportId && (
                  <a className="btn ghost" href={`/api/admin/reports/${fileResult.reportId}`}>{tx("Download status report")}</a>
                )}
              </p>
              <table className="data">
                <tbody>
                  {(fileResult.statuses || fileResult.results || []).map((s, i) => (
                    <tr key={i}>
                      <td>
                        <code>{s.endToEndId || s.originalEndToEndId}</code>
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td>{[s.reason, s.detail].filter(Boolean).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <div className="grid-2">
        <Section title={tx("Credits from this connection")}>
          {!related.length && <p className="empty">{tx("No credits yet.")}</p>}
          <table className="data">
            <tbody>
              {related.slice(0, 20).map((c) => {
                const h = cardholders.find((x) => x.id === c.cardholderId)
                return (
                  <tr key={c.id}>
                    <td>
                      <code>{c.endToEndId}</code>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>{h ? `${h.firstName} ${h.lastName}` : c.cardholderId}</div>
                    </td>
                    <td>{formatDateTime(c.created)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td style={{ textAlign: 'right' }}>{eur(c.amountCents)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {myReports.length ? (
            <>
              <h3>{tx("Status reports")}</h3>
              <table className="data">
                <tbody>
                  {myReports.slice(0, 10).map((r) => (
                    <tr key={r.id}>
                      <td>{r.kind}</td>
                      <td>{formatDateTime(r.createdAt)}</td>
                      <td>{r.groupStatus && <StatusBadge status={r.groupStatus} />}</td>
                      <td>
                        <a href={`/api/admin/reports/${r.id}`}>{tx("Download")}</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </Section>
        <Section
          title={tx("Sample payload")}
          actions={
            <select className="country-select" value={sample} onChange={(e) => setSample(e.target.value)} aria-label={tx("Sample type")}>
              <option value="credit">{tx("Credit")}</option>
              <option value="recall">{tx("Recall (camt.056)")}</option>
            </select>
          }
        >
          <CodeEditor readOnly language={sample === 'credit' && conn.protocol === 'json' ? 'json' : 'xml'} value={sampleText} minHeight={260} />
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
        </Section>
      </div>
      {editing && <ConnectionEditDialog connection={conn} onClose={() => setEditing(false)} />}
      {pendingDelete && (
        <ConfirmDialog
          title={tx("Delete {0}?", { 0: conn.name })}
          body={tx("This removes the connection and the envelopes it funded. Its hook URL stops accepting credits.")}
          onCancel={() => setPendingDelete(false)}
          onConfirm={async () => {
            await act('DELETE', `/api/admin/connections/${conn.id}`)
            navigate('/admin/connections')
          }}
        />
      )}
    </div>
  )
}
