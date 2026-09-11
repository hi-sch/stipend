import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  DashboardSquare01Icon,
  ArrowLeftRightIcon,
  InboxIcon,
  ShieldCheckIcon,
  CreditCardIcon,
  Logout01Icon,
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
]

function greet(t, name) {
  const hour = new Date().getHours()
  const key = hour < 12 ? 'greet.morning' : hour < 18 ? 'greet.afternoon' : 'greet.evening'
  return t(key, { name })
}

export default function AppShell() {
  const { cardholder } = useStore()
  const { t } = useI18n()
  const loc = useLocation()
  const titles = {
    '/': { t: greet(t, cardholder.firstName), s: formatLongDate() },
    '/incoming': { t: t('nav.incoming'), s: t('page.incomingSub') },
    '/transactions': { t: t('nav.transactions'), s: t('page.txnSub') },
    '/restrictions': { t: t('nav.restrictions'), s: t('page.restrictSub') },
    '/card': { t: t('cardPage.virtual'), s: t('cardPage.lithicHint') },
    '/settings': { t: t('settings.title'), s: t('settings.sub') },
  }
  const title = titles[loc.pathname] ?? { t: 'Stipend', s: '' }

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
              <strong>{t('nav.virtual', { lastFour: cardholder.card.lastFour })}</strong>
              <small>
                <span className="dot" style={{ display: 'inline-block', marginRight: 6 }} />
                {cardholder.card.state === 'OPEN' ? t('nav.ready') : cardholder.card.state}
              </small>
            </div>
          </div>
          <button className="logout" type="button">
            <HugeiconsIcon icon={Logout01Icon} size={16} color="currentColor" /> {t('nav.logout')}
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <h1>{title.t}</h1>
            <div className="sub">{title.s}</div>
          </div>
          <HeaderTools showAdmin>
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
