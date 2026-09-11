import { Link } from 'react-router-dom'
import { eur, formatDateTime } from '../lib/format.js'
import { mccName } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function TransactionTable({ rows, envelopeName }) {
  const { t } = useI18n()
  if (!rows.length) {
    return <p className="empty">{t('table.empty')}</p>
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t('table.merchant')}</th>
            <th>{t('table.mcc')}</th>
            <th>{t('table.envelope')}</th>
            <th>{t('table.when')}</th>
            <th>{t('table.status')}</th>
            <th style={{ textAlign: 'right' }}>{t('table.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.merchant.descriptor}</strong>
                <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{t.merchant.city}</div>
              </td>
              <td>
                {t.merchant.mcc}
                <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{mccName(t.merchant.mcc)}</div>
              </td>
              <td>{t.envelopeId ? envelopeName(t.envelopeId) : '—'}</td>
              <td>{formatDateTime(t.created)}</td>
              <td>
                <span className={`badge ${t.status === 'DECLINED' ? 'bad' : t.status === 'PENDING' ? 'warn' : 'ok'}`}>
                  {t.status}
                </span>
              </td>
              <td style={{ textAlign: 'right' }} className={t.status === 'DECLINED' ? 'muted' : 'neg'}>
                {t.status === 'DECLINED' ? '' : '−'}
                {eur(t.amountCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TableTools({ q, setQ, extra }) {
  const { t } = useI18n()
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <label className="search">
        <span style={{ color: 'var(--muted)' }}>{t('common.search')}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('table.merchantOrMcc')} />
      </label>
      {extra}
      <Link to="/transactions" className="btn ghost">
        {t('common.filter')}
      </Link>
    </div>
  )
}
