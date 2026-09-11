import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { PROTOCOLS, countryName } from '../../data/agencies.js'
import { formatDate } from '../../lib/format.js'

export default function Connections() {
  const { connections, country } = useStore()
  const rows = connections.filter((c) => c.country === country)
  return (
    <>
      <div className="page-title">
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Showing {countryName(country)} only. Switch the country dropdown to see another paying landscape.
        </p>
        <Link className="btn" to="/admin/connections/new">
          New connection
        </Link>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Agency</th>
                <th>Protocol</th>
                <th>MCCs</th>
                <th>Countries</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => (window.location.hash = '')}>
                  <td>
                    <Link to={`/admin/connections/${c.id}`}>
                      <strong>{c.name}</strong>
                    </Link>
                    <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{c.hookPath}</div>
                  </td>
                  <td>{c.agency}</td>
                  <td>{PROTOCOLS.find((p) => p.id === c.protocol)?.label}</td>
                  <td>{c.mccs.length}</td>
                  <td>{(c.countries || []).join(', ') || 'any'}</td>
                  <td>
                    <span className={`badge ${c.status === 'live' ? 'ok' : c.status === 'paused' ? 'bad' : 'warn'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>{formatDate(c.createdAt)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7}>
                    <p className="empty">
                      No connections for {countryName(country)} yet.{' '}
                      <Link to="/admin/connections/new">Create one</Link> so an agency can credit envelopes instead of
                      sending SEPA.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
