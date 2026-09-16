import { useState } from 'react'
import { get, post } from '../../api.js'
import { formatDateTime } from '../../lib/format.js'
import { ActionButton, ErrorText, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'
import { useStore } from '../../store.jsx'

/**
 * Sensitive writes wait here for a second operator.
 *
 * The server has enforced this since approvals were added, but there was no screen for it:
 * a parked request returned a 202 the console ignored, so the action looked like it had
 * silently done nothing and there was nowhere to approve it. With STIPEND_REQUIRE_APPROVAL
 * off — the default — this page simply stays empty.
 */
export default function Approvals() {
  const { tx } = useI18n()
  const { user, refresh } = useStore()
  const pending = useLoad(() => get('/api/admin/approvals'), [])
  const [notes, setNotes] = useState({})
  const [error, setError] = useState('')

  const rows = pending.data || []

  async function decide(id, decision) {
    setError('')
    await post(`/api/admin/approvals/${id}/decide`, { decision, note: notes[id]?.trim() || null })
    setNotes((n) => ({ ...n, [id]: '' }))
    await pending.reload()
  }

  async function carryOut(id) {
    setError('')
    await post(`/api/admin/approvals/${id}/apply`)
    await pending.reload()
    // The change has only now actually happened, so everything the console is showing is stale.
    await refresh()
  }

  return (
    <div className="page-stack">
      <Section
        title={tx("Waiting for a second operator")}
        hint={tx("Cash rules, recalls, cardholder deletion, external payments, settings and a program reset are parked until another operator approves them. Nobody can approve their own request.")}
      >
        <ErrorText error={error || pending.error} />
        {pending.loading && <p className="empty">{tx("Loading…")}</p>}
        {!pending.loading && !rows.length && <p className="empty">{tx("Nothing is waiting for approval.")}</p>}

        {!!rows.length && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{tx("Asked")}</th>
                  <th>{tx("Action")}</th>
                  <th>{tx("Asked by")}</th>
                  <th>{tx("Status")}</th>
                  <th>{tx("Decision")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const mine = a.requestedBy === user?.email
                  const payload = a.payload || {}
                  return (
                    <tr key={a.id}>
                      <td>
                        {formatDateTime(a.requestedAt)}
                        {a.expiresAt && (
                          <div className="muted" style={{ fontSize: '0.8rem' }}>
                            {tx("Expires {0}", [formatDateTime(a.expiresAt)])}
                          </div>
                        )}
                      </td>
                      <td>
                        <strong>{a.action}</strong>
                        <div className="muted" style={{ fontSize: '0.8rem' }}>
                          {payload.method} {payload.path}
                        </div>
                        {a.target && <div className="muted" style={{ fontSize: '0.8rem' }}>{a.target}</div>}
                        {payload.body && (
                          <details style={{ marginTop: 4 }}>
                            <summary className="muted" style={{ fontSize: '0.8rem', cursor: 'pointer' }}>{tx("What it will change")}</summary>
                            <pre style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
                              {JSON.stringify(payload.body, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td>
                        {a.requestedBy}
                        {mine && <div className="muted" style={{ fontSize: '0.8rem' }}>{tx("You asked for this")}</div>}
                      </td>
                      <td>
                        <StatusBadge status={a.status} />
                        {a.error && <div style={{ color: 'var(--danger)', fontSize: '0.8rem' }}>{a.error}</div>}
                      </td>
                      <td>
                        {a.status === 'PENDING' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {mine ? (
                              <span className="muted" style={{ fontSize: '0.8rem', maxWidth: 240 }}>
                                {tx("Another operator has to approve this one.")}
                              </span>
                            ) : (
                              <>
                                <input
                                  type="text"
                                  value={notes[a.id] || ''}
                                  placeholder={tx("Note (optional)")}
                                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                                />
                                <div className="toolbar">
                                  <ActionButton className="btn" onClick={() => decide(a.id, 'APPROVED')}>
                                    {tx("Approve")}
                                  </ActionButton>
                                  <ActionButton className="btn ghost" onClick={() => decide(a.id, 'REJECTED')}>
                                    {tx("Reject")}
                                  </ActionButton>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {a.status === 'APPROVED' && (
                          <ActionButton
                            className="btn"
                            confirmText={tx("Carry out this approved request?")}
                            onClick={() => carryOut(a.id)}
                          >
                            {tx("Carry out")}
                          </ActionButton>
                        )}

                        {a.decidedBy && a.status !== 'PENDING' && (
                          <div className="muted" style={{ fontSize: '0.8rem' }}>
                            {tx("Decided by {0}", [a.decidedBy])}
                            {a.note ? ` — ${a.note}` : ''}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}
