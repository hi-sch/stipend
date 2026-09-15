import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Gps01Icon } from '@hugeicons/core-free-icons'
import { useStore } from '../store.jsx'
import { MCC_GROUPS } from '../data/mccs.js'
import { SPEND_COUNTRIES } from '../data/agencies.js'
import MccSelect from '../components/MccSelect.jsx'
import { ErrorText, Section, StatusBadge } from '../components/ui.jsx'
import { post } from '../api.js'
import { eur } from '../lib/format.js'
import { locateMerchant } from '../lib/locateMerchant.js'
import { envelopeCovers } from '../lib/auth.js'
import { isCashMcc } from '../lib/cash.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function Restrictions() {
  const { t } = useI18n()
  const { envelopes, tryPurchase, environment, cardholder, cashUsage } = useStore()
  const [mcc, setMcc] = useState('5411')
  const [amount, setAmount] = useState('12.50')
  const [merchant, setMerchant] = useState('REWE Testkasse')
  const [city, setCity] = useState('Berlin')
  const [country, setCountry] = useState('DEU')
  const [partial, setPartial] = useState(false)
  const [cashback, setCashback] = useState('')
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const sandbox = environment === 'sandbox'
  const cents = Math.round(parseFloat(String(amount).replace(',', '.')) * 100)

  async function submit(e) {
    e.preventDefault()
    if (!Number.isFinite(cents) || cents <= 0) {
      setResult({ error: t('restrict.badAmount') })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const cashCents = cashback ? Math.round(parseFloat(String(cashback).replace(',', '.')) * 100) : 0
      const txn = await tryPurchase({ amountCents: cents, mcc, merchant, city, country, partialApprovalCapable: partial, cashCents: Number.isFinite(cashCents) ? cashCents : 0 })
      setResult({ txn })
    } catch (err) {
      setResult({ error: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function useLocation() {
    setLocError('')
    setLocating(true)
    try {
      const found = await locateMerchant()
      if (found.merchant) setMerchant(found.merchant)
      if (found.city) setCity(found.city)
      if (found.mcc) setMcc(found.mcc)
      if (found.country) setCountry(found.country)
    } catch (err) {
      setLocError(err.message || t('restrict.locateError'))
    } finally {
      setLocating(false)
    }
  }

  const txn = result?.txn
  const approved = txn && !['DECLINED', 'VOIDED'].includes(txn.status)
  const envName = (id) => envelopes.find((e) => e.id === id)?.connectionName || '—'

  return (
    <div className="page-stack">
      <p className="muted" style={{ maxWidth: '68ch', margin: 0 }}>{t('restrict.intro')}</p>
      <div className="try-panel">
        {sandbox ? (
          <form className="card" onSubmit={submit}>
            <h2>{t('restrict.tryTitle')}</h2>
            <p className="synth" style={{ marginTop: 0 }}>{t('restrict.sandboxOnly')}</p>
            <div className="locate-row">
              <div className="field">
                <label htmlFor="merchant">{t('restrict.merchant')}</label>
                <input id="merchant" value={merchant} maxLength={25} onChange={(e) => setMerchant(e.target.value)} />
              </div>
              <button className="locate-btn" type="button" onClick={useLocation} disabled={locating} aria-label={t('restrict.locateAria')} title={t('restrict.locateTitle')}>
                <HugeiconsIcon icon={Gps01Icon} size={18} color="currentColor" />
              </button>
            </div>
            <ErrorText error={locError} />
            {locating && <p className="muted" style={{ marginTop: 0 }}>{t('restrict.locating')}</p>}
            <div className="row-2">
              <div className="field">
                <label htmlFor="city">{t('restrict.city')}</label>
                <input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="country">{t('restrict.country')}</label>
                <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {SPEND_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row-2">
              <div className="field">
                <label htmlFor="amount">{t('restrict.amount')}</label>
                <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="mcc">{t('restrict.mcc')}</label>
                <MccSelect id="mcc" value={mcc} onChange={setMcc} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cashback">{t('cash.cashback')}</label>
              <input id="cashback" inputMode="decimal" placeholder="0.00" value={cashback} onChange={(e) => setCashback(e.target.value)} />
            </div>
            <label className="check">
              <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
              {t('restrict.partial')}
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? t('lithic.authorizing') : t('restrict.authorize')}
            </button>
            <ErrorText error={result?.error} />
            {txn && (
              <p style={{ marginBottom: 0, color: approved ? 'var(--ok)' : 'var(--danger)' }}>
                <StatusBadge status={txn.status} />{' '}
                {approved
                  ? txn.requestedCents > txn.amountCents
                    ? t('restrict.approvedPartial', { amount: eur(txn.amountCents), requested: eur(txn.requestedCents), name: envName(txn.envelopeId) })
                    : t('restrict.approvedOn', { name: envName(txn.envelopeId) })
                  : txn.note || (txn.detailedResults || []).join(', ')}
              </p>
            )}
          </form>
        ) : (
          <div className="card">
            <h2>{t('restrict.tryTitle')}</h2>
            <p className="muted">{t('restrict.sandboxOnly')}</p>
          </div>
        )}
        <div className="card">
          <h2>{t('restrict.pays')}</h2>
          <p className="muted" style={{ marginTop: 0 }}>{t('restrict.paysHint', { mcc, country })}</p>
          {isCashMcc(mcc) && (
            <p className="cash-note" style={{ marginTop: 0 }}>
              {cashUsage ? t('cash.categoryLeft', { left: eur(cashUsage.remainingCents) }) : t('cash.categoryOff')}
            </p>
          )}
          {envelopes.map((e) => (
            <div key={e.id} className={`env-pay ${envelopeCovers(e, mcc, country) ? 'covers' : ''}`}>
              <strong>{e.connectionName}</strong>
              <span>{t('restrict.remaining', { amount: eur(e.balanceCents) })}</span>
            </div>
          ))}
        </div>
      </div>

      {sandbox && cardholder.card?.token && <ThreeDsPanel merchant={merchant} mcc={mcc} country={country} cents={cents} />}

      <div className="card">
        <h2>{t('restrict.allGroups')}</h2>
        {MCC_GROUPS.map((g) => {
          const covering = envelopes.filter((e) => (e.mccs || []).some((c) => g.codes.some(([code]) => code === c)))
          return (
            <div className="group" key={g.id}>
              <h3>
                {t(`mccGroup.${g.id}`)}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {covering.length ? covering.map((e) => e.connectionName).join(', ') : t('restrict.notFunded')}
                </span>
              </h3>
              <div className="mcc-grid">
                {g.codes.map(([code, name]) => (
                  <span key={code} className={`mcc-opt ${envelopes.some((e) => (e.mccs || []).includes(code)) ? 'on' : ''}`}>
                    {code} {name}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ThreeDsPanel({ merchant, mcc, country, cents }) {
  const { t } = useI18n()
  const [auth, setAuth] = useState(null)
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const detail = auth?.authentication
  return (
    <Section title={t('restrict.online')} hint={t('restrict.onlineHint')}>
      <div className="toolbar">
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => run(async () => setAuth(await post('/api/me/3ds', { merchant, mcc, country, amountCents: Number.isFinite(cents) ? cents : 100 })))}
        >
          {t('restrict.run3ds')}
        </button>
        {detail && <StatusBadge status={detail.authentication_result} />}
      </div>
      {detail?.authentication_result === 'PENDING_CHALLENGE' || detail?.challenge ? (
        <form
          className="toolbar"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => setAuth({ ...auth, authentication: await post(`/api/me/3ds/${auth.token}/otp`, { otp }) }))
          }}
        >
          <label className="field" style={{ margin: 0 }}>
            <span>{t('restrict.otp')}</span>
            <input value={otp} inputMode="numeric" onChange={(e) => setOtp(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy || !otp}>
            {t('restrict.submitOtp')}
          </button>
        </form>
      ) : null}
      <ErrorText error={error} />
    </Section>
  )
}
