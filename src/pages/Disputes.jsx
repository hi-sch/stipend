import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStore } from '../store.jsx'
import { ActionButton, ErrorText, KeyValues, Modal, OkText, StatusBadge } from '../components/ui.jsx'
import { api, del, fileToBase64, post } from '../api.js'
import { eur, formatDateTime } from '../lib/format.js'
import { useI18n } from '../i18n/I18n.jsx'

const REASONS = ['FRAUD_CARD_NOT_PRESENT', 'DUPLICATED', 'INCORRECT_AMOUNT', 'GOODS_SERVICES_NOT_RECEIVED', 'GOODS_SERVICES_NOT_AS_DESCRIBED', 'CANCELLED', 'REFUND_NOT_PROCESSED', 'OTHER']

export default function Disputes() {
  const { t } = useI18n()
  const { transactions, disputes, fileDispute, refresh } = useStore()
  const [params] = useSearchParams()
  const disputed = new Set(disputes.filter((d) => d.status !== 'WITHDRAWN').map((d) => d.transactionId))
  const settled = transactions.filter((row) => row.status === 'SETTLED' && row.kind !== 'RETURN' && !disputed.has(row.id))
  const requested = params.get('txn')
  const [txnId, setTxnId] = useState(settled.some((row) => row.id === requested) ? requested : settled[0]?.id || '')
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState(null)
  const open = disputes.find((d) => d.id === openId)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const filed = await fileDispute({ transactionId: txnId, reason, note })
      setMsg({ ok: true, text: filed.status === 'LOCAL' ? t('disputes.local') : t('disputes.filed') })
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid-2">
      <form className="card" onSubmit={submit}>
        <h2>{t('disputes.title')}</h2>
        <p className="muted">{t('disputes.hint')}</p>
        <div className="field">
          <label htmlFor="txn">{t('disputes.transaction')}</label>
          <select id="txn" value={txnId} onChange={(e) => setTxnId(e.target.value)}>
            {settled.map((row) => (
              <option key={row.id} value={row.id}>
                {row.merchant?.descriptor} · {eur(row.amountCents)} · {formatDateTime(row.created)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="reason">{t('disputes.reason')}</label>
          <select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r.replaceAll('_', ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="note">{t('disputes.note')}</label>
          <textarea id="note" value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={busy || !txnId}>
          {t('disputes.submit')}
        </button>
        {msg && (msg.ok ? <OkText>{msg.text}</OkText> : <ErrorText error={msg.text} />)}
      </form>
      <div className="card">
        <h2>{t('disputes.open')}</h2>
        {!disputes.length && <p className="empty">{t('disputes.empty')}</p>}
        <table className="data">
          <tbody>
            {disputes.map((d) => (
              <tr key={d.id} className="clickable" tabIndex={0} onClick={() => setOpenId(d.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(d.id)}>
                <td>
                  <strong>{d.merchant?.descriptor}</strong>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>{d.reason.replaceAll('_', ' ').toLowerCase()}</div>
                </td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td>{formatDateTime(d.created)}</td>
                <td>{eur(d.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <DisputeDetail dispute={open} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  )
}

function DisputeDetail({ dispute, onClose, onChanged }) {
  const { tx, t } = useI18n()
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const active = !['WITHDRAWN', 'CASE_CLOSED', 'CASE_WON'].includes(dispute.status)

  async function upload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      await post(`/api/me/disputes/${dispute.id}/evidence`, { filename: file.name, contentType: file.type, base64: await fileToBase64(file) })
      setMsg(t('disputes.uploaded'))
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal title={dispute.merchant?.descriptor || t('disputes.title')} onClose={onClose}>
      <KeyValues
        rows={[
          [t('disputes.status'), <StatusBadge key="s" status={dispute.status} />],
          [t('table.amount'), eur(dispute.amountCents)],
          [t('disputes.reason'), dispute.reason.replaceAll('_', ' ').toLowerCase()],
          [tx("Filed"), formatDateTime(dispute.created)],
          [tx("Updated"), formatDateTime(dispute.updated || dispute.created)],
          [t('disputes.note'), dispute.note || undefined],
          [tx("Resolution"), dispute.resolutionReason || undefined],
        ]}
      />
      {dispute.lithicToken && (
        <>
          <h3>{t('disputes.evidence')}</h3>
          {!dispute.evidence?.length && <p className="empty">{t('disputes.noEvidence')}</p>}
          <table className="data">
            <tbody>
              {(dispute.evidence || []).map((ev) => (
                <tr key={ev.token}>
                  <td>{ev.filename}</td>
                  <td>
                    <StatusBadge status={ev.status} />
                  </td>
                  <td>
                    {active && ev.status !== 'DELETED' && (
                      <ActionButton onClick={() => del(`/api/me/disputes/${dispute.id}/evidence/${ev.token}`).then(onChanged)}>{t('common.delete')}</ActionButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {active && (
            <div className="field">
              <label htmlFor="evidence">{t('disputes.upload')}</label>
              <input id="evidence" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={uploading} onChange={upload} />
            </div>
          )}
        </>
      )}
      <OkText>{msg}</OkText>
      <ErrorText error={error} />
      <div className="card-actions">
        {dispute.lithicToken && <ActionButton onClick={() => api('POST', `/api/me/disputes/${dispute.id}/refresh`).then(onChanged)}>{t('disputes.refresh')}</ActionButton>}
        {active && (
          <ActionButton
            className="btn danger"
            confirmText={t('disputes.withdrawConfirm')}
            onClick={async () => {
              await post(`/api/me/disputes/${dispute.id}/withdraw`)
              await onChanged()
              setMsg(t('disputes.withdrawn'))
            }}
          >
            {t('disputes.withdraw')}
          </ActionButton>
        )}
        <button className="btn" type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
