import { Link } from 'react-router-dom'
import { Modal, KeyValues, StatusBadge } from './ui.jsx'
import { eur, formatDateTime } from '../lib/format.js'
import { mccName } from '../data/mccs.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function TransactionDetail({ txn, envelopeName, onClose, children }) {
  const { t } = useI18n()
  const partial = txn.requestedCents && txn.amountCents && txn.requestedCents > txn.amountCents && txn.status !== 'DECLINED'
  return (
    <Modal title={txn.merchant?.descriptor || t('txn.detail')} onClose={onClose} wide>
      <KeyValues
        rows={[
          [t('table.status'), <StatusBadge key="s" status={txn.status} />],
          [t('table.amount'), `${txn.kind === 'RETURN' ? '+' : ''}${eur(txn.amountCents)}`],
          [t('txn.requested'), partial ? eur(txn.requestedCents) : undefined],
          [t('table.mcc'), `${txn.merchant?.mcc} ${mccName(txn.merchant?.mcc)}`],
          [t('table.envelope'), txn.envelopeId ? envelopeName(txn.envelopeId) : '—'],
          [t('table.when'), formatDateTime(txn.created)],
          [t('restrict.city'), [txn.merchant?.city, txn.merchant?.country].filter(Boolean).join(', ') || '—'],
          [t('txn.reason'), txn.note || undefined],
          ['Lithic', txn.live ? txn.id : '—'],
        ]}
      />
      {partial && <p className="muted">{t('txn.partial')}</p>}
      {txn.events?.length ? (
        <>
          <h3>{t('txn.events')}</h3>
          <table className="data">
            <tbody>
              {txn.events.map((e, i) => (
                <tr key={e.token || i}>
                  <td>{e.type}</td>
                  <td>{e.result}</td>
                  <td>{(e.detailedResults || []).join(', ')}</td>
                  <td>{e.created ? formatDateTime(e.created) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{eur(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <div className="card-actions">
        {txn.status === 'SETTLED' && txn.kind !== 'RETURN' && (
          <Link className="btn ghost" to={`/disputes?txn=${encodeURIComponent(txn.id)}`}>
            {t('table.dispute')}
          </Link>
        )}
        {children}
        <button className="btn" type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
