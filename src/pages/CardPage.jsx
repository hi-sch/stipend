import { useState } from 'react'
import { useStore } from '../store.jsx'
import EmbeddedCard, { PinSetter } from '../components/EmbeddedCard.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import WalletButtons from '../components/WalletButtons.jsx'
import { ActionButton, ErrorText, Section, StatusBadge, useLoad } from '../components/ui.jsx'
import { del, get, post } from '../api.js'
import { eur, formatDate } from '../lib/format.js'
import { useI18n } from '../i18n/I18n.jsx'
import CashLimit from '../components/CashLimit.jsx'

export default function CardPage() {
  const { t } = useI18n()
  const { cardholder, envelopes, setCardState, refresh } = useStore()
  const card = cardholder.card || {}
  const hasCard = Boolean(card.token)
  const total = envelopes.reduce((s, e) => s + Math.max(0, e.balanceCents), 0)
  const [confirmFreeze, setConfirmFreeze] = useState(false)
  const [error, setError] = useState('')
  const limits = useLoad(() => (hasCard ? get('/api/me/card/spend-limits') : null), [card.token])
  const tokens = useLoad(() => (hasCard ? get('/api/me/tokenizations') : []), [card.token])

  async function changeState(state) {
    setError('')
    setConfirmFreeze(false)
    try {
      await setCardState(state)
    } catch (err) {
      setError(err.message)
    }
  }

  const duration = String(card.spendLimitDuration || 'MONTHLY').toLowerCase()
  const available = limits.data?.available_spend_limit?.[duration === 'annually' ? 'annually' : duration === 'forever' ? 'forever' : 'monthly']

  return (
    <div className="page-stack">
      <div className="grid-2">
        <Section title={t('nav.card')} actions={<StatusBadge status={card.state} />}>
          <EmbeddedCard card={card} holder={`${cardholder.firstName} ${cardholder.lastName}`} />
          <div className="toolbar" style={{ justifyContent: 'center', marginTop: 16 }}>
            {card.state === 'OPEN' ? (
              <button className="btn danger" type="button" onClick={() => setConfirmFreeze(true)} disabled={!card.state}>
                {t('cardPage.freeze')}
              </button>
            ) : card.state === 'PAUSED' ? (
              <button className="btn" type="button" onClick={() => changeState('OPEN')}>
                {t('cardPage.unfreeze')}
              </button>
            ) : null}
          </div>
          <ErrorText error={error} />
        </Section>
        <div className="stack">
          <Section title={t('cardPage.limits')} hint={t('cardPage.limitsHint')}>
            <table className="data">
              <tbody>
                <tr>
                  <td>{t('cardPage.spendable')}</td>
                  <td>{eur(total)}</td>
                </tr>
                {card.spendLimit ? (
                  <tr>
                    <td>{t('cardPage.limits')}</td>
                    <td>
                      {eur(card.spendLimit)} / {duration}
                    </td>
                  </tr>
                ) : null}
                {available !== undefined && (
                  <tr>
                    <td>{t('cardPage.available')}</td>
                    <td>{eur(available)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <ErrorText error={limits.error} />
          </Section>
          {card.type === 'PHYSICAL' ? (
            <Section title={t('cardPage.pin')} hint={t('cardPage.pinHint')}>
              <PinSetter />
            </Section>
          ) : (
            <Section title={t('cardPage.physical')}>
              <p className="muted" style={{ margin: 0 }}>
                {cardholder.physical?.orderedAt ? t('cardPage.physicalOrderedOn', { date: formatDate(cardholder.physical.orderedAt) }) : t('cardPage.physicalNone')}
              </p>
            </Section>
          )}
        </div>
      </div>

      <CashBudget />

      <Section
        title={t('cardPage.tokens')}
        actions={
          hasCard && (
            <button className="btn ghost" type="button" onClick={tokens.reload}>
              {t('common.refresh')}
            </button>
          )
        }
      >
        {!tokens.data?.length && !tokens.loading && <p className="empty">{t('cardPage.tokensEmpty')}</p>}
        {tokens.data?.length ? (
          <table className="data">
            <tbody>
              {tokens.data.map((tok) => (
                <tr key={tok.token}>
                  <td>
                    <strong>{String(tok.requestor || 'Wallet').replaceAll('_', ' ')}</strong>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>{tok.channel}</div>
                  </td>
                  <td>
                    <StatusBadge status={tok.status} />
                  </td>
                  <td>
                    <div className="row-actions">
                      {tok.status === 'ACTIVE' && (
                        <ActionButton onClick={() => post(`/api/me/tokenizations/${tok.token}/pause`).then(tokens.setData)}>{t('cardPage.pause')}</ActionButton>
                      )}
                      {tok.status === 'PAUSED' && (
                        <ActionButton onClick={() => post(`/api/me/tokenizations/${tok.token}/unpause`).then(tokens.setData)}>{t('cardPage.resume')}</ActionButton>
                      )}
                      {!['DEACTIVATED'].includes(tok.status) && (
                        <ActionButton className="btn danger" confirmText={t('cardPage.removeTokenConfirm')} onClick={() => post(`/api/me/tokenizations/${tok.token}/deactivate`).then(tokens.setData)}>
                          {t('cardPage.removeToken')}
                        </ActionButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <ErrorText error={tokens.error} />
        <WalletButtons card={card} onAdded={() => Promise.all([tokens.reload(), refresh()])} />
      </Section>

      {confirmFreeze ? (
        <ConfirmDialog
          title={t('cardPage.freezeConfirmTitle')}
          body={t('cardPage.freezeConfirmBody')}
          confirmLabel={t('cardPage.freeze')}
          onCancel={() => setConfirmFreeze(false)}
          onConfirm={() => changeState('PAUSED')}
        />
      ) : null}
    </div>
  )
}

const PERIODS = ['DAY', 'WEEK', 'MONTH']

/** Cash at cash machines, quasi-cash and cashback at the till: off until the program adds the card to a cash rule. */
function CashBudget() {
  const { t } = useI18n()
  const { cardholder, cashUsage, refresh } = useStore()
  const cash = cardholder.cash || { status: 'NONE' }
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState('MONTH')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const periodName = (p) => t(`cash.period${p || 'MONTH'}`)
  const note = cash.note ? `: ${cash.note}` : ''

  async function request(e) {
    e.preventDefault()
    const cents = Math.round(parseFloat(String(amount).replace(',', '.')) * 100)
    if (!Number.isFinite(cents) || cents <= 0) {
      setError(t('restrict.badAmount'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await post('/api/me/cash-request', { amountCents: cents, period, reason })
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const form = (
    <form className="toolbar" onSubmit={request} style={{ alignItems: 'flex-end' }}>
      <label className="field" style={{ margin: 0 }}>
        <span>{t('cash.requestAmount')}</span>
        <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field" style={{ margin: 0 }}>
        <span>{t('cash.period')}</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {periodName(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="field" style={{ margin: 0, flex: '1 1 240px' }}>
        <span>{t('cash.reason')}</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {t('cash.request')}
      </button>
    </form>
  )

  return (
    <Section title={t('cash.title')} hint={cash.status === 'APPROVED' ? undefined : t('cash.hint')} actions={<StatusBadge status={cash.status === 'APPROVED' ? 'ACTIVE' : cash.status} />}>
      {cash.status === 'APPROVED' && (
        <>
          <CashLimit usage={cashUsage} />
          <p className="muted cash-note">{t('cash.covers')}</p>
        </>
      )}
      {cash.status === 'REQUESTED' && (
        <div className="toolbar">
          <span>{t('cash.requested', { amount: eur(cash.requestedCents), period: periodName(cash.requestedPeriod) })}</span>
          <ActionButton onClick={() => del('/api/me/cash-request').then(refresh)}>{t('cash.withdraw')}</ActionButton>
        </div>
      )}
      {['NONE', 'REJECTED', 'REVOKED', undefined].includes(cash.status) && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            {cash.status === 'REJECTED' ? t('cash.rejected', { note }) : cash.status === 'REVOKED' ? t('cash.revoked', { note }) : t('cash.off')}
          </p>
          {form}
        </div>
      )}
      <ErrorText error={error} />
    </Section>
  )
}
