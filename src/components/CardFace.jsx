import { useState } from 'react'
import { useI18n } from '../i18n/I18n.jsx'

export default function CardFace({ card, holder, details = false }) {
  const { t } = useI18n()
  const [reveal, setReveal] = useState(false)
  const paused = card.state !== 'OPEN'
  const pan = formatPan(card.pan)
  const exp = `${card.expMonth}/${String(card.expYear).slice(-2)}`
  const name = (holder || card.memo || '').replace(/^Stipend\s*·\s*/i, '')

  const showPan = details && reveal ? pan : maskDigits(pan)
  const showExp = details && reveal ? exp : '**/**'

  return (
    <div className="card-face">
      <div className={`plastic ${paused ? 'is-paused' : ''}`}>
        <div className="plastic-rail">
          <MastercardMark />
        </div>
        <div className="plastic-body">
          <p className="brand-mark">stipend</p>
          <span className="emv-chip" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <div className="plastic-meta">
            {details && reveal ? <div className="plastic-cvc">CVC {card.cvv}</div> : null}
            <div className="plastic-row">{showPan}</div>
            <div className="plastic-holder">
              <span>{showExp}</span>
              <span>{name.toUpperCase()}</span>
            </div>
          </div>
        </div>
      </div>
      {details ? (
        <div className="card-secrets">
          <button className="btn ghost" type="button" onClick={() => setReveal((v) => !v)}>
            {reveal ? t('common.hide') : t('common.show')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function formatPan(pan) {
  return String(pan)
    .replace(/\s/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim()
}

function maskDigits(value) {
  const digits = String(value).replace(/\s/g, '')
  const last4 = digits.slice(-4)
  const hidden = digits.slice(0, -4).replace(/\d/g, '*')
  return formatPan(hidden + last4)
}

function MastercardMark() {
  return (
    <svg className="mc-mark" viewBox="0 0 16 24" aria-label="Mastercard">
      <circle cx="8" cy="7.5" r="7.5" fill="#EB001B" />
      <circle cx="8" cy="16.5" r="7.5" fill="#F79E1B" />
      <path fill="#FF5F00" d="M2 12 A 7.5 7.5 0 0 1 14 12 A 7.5 7.5 0 0 1 2 12 z" />
    </svg>
  )
}
