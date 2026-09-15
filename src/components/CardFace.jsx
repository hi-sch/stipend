import { useI18n } from '../i18n/I18n.jsx'

/**
 * Card plastic. Every value sits in a fixed box sized in characters; with `slots` a Lithic embed
 * iframe is overlaid on the same box, so masked and revealed text share font, size and position.
 */
export default function CardFace({ card, holder, slots, revealed = false, children }) {
  const { t } = useI18n()
  const paused = card?.state !== 'OPEN'
  const lastFour = card?.lastFour || '••••'
  const name = (holder || '').toUpperCase()
  const visa = String(card?.network || 'visa').toLowerCase().includes('visa')
  const shown = Boolean(slots) && revealed
  return (
    <div className="card-face">
      <div className={`plastic ${paused ? 'is-paused' : ''}`}>
        <div className="plastic-rail">{visa ? <VisaMark /> : <MastercardMark />}</div>
        <div className="plastic-body">
          <p className="brand-mark">stipend</p>
          <span className="emv-chip" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <div className="plastic-meta">
            <div className="plastic-cvc">
              CVC <CardValue chars={3} masked="***" slot={slots?.cvv} shown={shown} />
            </div>
            <div className="plastic-row">
              <CardValue chars={19} masked={`**** **** **** ${lastFour}`} slot={slots?.pan} shown={shown} label="Card number" />
            </div>
            <div className="plastic-holder">
              <span>
                <CardValue chars={2} masked="**" slot={slots?.expMonth} shown={shown} />/
                <CardValue chars={2} masked="**" slot={slots?.expYear} shown={shown} />
              </span>
              <span>{name}</span>
            </div>
          </div>
        </div>
      </div>
      {card?.state && card.state !== 'OPEN' ? (
        <p className="muted" style={{ textAlign: 'center' }}>
          {t('cardPage.frozenNote')}
        </p>
      ) : null}
      {children}
    </div>
  )
}

function CardValue({ chars, masked, slot, shown, label }) {
  return (
    <span className="card-value" style={{ '--chars': chars }}>
      <span className="card-mask" aria-hidden={shown} aria-label={label}>
        {masked}
      </span>
      {slot}
    </span>
  )
}

function VisaMark() {
  return (
    <svg className="visa-mark" viewBox="0 0 1000 325" aria-label="Visa">
      <path
        fill="#fff"
        d="m651.19.5c-70.93,0-134.32,36.77-134.32,104.69,0,77.9,112.42,83.28,112.42,122.42,0,16.48-18.88,31.23-51.14,31.23-45.77,0-79.98-20.61-79.98-20.61l-14.64,68.55s39.41,17.41,91.73,17.41c77.55,0,138.58-38.57,138.58-107.66,0-82.32-112.89-87.54-112.89-123.86,0-12.91,15.5-27.05,47.66-27.05,36.29,0,65.89,14.99,65.89,14.99l14.33-66.2S696.61.5,651.18.5h0ZM2.22,5.5L.5,15.49s29.84,5.46,56.72,16.36c34.61,12.49,37.07,19.77,42.9,42.35l63.51,244.83h85.14L379.93,5.5h-84.94l-84.28,213.17-34.39-180.7c-3.15-20.68-19.13-32.48-38.68-32.48,0,0-135.41,0-135.41,0Zm411.87,0l-66.63,313.53h81L494.85,5.5h-80.76Zm451.76,0c-19.53,0-29.88,10.46-37.47,28.73l-118.67,284.8h84.94l16.43-47.47h103.48l9.99,47.47h74.95L934.12,5.5h-68.27Zm11.05,84.71l25.18,117.65h-67.45l42.28-117.65h0Z"
      />
    </svg>
  )
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
