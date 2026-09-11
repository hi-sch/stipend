import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18n.jsx'

const PREFS = 'stipend.prefs'

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS) || '{}')
  } catch {
    return {}
  }
}

export default function Settings() {
  const { t, lang, setLang, languages } = useI18n()
  const [email, setEmail] = useState(() => Boolean(loadPrefs().emailAlerts))

  useEffect(() => {
    const prefs = loadPrefs()
    localStorage.setItem(PREFS, JSON.stringify({ ...prefs, emailAlerts: email }))
  }, [email])

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <p className="synth" style={{ marginTop: 0 }}>{t('settings.concept')}</p>
      <div className="field">
        <label htmlFor="lang">{t('settings.language')}</label>
        <select id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
        <small style={{ color: 'var(--muted)' }}>{t('settings.languageHint')}</small>
      </div>
      <div className="field" style={{ marginTop: 20 }}>
        <label>{t('settings.emailAlerts')}</label>
        <div className="seg" style={{ width: 'fit-content', marginTop: 8 }}>
          <button type="button" className={email ? 'on' : ''} onClick={() => setEmail(true)}>
            {t('settings.on')}
          </button>
          <button type="button" className={!email ? 'on' : ''} onClick={() => setEmail(false)}>
            {t('settings.off')}
          </button>
        </div>
        <small style={{ color: 'var(--muted)', display: 'block', marginTop: 8 }}>{t('settings.emailAlertsHint')}</small>
      </div>
    </div>
  )
}
