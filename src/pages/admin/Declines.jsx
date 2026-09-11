import { useStore } from '../../store.jsx'
import { eur, formatDateTime } from '../../lib/format.js'
import { mccName } from '../../data/mccs.js'

export default function Declines() {
  const { transactions } = useStore()
  const rows = transactions.filter((t) => t.status === 'DECLINED')
  return (
    <div className="card">
      <h2>Authorization declines</h2>
      <p style={{ color: 'var(--muted)' }}>
        Lithic detailed_results such as PROGRAM_USAGE_RESTRICTION when the MCC is outside every funded envelope.
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Merchant</th>
            <th>MCC</th>
            <th>When</th>
            <th>Reason codes</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                {t.merchant.descriptor}
                {t.note && <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{t.note}</div>}
              </td>
              <td>
                {t.merchant.mcc} {mccName(t.merchant.mcc)}
              </td>
              <td>{formatDateTime(t.created)}</td>
              <td>
                {t.detailedResults.map((r) => (
                  <span className="badge bad" key={r} style={{ marginRight: 4 }}>
                    {r}
                  </span>
                ))}
              </td>
              <td style={{ textAlign: 'right' }}>{eur(t.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
