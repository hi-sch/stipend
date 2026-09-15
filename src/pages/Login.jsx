import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store.jsx'
import BrandLockup from '../components/BrandLockup.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function Login() {
  const { login, user } = useStore()
  const { t } = useI18n()
  const nav = useNavigate()
  const loc = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (user) return <Navigate to={user.role === 'admin' ? '/admin' : '/'} replace />

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const signedIn = await login(email, password)
      const from = loc.state?.from
      nav(from && from !== '/login' ? from : signedIn.role === 'admin' ? '/admin' : '/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="card" style={{ width: 'min(420px, 100%)' }} onSubmit={submit}>
        <BrandLockup />
        <p style={{ color: 'var(--muted)' }}>{t('login.sub')}</p>
        <div className="field">
          <label htmlFor="login-email">{t('login.email')}</label>
          <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">{t('login.password')}</label>
          <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t('login.signingIn') : t('login.signIn')}
        </button>
      </form>
    </div>
  )
}
