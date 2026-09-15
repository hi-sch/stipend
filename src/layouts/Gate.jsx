import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useStore } from '../store.jsx'
import ChangePassword from '../pages/ChangePassword.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function Gate({ role }) {
  const { tx } = useI18n()
  const { ready, user, loaded, error, viewAs } = useStore()
  const loc = useLocation()
  if (!ready) return <div className="login-page"><p className="empty">{tx("Loading…")}</p></div>
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (user.mustChangePassword) return <ChangePassword forced />
  if (role === 'admin' && user.role !== 'admin') return <Navigate to="/" replace />
  if (!role && user.role === 'admin' && !viewAs && loc.pathname === '/') return <Navigate to="/admin" replace />
  if (!loaded) {
    return (
      <div className="login-page">
        <p className="empty">{error || 'Loading…'}</p>
      </div>
    )
  }
  return <Outlet />
}
