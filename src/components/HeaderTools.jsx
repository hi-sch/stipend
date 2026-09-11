import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import { Notification03Icon, Settings01Icon, ComputerSettingsIcon } from '@hugeicons/core-free-icons'
import { useI18n } from '../i18n/I18n.jsx'

export default function HeaderTools({ showAdmin = false, children }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const loc = useLocation()
  const notes = [
    { id: 'n1', title: t('notes.n1t'), body: t('notes.n1b'), when: t('notes.n1w'), unread: true },
    { id: 'n2', title: t('notes.n2t'), body: t('notes.n2b'), when: t('notes.n2w'), unread: true },
    { id: 'n3', title: t('notes.n3t'), body: t('notes.n3b'), when: t('notes.n3w'), unread: false },
    { id: 'n4', title: t('notes.n4t'), body: t('notes.n4b'), when: t('notes.n4w'), unread: false },
  ]
  const unread = notes.filter((n) => n.unread).length

  useEffect(() => {
    function onDoc(e) {
      if (!wrap.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="top-actions">
      {showAdmin && (
        <Link to="/admin" className={`header-admin ${loc.pathname.startsWith('/admin') ? 'active' : ''}`}>
          <HugeiconsIcon icon={ComputerSettingsIcon} size={16} color="currentColor" />
          {t('header.admin')}
        </Link>
      )}
      <Link to="/settings" className={`header-admin ${loc.pathname === '/settings' ? 'active' : ''}`}>
        <HugeiconsIcon icon={Settings01Icon} size={16} color="currentColor" />
        {t('header.settings')}
      </Link>
      <div className="notify-wrap" ref={wrap}>
        <button
          className="icon-btn"
          type="button"
          aria-label={t('header.notifications')}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <HugeiconsIcon icon={Notification03Icon} size={16} color="currentColor" />
          {unread > 0 && <span className="dot-badge" />}
        </button>
        {open && (
          <div className="notify-panel" role="dialog" aria-label={t('header.notifications')}>
            <h3>{t('header.notifications')}</h3>
            {notes.map((n) => (
              <div className="notify-item" key={n.id}>
                <span className={`mark ${n.unread ? '' : 'read'}`} />
                <div>
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                  <span>{n.when}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
