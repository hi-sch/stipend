import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Gps01Icon } from '@hugeicons/core-free-icons'
import { useStore } from '../store.jsx'
import { MCC_GROUPS } from '../data/mccs.js'
import { SPEND_COUNTRIES } from '../data/agencies.js'
import MccSelect from '../components/MccSelect.jsx'
import { eur } from '../lib/format.js'
import { locateMerchant } from '../lib/locateMerchant.js'
import { envelopeCovers } from '../lib/auth.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function Restrictions() {
  const { t } = useI18n()
  const { envelopes, tryPurchase } = useStore()
  const [mcc, setMcc] = useState('5411')
  const [amount, setAmount] = useState('12.50')
  const [merchant, setMerchant] = useState('REWE Testkasse')
  const [city, setCity] = useState('Berlin')
  const [country, setCountry] = useState('DEU')
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState('')
  const [result, setResult] = useState(null)

  function submit(e) {
    e.preventDefault()
    const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100)
    const decision = tryPurchase({ amountCents: cents, mcc, merchant, city, country })
    setResult(decision)
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

  return (
    <>
      <p style={{ color: 'var(--muted)', maxWidth: '68ch', marginTop: 0 }}>
        {t('restrict.intro')}
      </p>
      <div className="try-panel">
        <form className="card" onSubmit={submit}>
          <h2>{t('restrict.tryTitle')}</h2>
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>{t('restrict.tryHint')}</p>
          <div className="locate-row">
            <div className="field">
              <label htmlFor="merchant">{t('restrict.merchant')}</label>
              <input id="merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            </div>
            <button
              className="locate-btn"
              type="button"
              onClick={useLocation}
              disabled={locating}
              aria-label={t('restrict.locateAria')}
              title={t('restrict.locateTitle')}
            >
              <HugeiconsIcon icon={Gps01Icon} size={18} color="currentColor" />
            </button>
          </div>
          {locError && <p style={{ color: 'var(--danger)', marginTop: 0 }}>{locError}</p>}
          {locating && <p style={{ color: 'var(--muted)', marginTop: 0 }}>{t('restrict.locating')}</p>}
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
              <input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="mcc">{t('restrict.mcc')}</label>
              <MccSelect id="mcc" value={mcc} onChange={setMcc} />
            </div>
          </div>
          <button className="btn" type="submit">
            {t('restrict.authorize')}
          </button>
          {result && (
            <p style={{ marginBottom: 0, color: result.approved ? 'var(--ok)' : 'var(--danger)' }}>
              {result.approved
                ? t('restrict.approvedOn', {
                    name: envelopes.find((e) => e.id === result.envelopeId)?.connectionName,
                  })
                : result.reason}
            </p>
          )}
        </form>
        <div className="card">
          <h2>{t('restrict.pays')}</h2>
          <p style={{ color: 'var(--muted)', marginTop: 0 }}>
            {t('restrict.paysHint', { mcc, country })}
          </p>
          {envelopes.map((e) => {
            const covers = envelopeCovers(e, mcc, country)
            return (
              <div key={e.id} className={`env-pay ${covers ? 'covers' : ''}`}>
                <strong>{e.connectionName}</strong>
                <span>{t('restrict.remaining', { amount: eur(e.balanceCents) })}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('restrict.allGroups')}</h2>
        {MCC_GROUPS.map((g) => {
          const covering = envelopes.filter((e) => e.mccs.some((c) => g.codes.some(([code]) => code === c)))
          return (
            <div className="group" key={g.id}>
              <h3>
                {t(`mccGroup.${g.id}`)}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                  {covering.length ? covering.map((e) => e.connectionName).join(', ') : t('restrict.notFunded')}
                </span>
              </h3>
              <div className="mcc-grid">
                {g.codes.map(([code, name]) => {
                  const on = envelopes.some((e) => e.mccs.includes(code))
                  return (
                    <span key={code} className={`mcc-opt ${on ? 'on' : ''}`}>
                      {code} {name}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
