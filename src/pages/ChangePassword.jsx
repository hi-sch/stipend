import { useState } from 'react'
import { useStore } from '../store.jsx'
import BrandLockup from '../components/BrandLockup.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function ChangePassword({ forced = false }) {
  const { changePassword, logout } = useStore()
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (next !== repeat) {
      setMsg({ ok: false, text: t('password.mismatch') })
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setMsg({ ok: true, text: t('password.changed') })
      setCurrent('')
      setNext('')
      setRepeat('')
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const form = (
    <form className="card" style={{ width: forced ? 'min(440px, 100%)' : '100%' }} onSubmit={submit}>
      {forced && <BrandLockup />}
      <h2 style={{ marginTop: forced ? 16 : 0 }}>{t('password.title')}</h2>
      {forced && <p style={{ color: 'var(--muted)' }}>{t('password.forced')}</p>}
      <div className="field">
        <label htmlFor="pw-current">{t('password.current')}</label>
        <input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-new">{t('password.new')}</label>
        <input id="pw-new" type="password" autoComplete="new-password" minLength={10} required value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-repeat">{t('password.repeat')}</label>
        <input id="pw-repeat" type="password" autoComplete="new-password" minLength={10} required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </div>
      {msg && <p role="status" style={{ color: msg.ok ? 'var(--ok)' : 'var(--danger)' }}>{msg.text}</p>}
      <div className="card-actions">
        {forced && (
          <button className="btn ghost" type="button" onClick={logout}>
            {t('nav.logout')}
          </button>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {t('password.save')}
        </button>
      </div>
    </form>
  )
  return forced ? <div className="login-page">{form}</div> : form
}
