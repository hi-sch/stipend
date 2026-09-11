import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { eur } from '../../lib/format.js'
import { countryName } from '../../data/agencies.js'

export default function Cardholders() {
  const { cardholder, cardholders, envelopes, selectCardholder } = useStore()
  const people = cardholders?.length ? cardholders : [cardholder]
  const total = envelopes.reduce((s, e) => s + e.balanceCents, 0)

  return (
    <>
      <div className="page-title">
        <p style={{ color: 'var(--muted)', margin: 0 }}>Virtual cards issued in this program. Synthetic data.</p>
        <Link className="btn" to="/admin/cardholders/new">
          New cardholder
        </Link>
      </div>
      <div className="card">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>City</th>
              <th>Card</th>
              <th>Envelopes</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const active = p.id === cardholder.id
              return (
                <tr key={p.id} onClick={() => selectCardholder(p.id)}>
                  <td>
                    <strong>
                      {p.firstName} {p.lastName}
                    </strong>
                    <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{p.email}</div>
                  </td>
                  <td>
                    {p.city}
                    <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{countryName(p.country)}</div>
                  </td>
                  <td>
                    ••{p.card.lastFour} · {p.card.state}
                  </td>
                  <td>{active ? envelopes.length : 0}</td>
                  <td>{active ? eur(total) : eur(0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 0 }}>
          Click a row to open that card in the cardholder app.
        </p>
      </div>
    </>
  )
}
