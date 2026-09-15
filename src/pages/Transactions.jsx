import { useState } from 'react'
import { useStore } from '../store.jsx'
import TransactionTable from '../components/TransactionTable.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import { ActionButton } from '../components/ui.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function Transactions() {
  const { t } = useI18n()
  const { transactions, envelopes, sync, lithic } = useStore()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState(null)
  const names = Object.fromEntries(envelopes.map((e) => [e.id, e.connectionName]))
  const rows = transactions.filter((row) => {
    const blob = `${row.merchant?.descriptor} ${row.merchant?.mcc} ${row.status}`.toLowerCase()
    return blob.includes(q.toLowerCase()) && (status === 'all' || row.status === status)
  })

  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('txn.events', { count: rows.length })}</h2>
        <div className="toolbar">
          <label className="search">
            <span className="muted">{t('common.search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('txn.placeholder')} />
          </label>
          <select className="country-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('table.status')}>
            <option value="all">{t('txn.allStatuses')}</option>
            <option value="SETTLED">{t('txn.settled')}</option>
            <option value="PENDING">{t('txn.pending')}</option>
            <option value="DECLINED">{t('txn.declined')}</option>
            <option value="VOIDED">{t('txn.voided')}</option>
            <option value="EXPIRED">{t('txn.expired')}</option>
          </select>
          {lithic?.configured && <ActionButton onClick={sync}>{t('txn.sync')}</ActionButton>}
        </div>
      </div>
      <TransactionTable rows={rows} envelopeName={(id) => names[id] || '—'} onSelect={setSelected} />
      {selected && <TransactionDetail txn={selected} envelopeName={(id) => names[id] || '—'} onClose={() => setSelected(null)} />}
    </div>
  )
}
