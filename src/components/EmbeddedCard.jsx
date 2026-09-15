import { useEffect, useRef, useState } from 'react'
import CardFace from './CardFace.jsx'
import { post } from '../api.js'
import { useI18n } from '../i18n/I18n.jsx'

// Loaded on demand so cardholders who never reveal details don't download the SDK.
const loadEmbedSdk = () => import('lithic-embed')

// Lithic's embed page cannot load web fonts, so the card lettering uses a system monospace stack
// (see .plastic-meta) and hands the exact same values to each iframe.
const LETTERING = ['color', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'line-height', 'font-variant-numeric', 'text-transform']

function lettering(element) {
  const computed = getComputedStyle(element)
  const styles = Object.fromEntries(LETTERING.map((prop) => [prop, computed.getPropertyValue(prop)]))
  return { ...styles, 'text-align': 'right' }
}

/**
 * Card details rendered by Lithic's embed iframes, so the PAN and CVC never pass through Stipend.
 * Each iframe overlays the masked value box of the same size (see CardFace).
 */
export default function EmbeddedCard({ card, holder }) {
  const { t } = useI18n()
  const pan = useRef(null)
  const cvv = useRef(null)
  const month = useRef(null)
  const year = useRef(null)
  const embed = useRef(null)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setRevealed(false)
    return () => {
      embed.current?.unmount().catch(() => {})
      embed.current = null
    }
  }, [card?.token])

  async function toggle() {
    setBusy(true)
    setError('')
    try {
      if (!embed.current) {
        const [{ session, environment }, { default: LithicEmbed, Environment }] = await Promise.all([
          post('/api/me/card/embed', { type: 'CARD_EMBED' }),
          loadEmbedSdk(),
        ])
        const client = new LithicEmbed(Environment[environment] || Environment.SANDBOX)
        const next = client.card(session, { syncStyles: false })
        await next.mount({
          pan: { element: pan.current, styles: lettering(pan.current) },
          cvv: { element: cvv.current, styles: lettering(cvv.current) },
          expMonth: { element: month.current, styles: lettering(month.current) },
          expYear: { element: year.current, styles: lettering(year.current) },
        })
        embed.current = next
      }
      await embed.current.toggleMasking()
      setRevealed((v) => !v)
    } catch (err) {
      await embed.current?.unmount().catch(() => {})
      embed.current = null
      setRevealed(false)
      setError(t('cardPage.embedFailed', { error: err.message }))
    } finally {
      setBusy(false)
    }
  }

  if (!card?.token) {
    return (
      <CardFace card={card} holder={holder}>
        <p className="muted" style={{ textAlign: 'center' }}>
          {t('cardPage.noCard')}
        </p>
      </CardFace>
    )
  }

  const cls = `embed-field${revealed ? ' on' : ''}`
  return (
    <CardFace
      card={card}
      holder={holder}
      revealed={revealed}
      slots={{
        pan: <span ref={pan} className={cls} />,
        cvv: <span ref={cvv} className={cls} />,
        expMonth: <span ref={month} className={cls} />,
        expYear: <span ref={year} className={cls} />,
      }}
    >
      <div className="card-secrets">
        <button className="btn ghost" type="button" onClick={toggle} disabled={busy} aria-pressed={revealed}>
          {busy ? t('common.loading') : revealed ? t('cardPage.hideDetails') : t('cardPage.showDetails')}
        </button>
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      </div>
    </CardFace>
  )
}

export function PinSetter() {
  const { t } = useI18n()
  const target = useRef(null)
  const embed = useRef(null)
  const [stage, setStage] = useState('idle')
  const [error, setError] = useState('')

  useEffect(() => () => embed.current?.unmount().catch(() => {}), [])

  async function start() {
    setError('')
    setStage('loading')
    try {
      const [{ session, environment }, { default: LithicEmbed, Environment }] = await Promise.all([
        post('/api/me/card/embed', { type: 'PIN_SETTING_EMBED' }),
        loadEmbedSdk(),
      ])
      embed.current = new LithicEmbed(Environment[environment] || Environment.SANDBOX).pinSetting(session, {})
      await embed.current.mount(target.current)
      setStage('ready')
    } catch (err) {
      setError(err.message)
      setStage('idle')
    }
  }

  async function submit() {
    setError('')
    try {
      await embed.current.submit()
      setStage('done')
      await embed.current.unmount()
      embed.current = null
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="stack">
      <div ref={target} className="pin-slot" hidden={stage === 'idle' || stage === 'done'} />
      {stage === 'idle' && (
        <button className="btn ghost" type="button" onClick={start}>
          {t('cardPage.setPin')}
        </button>
      )}
      {stage === 'ready' && (
        <button className="btn" type="button" onClick={submit}>
          {t('password.save')}
        </button>
      )}
      {stage === 'done' && <p style={{ color: 'var(--ok)' }}>{t('cardPage.pinSaved')}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}
