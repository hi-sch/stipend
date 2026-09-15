import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/I18n.jsx'
import { useStore } from '../store.jsx'
import { formatDateTime } from '../lib/format.js'
import { ALERT_GROUP_KEYS } from '../lib/alerts.js'
import { ActionButton, ErrorText, KeyValues, OkText, Section, StatusBadge } from '../components/ui.jsx'
import ChangePassword from './ChangePassword.jsx'

export default function Settings() {
  const { user, program } = useStore()
  const self = user?.role === 'cardholder'

  return (
    <div className="grid-2 even">
      <div className="page-stack">
        <LanguageSection />
        <ContactSection self={self} />
        <AlertsSection />
      </div>
      <div className="page-stack">
        <PaymentDetails />
        {(program?.supportEmail || program?.supportPhone) && <SupportSection />}
        {self && (
          <>
            <ChangePassword />
            <DevicesSection />
          </>
        )}
      </div>
    </div>
  )
}

function LanguageSection() {
  const { t, lang, setLang, languages } = useI18n()
  return (
    <Section title={t('settings.language')} hint={t('settings.languageHint')}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="lang" className="visually-hidden">
          {t('settings.language')}
        </label>
        <select id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </div>
    </Section>
  )
}

/** Email and phone are used for sign-in, alerts and one-time codes; the legal name is managed by the program. */
function ContactSection({ self }) {
  const { t } = useI18n()
  const { cardholder, program, updateProfile } = useStore()
  const [email, setEmail] = useState(cardholder.email || '')
  const [phone, setPhone] = useState(cardholder.phone || '')
  const [password, setPassword] = useState('')
  const [ok, setOk] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setEmail(cardholder.email || '')
    setPhone(cardholder.phone || '')
  }, [cardholder.email, cardholder.phone])
  const emailChanged = email.trim().toLowerCase() !== String(cardholder.email || '').toLowerCase()

  async function save(e) {
    e.preventDefault()
    setOk('')
    setError('')
    setBusy(true)
    try {
      await updateProfile({ phone, email, ...(emailChanged && self ? { currentPassword: password } : {}) })
      setPassword('')
      setOk(t('settings.saved'))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('settings.contact')} hint={t('settings.contactHint')}>
      <form onSubmit={save}>
        <div className="field">
          <span className="label">{t('settings.name')}</span>
          <strong>
            {cardholder.firstName} {cardholder.lastName}
          </strong>
          <small className="muted">{t('settings.nameHint', { organisation: program?.organisation || program?.programName || 'Stipend' })}</small>
        </div>
        <div className="field">
          <label htmlFor="profile-email">{t('settings.email')}</label>
          <input id="profile-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <small className="muted">{t('settings.emailHint')}</small>
        </div>
        {emailChanged && self && (
          <div className="field">
            <label htmlFor="profile-password">{t('settings.currentPassword')}</label>
            <input id="profile-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="profile-phone">{t('settings.phone')}</label>
          <input id="profile-phone" type="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
          <small className="muted">{t('settings.phoneHint')}</small>
        </div>
        <div className="card-actions">
          <button className="btn" type="submit" disabled={busy}>
            {t('settings.save')}
          </button>
        </div>
        <OkText>{ok}</OkText>
        <ErrorText error={error} />
      </form>
    </Section>
  )
}

const OUTBOX_STATUS = { queued: 'statusQueued', sent: 'statusSent', failed: 'statusFailed' }

function AlertsSection() {
  const { t } = useI18n()
  const { cardholder, emailOutbox, emailDelivery, setPrefs } = useStore()
  const prefs = cardholder.prefs || {}
  const on = Boolean(prefs.emailAlerts)
  const saved = prefs.emailMuted || []
  // Checkboxes answer at once; the saved preference replaces this when the refresh arrives.
  const [muted, setMuted] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const savedKey = saved.join()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setMuted(saved), [savedKey])

  async function save(patch) {
    setBusy(true)
    setError('')
    try {
      await setPrefs(patch)
    } catch (err) {
      setMuted(saved)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function toggle(group, enabled) {
    const next = enabled ? muted.filter((g) => g !== group) : [...muted, group]
    setMuted(next)
    save({ emailMuted: next })
  }

  return (
    <Section title={t('settings.emailAlerts')} hint={t('settings.emailAlertsHint')}>
      <div className="seg" role="group" aria-label={t('settings.emailAlerts')} style={{ width: 'fit-content' }}>
        <button type="button" className={on ? 'on' : ''} aria-pressed={on} disabled={busy} onClick={() => save({ emailAlerts: true })}>
          {t('settings.on')}
        </button>
        <button type="button" className={!on ? 'on' : ''} aria-pressed={!on} disabled={busy} onClick={() => save({ emailAlerts: false })}>
          {t('settings.off')}
        </button>
      </div>
      {on && (
        <>
          <p className="cash-note">{emailDelivery ? t('settings.alertsTo', { email: cardholder.email }) : t('settings.alertsNotDelivered')}</p>
          <fieldset className="alert-types">
            <legend>{t('settings.alertTypes')}</legend>
            {ALERT_GROUP_KEYS.map((group) => (
              <label key={group} className="check">
                <input
                  type="checkbox"
                  name={`alert-${group}`}
                  checked={!muted.includes(group)}
                  onChange={(e) => toggle(group, e.target.checked)}
                />
                {t(`settings.alert_${group}`)}
              </label>
            ))}
          </fieldset>
          <h3 style={{ margin: '12px 0 8px', fontSize: '0.95rem' }}>{t('settings.outbox')}</h3>
          {!emailOutbox.length && <p className="empty">{t('settings.outboxEmpty')}</p>}
          {emailOutbox.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {emailOutbox.slice(0, 10).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.subject}</strong>
                        {row.body && <div className="muted" style={{ fontSize: '0.8rem' }}>{row.body}</div>}
                      </td>
                      <td>{formatDateTime(row.at)}</td>
                      <td>
                        <StatusBadge status={row.status === 'sent' ? 'yes' : row.status === 'failed' ? 'no' : 'PENDING'} />
                        <span className="visually-hidden">{t(`settings.${OUTBOX_STATUS[row.status || 'queued'] || 'statusQueued'}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <ErrorText error={error} />
    </Section>
  )
}

function PaymentDetails() {
  const { t } = useI18n()
  const { cardholder } = useStore()
  return (
    <Section title={t('incoming.details')} hint={t('incoming.detailsHint')}>
      <KeyValues
        rows={[
          [t('incoming.iban'), <code key="i">{String(cardholder.iban || '').replace(/(.{4})/g, '$1 ').trim() || '—'}</code>],
          [t('incoming.reference'), <code key="r">{cardholder.beneficiaryRef || '—'}</code>],
        ]}
      />
      <p className="cash-note">
        <Link to="/incoming">{t('settings.seeIncoming')}</Link>
      </p>
    </Section>
  )
}

function SupportSection() {
  const { t } = useI18n()
  const { program } = useStore()
  return (
    <section className="card" aria-labelledby="support-title">
      <h2 id="support-title">{t('settings.support')}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{t('settings.supportHint', { program: program.programName, organisation: program.organisation || program.programName })}</p>
      <dl className="kv">
        {program.supportEmail && (
          <div>
            <dt>{t('settings.supportEmail')}</dt>
            <dd>
              <a href={`mailto:${program.supportEmail}`}>{program.supportEmail}</a>
            </dd>
          </div>
        )}
        {program.supportPhone && (
          <div>
            <dt>{t('settings.supportPhone')}</dt>
            <dd>
              <a href={`tel:${program.supportPhone.replace(/[^+\d]/g, '')}`}>{program.supportPhone}</a>
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

function DevicesSection() {
  const { t } = useI18n()
  const { activeSessions, revokeOtherSessions } = useStore()
  const [done, setDone] = useState('')
  return (
    <Section title={t('settings.devices')} hint={t('settings.devicesHint')}>
      <p style={{ margin: '0 0 12px' }}>{t('settings.devicesCount', { count: activeSessions ?? 1 })}</p>
      <ActionButton
        confirmText={t('settings.signOutConfirm')}
        confirmLabel={t('settings.signOutOthers')}
        disabled={(activeSessions ?? 1) <= 1}
        onClick={async () => {
          await revokeOtherSessions()
          setDone(t('settings.signedOut'))
        }}
      >
        {t('settings.signOutOthers')}
      </ActionButton>
      <OkText>{done}</OkText>
    </Section>
  )
}
