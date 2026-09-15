import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { get, patch, post } from '../../api.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { ErrorText, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

const LOCAL_STATUSES = ['OPEN', 'IN_REVIEW', 'CLOSED']
const LITHIC_STATUSES = ['OPEN', 'ASSIGNED', 'IN_REVIEW', 'ESCALATED', 'RESOLVED', 'CLOSED']

export default function Cases() {
  const { tx } = useI18n()
  const { cases, cardholders, act, lithic, allEnvelopes, allTransactions, refresh } = useStore()
  const [choice, setChoice] = useState({})
  const [error, setError] = useState('')
  const monitoring = useLoad(() => (lithic?.configured ? get('/api/admin/monitoring') : { available: false }), [lithic?.configured])

  const cashRequests = cardholders.filter((c) => c.cash?.status === 'REQUESTED')

  return (
    <div className="page-stack">
      <Section title={tx("Pending cash requests")}>
        {!cashRequests.length && <p className="empty">{tx("No pending cash requests.")}</p>}
        <table className="data">
          <tbody>
            {cashRequests.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>
                    {c.firstName} {c.lastName}
                  </strong>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>{c.cash.reason || '—'}</div>
                </td>
                <td>{formatDateTime(c.cash.requestedAt)}</td>
                <td style={{ textAlign: 'right' }}>{eur(c.cash.requestedCents)}</td>
                <td>
                  <Link className="btn ghost" to={`/admin/cardholders/${c.id}`}>
                    {tx("Review")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title={tx("Stipend cases")} hint={tx("Opened automatically when the envelope engine declines a purchase, Lithic approves one outside every envelope, or a refund cannot be matched to the envelope that paid.")}>
        <ErrorText error={error} />
        {!cases.length && <p className="empty">{tx("No cases.")}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("When")}</th>
                <th>{tx("Title")}</th>
                <th>{tx("Cardholder")}</th>
                <th>{tx("Merchant")}</th>
                <th>{tx("Codes")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Amount")}</th>
                <th>{tx("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const holder = cardholders.find((h) => h.id === c.cardholderId)
                return (
                  <tr key={c.id}>
                    <td>{formatDateTime(c.at)}</td>
                    <td>{c.title}</td>
                    <td>{holder ? `${holder.firstName} ${holder.lastName}` : '—'}</td>
                    <td>
                      {c.merchant}
                      <div className="muted" style={{ fontSize: '0.8rem' }}>{c.mcc}</div>
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>{(c.detailedResults || []).join(', ')}</td>
                    <td style={{ textAlign: 'right' }}>{eur(c.amountCents)}</td>
                    <td>
                      {c.status !== 'CLOSED' && allTransactions.find((t) => t.id === c.transactionId)?.unallocatedCents ? (
                        <div className="toolbar" style={{ marginBottom: 6 }}>
                          <select
                            className="country-select"
                            aria-label={tx("Envelope")}
                            value={choice[c.id] || ''}
                            onChange={(e) => setChoice({ ...choice, [c.id]: e.target.value })}
                          >
                            <option value="">{tx("Choose envelope…")}</option>
                            {(allEnvelopes || [])
                              .filter((e) => e.cardholderId === c.cardholderId)
                              .map((e) => (
                                <option key={e.id} value={e.id}>
                                  {e.connectionName}
                                </option>
                              ))}
                          </select>
                          <button
                            className="btn ghost"
                            type="button"
                            disabled={!choice[c.id]}
                            onClick={() =>
                              post(`/api/admin/transactions/${c.transactionId}/allocate`, { envelopeId: choice[c.id] })
                                .then(refresh)
                                .catch((err) => setError(err.message))
                            }
                          >{tx("Allocate")}</button>
                        </div>
                      ) : null}
                      <select className="country-select" value={c.status} aria-label={tx("Case status")} onChange={(e) => act('PATCH', `/api/admin/cases/${c.id}`, { status: e.target.value })}>
                        {LOCAL_STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={tx("Lithic transaction monitoring")} hint={tx("Cases from Lithic Fraud Command, when enabled for the program.")}>
        {monitoring.data && !monitoring.data.available && <p className="muted">{tx("Not available for this program{0}", { 0: monitoring.data.error ? `: ${monitoring.data.error}` : '.' })}</p>}
        <ErrorText error={monitoring.error} />
        <table className="data">
          <tbody>
            {(monitoring.data?.data || []).map((c) => (
              <tr key={c.token}>
                <td>{formatDateTime(c.created)}</td>
                <td>{c.title || c.token}</td>
                <td>{c.priority}</td>
                <td>{c.assignee || 'unassigned'}</td>
                <td>
                  <StatusBadge status={c.status} />
                </td>
                <td>
                  <select
                    className="country-select"
                    value={c.status}
                    aria-label={tx("Lithic case status")}
                    onChange={(e) => patch(`/api/admin/monitoring/${c.token}`, { status: e.target.value }).then(monitoring.reload)}
                  >
                    {LITHIC_STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}
