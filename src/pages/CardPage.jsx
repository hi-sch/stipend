import { useStore } from '../store.jsx'
import CardFace from '../components/CardFace.jsx'
import { eur } from '../lib/format.js'
import { useI18n } from '../i18n/I18n.jsx'

export default function CardPage() {
  const { t } = useI18n()
  const { cardholder, envelopes, setCardState } = useStore()
  const card = cardholder.card
  const total = envelopes.reduce((s, e) => s + e.balanceCents, 0)
  return (
    <div className="grid-2">
      <div className="card">
        <h2>{t('cardPage.virtual')}</h2>
        <CardFace card={card} holder={`${cardholder.firstName} ${cardholder.lastName}`} details />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
          {card.state === 'OPEN' ? (
            <button className="btn danger" type="button" onClick={() => setCardState('PAUSED')}>
              {t('cardPage.freeze')}
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => setCardState('OPEN')}>
              {t('cardPage.unfreeze')}
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <h2>{t('cardPage.lithic')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('cardPage.lithicHint')}</p>
        <table className="data">
          <tbody>
            <tr>
              <td>card_token</td>
              <td>{card.token}</td>
            </tr>
            <tr>
              <td>account_token</td>
              <td>{cardholder.lithicAccount}</td>
            </tr>
            <tr>
              <td>type</td>
              <td>{card.type}</td>
            </tr>
            <tr>
              <td>state</td>
              <td>{card.state}</td>
            </tr>
            <tr>
              <td>{t('cardPage.spendable')}</td>
              <td>{eur(total)}</td>
            </tr>
            <tr>
              <td>network</td>
              <td>{card.network}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
