import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { PROTOCOLS, countryName } from '../../data/agencies.js'
import { eur, formatDate } from '../../lib/format.js'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import { StatusBadge } from '../../components/ui.jsx'
import ConnectionEditDialog from './ConnectionEditDialog.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Connections() {
  const { tx, t } = useI18n()
  const navigate = useNavigate()
  const { connections, country, act, appSettings } = useStore()
  const rows = connections.filter((c) => c.country === country)
  const [pending, setPending] = useState(null)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')

  return (
    <>
      <div className="page-title">
        <p className="muted" style={{ margin: 0 }}>{tx("Showing {0} only.", { 0: countryName(country) })}{' '}<Link to="/admin/settings">{tx("Change the country scope in Settings")}</Link></p>
        <Link className="btn" to="/admin/connections/new">{tx("New connection")}</Link>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("Name")}</th>
                <th>{tx("Agency")}</th>
                <th>{tx("Protocol")}</th>
                <th>{tx("MCCs")}</th>
                <th>{tx("Daily cap")}</th>
                <th>{tx("Status")}</th>
                <th>{tx("Created")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/admin/connections/${c.id}`)}>
                  <td>
                    <strong>{c.name}</strong>
                    <div className="muted" style={{ fontSize: '0.78rem' }}>/api/hooks/credits/{c.id}</div>
                  </td>
                  <td>{c.agency}</td>
                  <td>{PROTOCOLS.find((p) => p.id === c.protocol)?.label}</td>
                  <td>{c.mccs.length}</td>
                  <td>{eur(c.dailyLimitCents ?? appSettings?.defaultDailyLimitCents ?? 15000)}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-actions">
                      <button className="btn ghost" type="button" onClick={() => setEditing(c)}>
                        {t('common.edit')}
                      </button>
                      <button className="btn danger" type="button" onClick={() => setPending(c)}>
                        {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8}>
                    <p className="empty">{tx("No connections for {0} yet.", { 0: countryName(country) })}{' '}<Link to="/admin/connections/new">{tx("Create one")}</Link>{' '}{tx("so an agency can credit envelopes instead of sending SEPA.")}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {pending && (
        <ConfirmDialog
          title={tx("Delete {0}?", { 0: pending.name })}
          body={tx("This removes the connection and the envelopes it funded. Its hook URL stops accepting credits.")}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.id
            setPending(null)
            act('DELETE', `/api/admin/connections/${id}`).catch((err) => setError(err.message))
          }}
        />
      )}
      {editing && <ConnectionEditDialog connection={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
