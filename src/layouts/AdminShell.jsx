import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  DashboardSquare01Icon,
  CableIcon,
  BankIcon,
  UserGroupIcon,
  BanIcon,
  FlaskConicalIcon,
  Logout01Icon,
  Analytics01Icon,
  Alert02Icon,
  Chart01Icon,
  ShieldCheckIcon,
  WebhookIcon,
  File01Icon,
} from '@hugeicons/core-free-icons'
import { useStore } from '../store.jsx'
import HeaderTools from '../components/HeaderTools.jsx'
import BrandLockup from '../components/BrandLockup.jsx'
import { useI18n } from '../i18n/I18n.jsx'

const NAV = [
  { to: '/admin', key: 'overview', icon: DashboardSquare01Icon, end: true },
  { to: '/admin/connections', key: 'connections', icon: CableIcon },
  { to: '/admin/credits', key: 'credits', icon: BankIcon },
  { to: '/admin/cardholders', key: 'cardholders', icon: UserGroupIcon },
  { to: '/admin/declines', key: 'declines', icon: BanIcon },
  { to: '/admin/rules', key: 'rules', icon: ShieldCheckIcon },
  { to: '/admin/asa', key: 'asa', icon: Analytics01Icon },
  { to: '/admin/integrations', key: 'integrations', icon: WebhookIcon },
  { to: '/admin/ledger', key: 'ledger', icon: Chart01Icon },
  { to: '/admin/cases', key: 'cases', icon: Alert02Icon },
  { to: '/admin/sandbox', key: 'sandbox', icon: FlaskConicalIcon },
  { to: '/admin/audit', key: 'audit', icon: File01Icon },
]

export default function AdminShell() {
  const { operator, logout, user } = useStore()
  const { tx, t } = useI18n()
  const loc = useLocation()
  const name = user?.name || operator?.name || 'Operator'
  const onSettings = loc.pathname === '/admin/settings'
  return (
    <div className="app">
      <aside className="sidebar">
        <BrandLockup />
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <HugeiconsIcon icon={n.icon} size={18} color="currentColor" />
              {t(`adminNav.${n.key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <button className="logout" type="button" onClick={logout}>
            <HugeiconsIcon icon={Logout01Icon} size={16} color="currentColor" /> {t('nav.logout')}
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <h1>{onSettings ? t('settings.title') : t('adminNav.title')}</h1>
            <div className="sub">{onSettings ? tx("Preferences, program details and server configuration") : t('adminNav.sub')}</div>
          </div>
          <HeaderTools showSettings settingsPath="/admin/settings">
            <div className="userchip">
              <div className="avatar">
                {name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)}
              </div>
              <div>
                <strong>{name}</strong>
                <small>{user?.email}</small>
              </div>
            </div>
          </HeaderTools>
        </header>
        <Outlet />
      </div>
    </div>
  )
}
