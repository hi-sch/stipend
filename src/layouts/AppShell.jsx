import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  DashboardSquare01Icon,
  ArrowLeftRightIcon,
  InboxIcon,
  ShieldCheckIcon,
  CreditCardIcon,
  Logout01Icon,
  BalanceScaleIcon,
} from '@hugeicons/core-free-icons'
import { useStore } from '../store.jsx'
import HeaderTools from '../components/HeaderTools.jsx'
import BrandLockup from '../components/BrandLockup.jsx'
import { useI18n } from '../i18n/I18n.jsx'
import { formatLongDate } from '../lib/format.js'

const NAV = [
  { to: '/', key: 'dashboard', icon: DashboardSquare01Icon, end: true },
  { to: '/incoming', key: 'incoming', icon: InboxIcon },
  { to: '/transactions', key: 'transactions', icon: ArrowLeftRightIcon },
  { to: '/restrictions', key: 'restrictions', icon: ShieldCheckIcon },
  { to: '/card', key: 'card', icon: CreditCardIcon },
  { to: '/disputes', key: 'disputes', icon: BalanceScaleIcon },
]

function greet(t, name) {
  const hour = new Date().getHours()
  const key = hour < 12 ? 'greet.morning' : hour < 18 ? 'greet.afternoon' : 'greet.evening'
  return t(key, { name })
}

export default function AppShell() {
  const { cardholder, logout, user, selectCardholder } = useStore()
  const { tx, t } = useI18n()
  const loc = useLocation()
  if (!cardholder) return <p className="empty">{tx("No cardholder.")}</p>
  const titles = {
    '/': { t: greet(t, cardholder.firstName), s: formatLongDate() },
    '/incoming': { t: t('nav.incoming'), s: t('page.incomingSub') },
    '/transactions': { t: t('nav.transactions'), s: t('page.txnSub') },
    '/restrictions': { t: t('nav.restrictions'), s: t('page.restrictSub') },
    '/card': { t: t('nav.card'), s: t('cardPage.sub') },
    '/disputes': { t: t('disputes.title'), s: t('disputes.hint') },
    '/settings': { t: t('settings.title'), s: t('settings.sub') },
  }
  const title = titles[loc.pathname] ?? { t: 'Stipend', s: '' }
  const card = cardholder.card || {}

  return (
    <div className="app">
      <aside className="sidebar">
        <BrandLockup />
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <HugeiconsIcon icon={n.icon} size={18} color="currentColor" />
              {t(`nav.${n.key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div className="device">
            <HugeiconsIcon icon={CreditCardIcon} size={18} color="currentColor" />
            <div>
              <strong>{t('nav.virtual', { lastFour: card.lastFour || '····' })}</strong>
              <small>
                <span className="dot" style={{ display: 'inline-block', marginRight: 6 }} />
                {card.state === 'OPEN' ? t('nav.ready') : card.state}
              </small>
            </div>
          </div>
          <button className="logout" type="button" onClick={logout}>
            <HugeiconsIcon icon={Logout01Icon} size={16} color="currentColor" /> {t('nav.logout')}
          </button>
        </div>
      </aside>
      <div className="main">
        {user?.role === 'admin' && (
          <div className="banner" role="status">
            {t('nav.viewingAs', { name: `${cardholder.firstName} ${cardholder.lastName}` })}
            <Link className="btn ghost" to="/admin/cardholders" onClick={() => selectCardholder(null)}>
              {t('nav.backToAdmin')}
            </Link>
          </div>
        )}
        <header className="topbar">
          <div>
            <h1>{title.t}</h1>
            <div className="sub">{title.s}</div>
          </div>
          <HeaderTools showSettings>
            <div className="userchip">
              <div className="avatar">
                {cardholder.firstName[0]}
                {cardholder.lastName[0]}
              </div>
              <div>
                <strong>
                  {cardholder.firstName} {cardholder.lastName}
                </strong>
                <small>
                  {cardholder.city} · {t('nav.cardholder')}
                </small>
              </div>
            </div>
          </HeaderTools>
        </header>
        <Outlet />
      </div>
    </div>
  )
}
