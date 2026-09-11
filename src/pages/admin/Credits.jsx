import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { eur, formatDateTime } from '../../lib/format.js'
import { PROTOCOLS, countryName } from '../../data/agencies.js'

export default function Credits() {
  const { credits, connections, country } = useStore()
  const scopedIds = new Set(connections.filter((c) => c.country === country).map((c) => c.id))
  const rows = credits.filter((c) => scopedIds.has(c.connectionId))
  return (
    <div className="card">
      <h2>Credits · {countryName(country)}</h2>
      <p style={{ color: 'var(--muted)' }}>Each row is a book transfer that funded an envelope instead of a SEPA payout.</p>
      <table className="data">
        <thead>
          <tr>
            <th>Connection</th>
            <th>Protocol</th>
            <th>End-to-end</th>
            <th>When</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const conn = connections.find((x) => x.id === c.connectionId)
            return (
              <tr key={c.id}>
                <td>
                  <Link to={`/admin/connections/${c.connectionId}`}>{conn?.name}</Link>
                </td>
                <td>{PROTOCOLS.find((p) => p.id === c.protocol)?.label}</td>
                <td>
                  <code>{c.endToEndId}</code>
                </td>
                <td>{formatDateTime(c.created)}</td>
                <td className="pos" style={{ textAlign: 'right' }}>
                  {eur(c.amountCents)}
                </td>
              </tr>
            )
          })}
          {!rows.length && (
            <tr>
              <td colSpan={5}>
                <p className="empty">No credits in this country yet. Use the hook playground to post one.</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
