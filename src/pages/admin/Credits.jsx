import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { eur, formatDateTime } from '../../lib/format.js'
import { PROTOCOLS, countryName } from '../../data/agencies.js'
import { ActionButton, Modal, StatusBadge } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

const RECALL_REASONS = [
  ['DUPL', 'Duplicate payment'],
  ['CUST', 'Requested by agency'],
  ['FRAD', 'Fraudulent origin'],
  ['TECH', 'Technical problem'],
  ['AM09', 'Wrong amount'],
]

export default function Credits() {
  const { tx } = useI18n()
  const { allCredits, connections, country, reports, act } = useStore()
  const scopedIds = new Set(connections.filter((c) => c.country === country).map((c) => c.id))
  const rows = allCredits.filter((c) => scopedIds.has(c.connectionId))
  const [recalling, setRecalling] = useState(null)
  const [reason, setReason] = useState('DUPL')
  const [outcome, setOutcome] = useState(null)

  return (
    <div className="page-stack">
      <div className="card">
        <h2>{tx("Credits · {0}", { 0: countryName(country) })}</h2>
        <p className="muted">{tx("Each accepted credit funds an envelope and, when the program ledger is funded, a Lithic DISBURSE book transfer.")}</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("Connection")}</th>
                <th>{tx("Cardholder")}</th>
                <th>{tx("End-to-end")}</th>
                <th>{tx("When")}</th>
                <th>{tx("Status")}</th>
                <th>Lithic</th>
                <th style={{ textAlign: 'right' }}>{tx("Amount")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const conn = connections.find((x) => x.id === c.connectionId)
                return (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/admin/connections/${c.connectionId}`}>{conn?.name}</Link>
                      <div className="muted" style={{ fontSize: '0.78rem' }}>{PROTOCOLS.find((p) => p.id === c.protocol)?.label || c.protocol}</div>
                    </td>
                    <td>{c.cardholderName ? <Link to={`/admin/cardholders/${c.cardholderId}`}>{c.cardholderName}</Link> : '—'}</td>
                    <td>
                      <code>{c.endToEndId}</code>
                    </td>
                    <td>{formatDateTime(c.created)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                      {c.recalledCents ? <div className="muted" style={{ fontSize: '0.78rem' }}>{tx("recalled {0}", { 0: eur(c.recalledCents) })}</div> : null}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {c.lithicTransfer?.posted ? `DISBURSE ${c.lithicTransfer.status || ''}` : c.lithicTransfer?.error || (c.lithicTransfer ? 'not posted' : 'envelope only')}
                    </td>
                    <td className="pos" style={{ textAlign: 'right' }}>
                      {eur(c.amountCents)}
                    </td>
                    <td>
                      {c.status !== 'RECALLED' && (
                        <button className="btn ghost" type="button" onClick={() => setRecalling(c)}>{tx("Recall")}</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8}>
                    <p className="empty">{tx("No credits in this country yet. Use Sandbox tools to post a signed credit.")}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>{tx("Status reports")}</h2>
        <p className="muted">{tx("pain.002 for every credit file and camt.029 for every recall, as returned to the paying agency.")}</p>
        <table className="data">
          <tbody>
            {(reports || []).filter((r) => scopedIds.has(r.connectionId)).slice(0, 30).map((r) => (
              <tr key={r.id}>
                <td>{r.kind}</td>
                <td>{connections.find((c) => c.id === r.connectionId)?.name}</td>
                <td>{formatDateTime(r.createdAt)}</td>
                <td>{r.groupStatus ? <StatusBadge status={r.groupStatus} /> : null}</td>
                <td>
                  <a href={`/api/admin/reports/${r.id}`}>{tx("Download XML")}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recalling && (
        <Modal title={tx("Recall {0}", { 0: recalling.endToEndId })} onClose={() => { setRecalling(null); setOutcome(null) }}>
          <p className="muted">{tx("Takes back what is still unspent in the envelope (up to {0}). Spent money stays with the cardholder and the recall is reported as partial.", { 0: eur(recalling.amountCents - (recalling.recalledCents || 0)) })}</p>
          <div className="field">
            <label htmlFor="recall-reason">{tx("Reason")}</label>
            <select id="recall-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {RECALL_REASONS.map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </select>
          </div>
          {outcome && (
            <p>
              <StatusBadge status={outcome.results?.[0]?.status} /> {outcome.results?.[0]?.detail}{' '}
              <a href={`/api/admin/reports/${outcome.reportId}`}>{tx("camt.029")}</a>
            </p>
          )}
          <div className="card-actions">
            <ActionButton className="btn danger" onClick={async () => setOutcome(await act('POST', `/api/admin/credits/${recalling.id}/recall`, { reason }))}>{tx("Recall credit")}</ActionButton>
          </div>
        </Modal>
      )}
    </div>
  )
}
