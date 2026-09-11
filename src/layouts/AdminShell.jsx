import { NavLink, Outlet } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  DashboardSquare01Icon,
  CableIcon,
  BankIcon,
  UserGroupIcon,
  BanIcon,
  FlaskConicalIcon,
  ArrowLeft01Icon,
  Logout01Icon,
} from '@hugeicons/core-free-icons'
import { useStore } from '../store.jsx'
import { COUNTRIES } from '../data/agencies.js'
import HeaderTools from '../components/HeaderTools.jsx'
import BrandLockup from '../components/BrandLockup.jsx'
import { useI18n } from '../i18n/I18n.jsx'

const NAV = [
  { to: '/admin', key: 'overview', icon: DashboardSquare01Icon, end: true },
  { to: '/admin/connections', key: 'connections', icon: CableIcon },
  { to: '/admin/credits', key: 'credits', icon: BankIcon },
  { to: '/admin/cardholders', key: 'cardholders', icon: UserGroupIcon },
  { to: '/admin/declines', key: 'declines', icon: BanIcon },
  { to: '/admin/playground', key: 'playground', icon: FlaskConicalIcon },
]

export default function AdminShell() {
  const { country, setCountry, operator } = useStore()
  const { t } = useI18n()
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
          <NavLink to="/">
            <HugeiconsIcon icon={ArrowLeft01Icon} size={18} color="currentColor" />
            {t('adminNav.cardholderApp')}
          </NavLink>
        </nav>
        <div className="side-foot">
          <div className="device">
            <div>
              <strong>{t('adminNav.countryScope')}</strong>
              <small>{t('adminNav.countryScopeHint')}</small>
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
            <h1>{t('adminNav.title')}</h1>
            <div className="sub">{t('adminNav.sub')}</div>
          </div>
          <HeaderTools>
            <label>
              <span className="visually-hidden">Country</span>
              <select className="country-select" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {t(`country.${c.code}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="userchip">
              <div className="avatar">
                {operator.name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')}
              </div>
              <div>
                <strong>{operator.name}</strong>
                <small>
                  {operator.role} · {operator.org}
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
