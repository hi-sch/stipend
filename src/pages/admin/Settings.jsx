import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { get, patch, post } from '../../api.js'
import { ActionButton, ErrorText, KeyValues, OkText, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { COUNTRIES } from '../../data/agencies.js'
import { useI18n } from '../../i18n/I18n.jsx'
import ChangePassword from '../ChangePassword.jsx'

const DURATIONS = [
  ['MONTHLY', 'Per month'],
  ['ANNUALLY', 'Per year'],
  ['TRANSACTION', 'Per transaction'],
  ['FOREVER', 'Lifetime'],
]
const ENV_KEYS = { publicUrl: 'PUBLIC_URL', cardProductId: 'LITHIC_PRODUCT_ID', mailFrom: 'MAIL_FROM' }
const GROUPS = [
  ['lithic', 'Lithic'],
  ['email', 'Email'],
  ['server', 'Server'],
  ['storage', 'Database'],
  ['sso', 'Single sign-on'],
  ['accounts', 'First-run logins'],
]
const toEur = (cents) => (Number(cents || 0) / 100).toFixed(2)
const toCents = (value) => Math.round(parseFloat(String(value).replace(',', '.')) * 100)

export default function AdminSettings() {
  const { tx } = useI18n()
  const { refresh } = useStore()
  const settings = useLoad(() => get('/api/admin/settings'), [])
  const reload = async () => {
    await settings.reload()
    await refresh()
  }

  return (
    <div className="page-stack">
      <div className="grid-2">
        <Preferences />
        <ChangePassword />
      </div>
      {settings.error && <ErrorText error={settings.error} />}
      {settings.data && (
        <>
          <div className="grid-2">
            <ProgramSection settings={settings.data} onSaved={reload} />
            <PublicUrlSection settings={settings.data} onSaved={reload} />
          </div>
          <div className="grid-2">
            <CardsSection settings={settings.data} onSaved={reload} />
            <EmailSection settings={settings.data} onSaved={reload} />
          </div>
          <StorageSection settings={settings.data} onSaved={reload} />
          <ServerSection settings={settings.data} />
        </>
      )}
      {settings.loading && !settings.data && <p className="muted">{tx("Loading…")}</p>}
    </div>
  )
}

function Preferences() {
  const { tx, t, lang, setLang, languages } = useI18n()
  const { country, setCountry, user, act } = useStore()
  const [name, setName] = useState(user?.name || '')
  const [ok, setOk] = useState('')
  const [error, setError] = useState('')

  async function saveName(e) {
    e.preventDefault()
    setOk('')
    setError('')
    try {
      await act('PATCH', '/api/admin/profile', { name })
      setOk(tx("Saved."))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Section title={tx("Your preferences")} hint={tx("Language and country scope are saved in this browser; your name is saved with your login.")}>
      <div className="field">
        <label htmlFor="set-lang">{t('settings.language')}</label>
        <select id="set-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="set-country">{tx("Country scope")}</label>
        <select id="set-country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {t(`country.${c.code}`)}
            </option>
          ))}
        </select>
        <small className="muted">{tx("The overview, connections, credits and new-connection presets show this country's paying agencies.")}</small>
      </div>
      <form className="field" onSubmit={saveName}>
        <label htmlFor="set-name">{tx("Your name")}</label>
        <div className="toolbar">
          <input id="set-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 200px' }} />
          <button className="btn" type="submit">{tx("Save")}</button>
        </div>
        <small className="muted">{user?.email}</small>
      </form>
      <OkText>{ok}</OkText>
      <ErrorText error={error} />
    </Section>
  )
}

/** Form state for a group of program settings; money fields are edited in EUR and saved in cents. */
function useSettingsForm(settings, keys, { money = [], numbers = [] } = {}, onSaved) {
  const { tx } = useI18n()
  const initial = () => Object.fromEntries(keys.map((k) => [k, money.includes(k) ? toEur(settings.values[k]) : String(settings.values[k] ?? '')]))
  const [form, setForm] = useState(initial)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setForm(initial()), [settings])
  const set = (key) => (e) => {
    setOk('')
    setForm((f) => ({ ...f, [key]: e.target.value }))
  }
  async function save(e) {
    e.preventDefault()
    setError('')
    setOk('')
    const body = {}
    for (const key of keys) {
      const value = String(form[key] ?? '').trim()
      if (money.includes(key) || numbers.includes(key)) {
        const n = money.includes(key) ? toCents(value) : Number(value)
        if (!Number.isFinite(n)) {
          setError(tx("Enter a number."))
          return
        }
        body[key] = n
      } else {
        body[key] = value === '' ? null : value
      }
    }
    try {
      await patch('/api/admin/settings', body)
      setOk(tx("Saved."))
      await onSaved()
    } catch (err) {
      setError(err.message)
    }
  }
  return { form, set, save, error, ok }
}

function SourceNote({ settings, name }) {
  const { tx } = useI18n()
  const source = settings.sources[name]
  return source === 'env' ? <small className="muted">{tx("From {0} in .env", { 0: ENV_KEYS[name] })}</small> : null
}

function Field({ id, label, settings, name, children, hint }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small className="muted">{hint}</small>}
      {settings && name && <SourceNote settings={settings} name={name} />}
    </div>
  )
}

function SaveRow({ state }) {
  const { tx } = useI18n()
  return (
    <>
      <div className="card-actions">
        <button className="btn" type="submit">{tx("Save")}</button>
      </div>
      <OkText>{state.ok}</OkText>
      <ErrorText error={state.error} />
    </>
  )
}

function ProgramSection({ settings, onSaved }) {
  const { tx } = useI18n()
  const state = useSettingsForm(settings, ['programName', 'organisation', 'supportEmail', 'supportPhone'], {}, onSaved)
  return (
    <Section title={tx("Program")} hint={tx("Shown to cardholders on their Settings page so they know whom to contact.")}>
      <form onSubmit={state.save}>
        <Field id="set-program" label={tx("Program name")}>
          <input id="set-program" required maxLength={60} value={state.form.programName} onChange={state.set('programName')} />
        </Field>
        <Field id="set-org" label={tx("Organisation")}>
          <input id="set-org" maxLength={120} value={state.form.organisation} onChange={state.set('organisation')} />
        </Field>
        <div className="row-2">
          <Field id="set-support-email" label={tx("Support email")}>
            <input id="set-support-email" type="email" maxLength={200} value={state.form.supportEmail} onChange={state.set('supportEmail')} />
          </Field>
          <Field id="set-support-phone" label={tx("Support phone")}>
            <input id="set-support-phone" type="tel" maxLength={30} value={state.form.supportPhone} onChange={state.set('supportPhone')} />
          </Field>
        </div>
        <SaveRow state={state} />
      </form>
    </Section>
  )
}

function PublicUrlSection({ settings, onSaved }) {
  const { tx } = useI18n()
  const state = useSettingsForm(settings, ['publicUrl'], {}, onSaved)
  const origin = (state.form.publicUrl.trim() || window.location.origin).replace(/\/+$/, '')
  const reachable = /^https:\/\//.test(origin) && !/\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(origin)
  return (
    <Section title={tx("Public address")} hint={tx("The address agencies and Lithic use to reach this server. Hook URLs, Lithic enrollment and email links are built from it.")}>
      <form onSubmit={state.save}>
        <Field id="set-public-url" label={tx("Public URL")} settings={settings} name="publicUrl">
          <input id="set-public-url" inputMode="url" placeholder={window.location.origin} value={state.form.publicUrl} onChange={state.set('publicUrl')} />
        </Field>
        {!reachable && <p className="cash-note" style={{ color: 'var(--danger)' }}>{tx("Lithic can only reach a public HTTPS address. Use a tunnel in development.")}</p>}
        <ul className="endpoint-list">
          {[
            [tx("Credit hook"), '/api/hooks/credits/{connection}'],
            [tx("Recall hook"), '/api/hooks/recalls/{connection}'],
            ['ASA', '/api/asa'],
            [tx("Lithic events"), '/api/webhooks/lithic'],
            [tx("3DS decisioning"), '/api/responders/three-ds'],
            [tx("Tokenization decisioning"), '/api/responders/tokenization'],
          ].map(([label, path]) => (
            <li key={path}>
              <span className="muted">{label}</span>
              <code>{`${origin}${path}`}</code>
            </li>
          ))}
        </ul>
        <SaveRow state={state} />
      </form>
    </Section>
  )
}

function CardsSection({ settings, onSaved }) {
  const { tx } = useI18n()
  const state = useSettingsForm(settings, ['defaultDailyLimitCents', 'cardSpendLimitCents', 'cardSpendLimitDuration', 'cardProductId'], { money: ['defaultDailyLimitCents', 'cardSpendLimitCents'] }, onSaved)
  return (
    <Section title={tx("Cards and limits")} hint={tx("Defaults for new connections and newly issued cards. Existing connections and cards keep their values.")}>
      <form onSubmit={state.save}>
        <Field id="set-daily" label={tx("Default daily cap per connection (EUR)")} settings={settings} name="defaultDailyLimitCents">
          <input id="set-daily" inputMode="decimal" required value={state.form.defaultDailyLimitCents} onChange={state.set('defaultDailyLimitCents')} />
        </Field>
        <div className="row-2">
          <Field id="set-spend" label={tx("Card spend limit (EUR)")} settings={settings} name="cardSpendLimitCents">
            <input id="set-spend" inputMode="decimal" required value={state.form.cardSpendLimitCents} onChange={state.set('cardSpendLimitCents')} />
          </Field>
          <Field id="set-spend-period" label={tx("Spend limit period")}>
            <select id="set-spend-period" value={state.form.cardSpendLimitDuration} onChange={state.set('cardSpendLimitDuration')}>
              {DURATIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {tx(label)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id="set-product" label={tx("Physical card product id")} settings={settings} name="cardProductId" hint={tx("From Lithic, for card art and packaging. The sandbox uses 100.")}>
          <input id="set-product" maxLength={32} value={state.form.cardProductId} onChange={state.set('cardProductId')} />
        </Field>
        <p className="muted cash-note">
          {tx("3DS and tokenization policies are set with their responders.")} <Link to="/admin/asa">{tx("ASA and responders")}</Link>
        </p>
        <SaveRow state={state} />
      </form>
    </Section>
  )
}

function EmailSection({ settings, onSaved }) {
  const { tx } = useI18n()
  const state = useSettingsForm(settings, ['mailFrom'], {}, onSaved)
  const [sent, setSent] = useState('')
  const configured = settings.mail.configured
  return (
    <Section title={tx("Email")} hint={tx("Notification emails to cardholders. Delivery needs SMTP_URL in .env.")} actions={<StatusBadge status={configured ? 'yes' : 'no'} />}>
      <form onSubmit={state.save}>
        <Field id="set-from" label={tx("Sender")} settings={settings} name="mailFrom" hint={tx("An address or \"Name <address>\". Your mail server must allow it.")}>
          <input id="set-from" maxLength={200} value={state.form.mailFrom} onChange={state.set('mailFrom')} />
        </Field>
        <SaveRow state={state} />
      </form>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <ActionButton
          disabled={!configured}
          onClick={async () => {
            setSent('')
            const res = await post('/api/admin/settings/test-email')
            setSent(tx("Test email sent to {0}.", { 0: res.sentTo }))
          }}
        >
          {tx("Send test email")}
        </ActionButton>
        {!configured && <span className="muted">{tx("Set SMTP_URL in .env and restart to send email.")}</span>}
      </div>
      <OkText>{sent}</OkText>
    </Section>
  )
}

/** Read-only: backups, failover and recovery belong to the database cluster now. */
function StorageSection({ settings }) {
  const { tx } = useI18n()
  const { storage } = settings
  const megabytes = storage.sizeBytes ? `${(storage.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '—'
  return (
    <Section title={tx("Database")} hint={tx("Backups, failover and point-in-time recovery are managed by the database cluster, not by Stipend.")}>
      <KeyValues
        rows={[
          [tx("Engine"), storage.serverVersion ? `PostgreSQL ${String(storage.serverVersion).split(' ')[0]}` : storage.engine],
          [tx("Size"), megabytes],
          [tx("Backups"), storage.backups],
        ]}
      />
    </Section>
  )
}

function ServerSection({ settings }) {
  const { tx } = useI18n()
  const { server, stored, lithic } = settings
  const missing = server.filter((row) => row.required && !row.set)
  return (
    <Section
      title={tx("Server configuration")}
      hint={tx("Read from .env on the server. Change a value there and restart. Secret values are never shown here.")}
      actions={<StatusBadge status={missing.length ? 'no' : 'yes'} />}
    >
      {missing.length > 0 && <ErrorText error={tx("Required: {0}", { 0: missing.map((row) => row.key).join(', ') })} />}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{tx("Variable")}</th>
              <th>{tx("Status")}</th>
              <th>{tx("Value")}</th>
            </tr>
          </thead>
          {GROUPS.map(([group, label]) => (
            <tbody key={group}>
              <tr>
                <th colSpan={3} scope="colgroup" style={{ paddingTop: 16 }}>
                  {tx(label)}
                </th>
              </tr>
              {server
                .filter((row) => row.group === group)
                .map((row) => (
                  <tr key={row.key}>
                    <td>
                      <code>{row.key}</code>
                    </td>
                    <td>
                      <StatusBadge status={row.set ? 'yes' : row.required ? 'no' : null} />
                      {!row.set && !row.required && <span className="muted"> {tx("not set")}</span>}
                    </td>
                    <td>{row.secret ? (row.set ? <span className="muted">{tx("hidden")}</span> : '—') : row.value ? <code>{row.value}</code> : '—'}</td>
                  </tr>
                ))}
            </tbody>
          ))}
        </table>
      </div>
      <h3 style={{ margin: '18px 0 8px' }}>{tx("Secrets stored by Stipend")}</h3>
      <KeyValues
        rows={[
          [tx("Lithic environment"), lithic.configured ? lithic.environment : tx("not connected")],
          [tx("ASA signing secret"), <StatusBadge key="asa" status={stored.asaSecret ? 'yes' : 'no'} />],
          [tx("3DS decisioning secret"), <StatusBadge key="3ds" status={stored.threeDsSecret ? 'yes' : 'no'} />],
          [tx("Tokenization decisioning secret"), <StatusBadge key="tok" status={stored.tokenizationSecret ? 'yes' : 'no'} />],
          [tx("Event subscription secrets"), stored.webhookSecrets],
        ]}
      />
    </Section>
  )
}
