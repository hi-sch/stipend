import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { get } from '../../api.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { mccName } from '../../data/mccs.js'
import { ActionButton, JsonView, Modal } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Declines() {
  const { tx } = useI18n()
  const { allTransactions } = useStore()
  const rows = allTransactions.filter((t) => t.status === 'DECLINED')
  const [results, setResults] = useState(null)

  return (
    <div className="card">
      <h2>{tx("Authorization declines")}</h2>
      <p className="muted">{tx("Declines from the envelope engine (ASA) and from Lithic auth rules. For live transactions, load the rule evaluation to see which rule fired.")}</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{tx("Merchant")}</th>
              <th>{tx("Cardholder")}</th>
              <th>MCC</th>
              <th>{tx("When")}</th>
              <th>{tx("Reason codes")}</th>
              <th style={{ textAlign: 'right' }}>{tx("Amount")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              return (
                <tr key={t.id}>
                  <td>
                    {t.merchant?.descriptor}
                    {t.note && <div className="muted" style={{ fontSize: '0.8rem' }}>{t.note}</div>}
                  </td>
                  <td>{t.cardholderName || '—'}</td>
                  <td>
                    {t.merchant?.mcc} {mccName(t.merchant?.mcc)}
                  </td>
                  <td>{formatDateTime(t.created)}</td>
                  <td>
                    {(t.detailedResults || []).map((r) => (
                      <span className="badge bad" key={r} style={{ marginRight: 4 }}>
                        {r}
                      </span>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right' }}>{eur(t.amountCents)}</td>
                  <td>{t.live && <ActionButton onClick={async () => setResults({ txn: t, data: await get(`/api/admin/transactions/${t.id}/rule-results`) })}>{tx("Rule results")}</ActionButton>}</td>
                </tr>
              )
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7}>
                  <p className="empty">{tx("No declines.")}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {results && (
        <Modal title={tx("Rule evaluation · {0}", { 0: results.txn.merchant?.descriptor })} onClose={() => setResults(null)} wide>
          {!results.data.length && <p className="empty">{tx("No auth rule produced an action for this transaction.")}</p>}
          <JsonView value={results.data} minHeight={220} />
        </Modal>
      )}
    </div>
  )
}
