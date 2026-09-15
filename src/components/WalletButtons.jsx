import { useEffect, useRef, useState } from 'react'
import { get, post } from '../api.js'
import { useI18n } from '../i18n/I18n.jsx'

const APPLE_SCRIPT = 'https://smp-device-content.apple.com/navweb/asset/initAddToAppleWallet.js'
const GOOGLE_SCRIPT = 'https://developers.google.com/static/pay/issuers/apis/push-provisioning/web/downloads/integration.min.js'

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((s) => s.src === src)
    if (existing) return existing.dataset.failed === '1' ? reject(new Error(`Failed to load ${src}`)) : resolve()
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      el.dataset.failed = '1'
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(el)
  })
}

/**
 * Add to Apple / Google Wallet.
 * Sandbox: Lithic cannot push to real wallets, so the buttons create a simulated wallet token.
 * Production: real web push, shown only for wallets the program is enabled for.
 */
export default function WalletButtons({ card, onAdded }) {
  const { t } = useI18n()
  const [config, setConfig] = useState(null)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState('')
  const appleBound = useRef(false)

  useEffect(() => {
    if (!card?.token) return
    get('/api/me/wallets/config')
      .then(setConfig)
      .catch((err) => setNote({ ok: false, text: err.message }))
  }, [card?.token])

  if (!card?.token || !config) return null

  const showApple = config.sandbox || config.applePay === 'available'
  const showGoogle = config.sandbox || config.googlePay

  async function simulate(wallet, label) {
    setBusy(wallet)
    setNote(null)
    try {
      await post('/api/me/wallets/simulate', { wallet })
      setNote({ ok: true, text: t('cardPage.walletTestAdded', { wallet: label }) })
      await onAdded?.()
    } catch (err) {
      setNote({ ok: false, text: err.message })
    } finally {
      setBusy('')
    }
  }

  async function appleJws() {
    const res = await post('/api/me/wallets/web-provision', { digitalWallet: 'APPLE_PAY' })
    const jws = res?.jws || res?.apple_pay?.jws
    const state = res?.state || res?.apple_pay?.state
    if (!jws || !state) throw new Error('Lithic did not return an Apple Wallet JWS.')
    return { jws, state }
  }

  async function addApple(event) {
    if (config.sandbox) return simulate('APPLE_PAY', 'Apple Wallet')
    if (appleBound.current) return undefined
    event.preventDefault()
    setNote(null)
    try {
      await loadScript(APPLE_SCRIPT)
      if (!window.initAddToAppleWallet) throw new Error('Apple Wallet script did not load.')
      window.initAddToAppleWallet({
        partnerId: config.applePartnerId,
        domain: 'https://apple-pay.apple.com',
        buttonId: 'add-to-apple-wallet',
        cardType: 'PAYMENT',
        jwsResolver: appleJws,
        jwtResolver: appleJws,
        resultResolver: (result) => {
          const status = String(result?.status ?? '')
          if (['200', '202', '206'].includes(status)) {
            setNote({ ok: true, text: t('cardPage.walletAdded', { wallet: 'Apple Wallet' }) })
            onAdded?.()
          } else if (status !== '444') {
            setNote({ ok: false, text: result?.statusMessage || `Apple Wallet failed (${status || 'unknown'}).` })
          }
        },
      })
      appleBound.current = true
      document.getElementById('add-to-apple-wallet')?.click()
    } catch (err) {
      setNote({ ok: false, text: err.message })
    }
    return undefined
  }

  async function addGoogle() {
    if (config.sandbox) return simulate('GOOGLE_PAY', 'Google Wallet')
    setNote(null)
    try {
      await loadScript(GOOGLE_SCRIPT)
      if (!window.googlepay?.openAppWindow) throw new Error('Google Pay script did not load.')
      window.googlepay.openAppWindow({
        integratorId: config.googleIntegratorId,
        tokenSetting: 1,
        cardSetting: 1,
        clientSessionId: crypto.randomUUID(),
        onSessionCreated: async (payload) => {
          try {
            const creds = await post('/api/me/wallets/web-provision', {
              digitalWallet: 'GOOGLE_PAY',
              serverSessionId: payload.serverSessionId,
              clientDeviceId: payload.publicDeviceId,
              clientWalletAccountId: payload.publicWalletId,
            })
            window.googlepay.pushPaymentCredentials(creds)
          } catch (err) {
            setNote({ ok: false, text: err.message })
          }
        },
        onSuccess: () => {
          setNote({ ok: true, text: t('cardPage.walletAdded', { wallet: 'Google Wallet' }) })
          onAdded?.()
        },
        onFailure: (err) => setNote({ ok: false, text: err?.message || 'Google Wallet failed.' }),
      })
    } catch (err) {
      setNote({ ok: false, text: err.message })
    }
    return undefined
  }

  if (!showApple && !showGoogle) return <p className="wallet-note">{t('cardPage.walletUnavailable')}</p>

  return (
    <div className="wallet-btns">
      {showApple && (
        <button id="add-to-apple-wallet" className="wallet-badge apple" type="button" onClick={addApple} disabled={Boolean(busy)}>
          <AppleWalletMark />
          <span>
            {t('cardPage.addTo')}
            <strong>Apple Wallet</strong>
          </span>
        </button>
      )}
      {showGoogle && (
        <button className="wallet-badge google" type="button" onClick={addGoogle} disabled={Boolean(busy)}>
          <GoogleWalletMark />
          <span>
            {t('cardPage.addTo')}
            <strong>Google Wallet</strong>
          </span>
        </button>
      )}
      {config.sandbox && <p className="wallet-note">{t('cardPage.walletSandboxHint')}</p>}
      {note && (
        <p className="wallet-note" role="status" style={{ color: note.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {note.text}
        </p>
      )}
    </div>
  )
}

function AppleWalletMark() {
  return (
    <svg className="wallet-apple-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="#fff"
        d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"
      />
    </svg>
  )
}

function GoogleWalletMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}
