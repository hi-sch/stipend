import { Link } from 'react-router-dom'
import { eur, formatDateTime } from '../lib/format.js'
import { mccName } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function TransactionTable({ rows, envelopeName, onSelect }) {
  const { t } = useI18n()
  if (!rows.length) return <p className="empty">{t('table.empty')}</p>
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
            <th>{t('table.dispute')}</th>
            <th style={{ textAlign: 'right' }}>{t('table.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const refund = row.kind === 'RETURN'
            const inactive = ['DECLINED', 'VOIDED', 'EXPIRED'].includes(row.status)
            return (
              <tr
                key={row.id}
                className={onSelect ? 'clickable' : ''}
                onClick={onSelect ? () => onSelect(row) : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onKeyDown={onSelect ? (e) => e.key === 'Enter' && onSelect(row) : undefined}
              >
                <td>
                  <strong>{row.merchant?.descriptor}</strong>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {row.merchant?.city}
                    {refund ? ` · ${t('txn.refund')}` : ''}
                  </div>
                  {row.note && inactive ? <div style={{ color: 'var(--danger)', fontSize: '0.78rem' }}>{row.note}</div> : null}
                </td>
                <td>
                  {row.merchant?.mcc}
                  <div className="muted" style={{ fontSize: '0.78rem' }}>{mccName(row.merchant?.mcc)}</div>
                </td>
                <td>{row.envelopeId ? envelopeName(row.envelopeId) : '—'}</td>
                <td>{formatDateTime(row.created)}</td>
                <td>
                  <span className={`badge ${row.status === 'SETTLED' ? 'ok' : row.status === 'DECLINED' ? 'bad' : 'warn'}`}>{row.status}</span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {row.status === 'SETTLED' && !refund ? <Link to={`/disputes?txn=${encodeURIComponent(row.id)}`}>{t('table.dispute')}</Link> : '—'}
                </td>
                <td style={{ textAlign: 'right' }} className={inactive ? 'muted' : refund ? 'pos' : 'neg'}>
                  {inactive ? '' : refund ? '+' : '−'}
                  {eur(row.amountCents)}
                </td>
              </tr>
            )
          })}
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
        <span className="muted">{t('common.search')}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('table.merchantOrMcc')} />
      </label>
      {extra}
      <Link to="/transactions" className="btn ghost">
        {t('common.filter')}
      </Link>
    </div>
  )
}
