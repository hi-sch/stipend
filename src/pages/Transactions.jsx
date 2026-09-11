import { useState } from 'react'
import { useStore } from '../store.jsx'
import TransactionTable from '../components/TransactionTable.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function Transactions() {
  const { t } = useI18n()
  const { transactions, envelopes } = useStore()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const names = Object.fromEntries(envelopes.map((e) => [e.id, e.connectionName]))
  const rows = transactions.filter((t) => {
    const blob = `${t.merchant.descriptor} ${t.merchant.mcc} ${t.status}`.toLowerCase()
    const okQ = blob.includes(q.toLowerCase())
    const okS = status === 'all' || t.status === status
    return okQ && okS
  })

  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('txn.events', { count: rows.length })}</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="search">
            <span style={{ color: 'var(--muted)' }}>{t('common.search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('txn.placeholder')} />
          </label>
          <select className="country-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">{t('txn.allStatuses')}</option>
            <option value="SETTLED">{t('txn.settled')}</option>
            <option value="PENDING">{t('txn.pending')}</option>
            <option value="DECLINED">{t('txn.declined')}</option>
          </select>
        </div>
      </div>
      <TransactionTable rows={rows} envelopeName={(id) => names[id] || '—'} />
    </div>
  )
}
