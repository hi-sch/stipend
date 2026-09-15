import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import { Notification03Icon, Settings01Icon, ComputerSettingsIcon, CreditCardIcon } from '@hugeicons/core-free-icons'
import { useI18n } from '../i18n/I18n.jsx'
import { useStore } from '../store.jsx'
import { relativeDay } from '../lib/format.js'

export default function HeaderTools({ showSettings = false, settingsPath = '/settings', cardholderHome = false, children }) {
  const { t } = useI18n()
  const { notifications, markNotificationsRead, user } = useStore()
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const bell = useRef(null)
  const loc = useLocation()
  const unread = (notifications || []).filter((n) => n.unread).length

  useEffect(() => {
    function onDoc(e) {
      if (!wrap.current?.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape' && wrap.current?.contains(document.activeElement)) {
        setOpen(false)
        bell.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="top-actions">
      {user?.role === 'admin' && !loc.pathname.startsWith('/admin') && (
        <Link to="/admin" className="header-admin">
          <HugeiconsIcon icon={ComputerSettingsIcon} size={16} color="currentColor" />
          {t('header.admin')}
        </Link>
      )}
      {showSettings && (
        <Link to={settingsPath} className={`header-admin ${loc.pathname === settingsPath ? 'active' : ''}`} aria-current={loc.pathname === settingsPath ? 'page' : undefined}>
          <HugeiconsIcon icon={Settings01Icon} size={16} color="currentColor" />
          {t('header.settings')}
        </Link>
      )}
      {cardholderHome && (
        <Link to="/cardholders" className="header-admin" onClick={(e) => e.preventDefault()} hidden>
          <HugeiconsIcon icon={CreditCardIcon} size={16} color="currentColor" />
          {t('header.cardholderApp')}
        </Link>
      )}
      {!loc.pathname.startsWith('/admin') && (
        <div className="notify-wrap" ref={wrap}>
          <button
            ref={bell}
            className="icon-btn"
            type="button"
            aria-label={unread ? `${t('header.notifications')} (${unread})` : t('header.notifications')}
            aria-expanded={open}
            onClick={() => {
              setOpen((v) => !v)
              if (!open && unread) markNotificationsRead().catch(() => {})
            }}
          >
            <HugeiconsIcon icon={Notification03Icon} size={16} color="currentColor" />
            {unread > 0 && <span className="dot-badge" />}
          </button>
          {open && (
            <div className="notify-panel" role="dialog" aria-label={t('header.notifications')}>
              <h3>{t('header.notifications')}</h3>
              {!(notifications || []).length && <p className="empty">{t('header.noNotes')}</p>}
              {(notifications || []).slice(0, 15).map((n) => (
                <div className="notify-item" key={n.id}>
                  <span className={`mark ${n.unread ? '' : 'read'}`} />
                  <div>
                    <strong>{n.title}</strong>
                    {n.body && <span>{n.body}</span>}
                    <span>{relativeDay(n.when, t)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
