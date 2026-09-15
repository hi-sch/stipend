import { Link } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import { CableIcon, BankIcon, BanIcon } from '@hugeicons/core-free-icons'
import { useStore } from '../../store.jsx'
import { AGENCIES } from '../../data/agencies.js'
import { eur } from '../../lib/format.js'
import { ActionButton, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { get, post } from '../../api.js'
import { formatDateTime } from '../../lib/format.js'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Overview() {
  const { tx, t } = useI18n()
  const { country, connections, allCredits, allTransactions, lithic, cardholders, refresh, environment, mail, allOutbox, appSettings } = useStore()
  const backups = useLoad(() => get('/api/admin/backups'), [])
  const health = useLoad(() => get('/api/health'), [])
  const queued = (allOutbox || []).filter((m) => (m.status || 'queued') === 'queued').length
  const failedMail = (allOutbox || []).filter((m) => m.status === 'failed').length
  const scoped = connections.filter((c) => c.country === country)
  const scopedIds = new Set(scoped.map((c) => c.id))
  const creditVol = allCredits.filter((c) => scopedIds.has(c.connectionId)).reduce((s, c) => s + c.amountCents - (c.recalledCents || 0), 0)
  const declines = allTransactions.filter((row) => row.status === 'DECLINED').length
  const agencies = AGENCIES.filter((a) => a.country === country)
  const issued = cardholders.filter((c) => c.card?.token).length

  const checklist = [
    ['Lithic API key', lithic?.configured ? 'yes' : 'no', lithic?.configured ? null : 'Set LITHIC_API_KEY in .env and restart.'],
    ['Lithic reachable', lithic?.status === 'live' ? 'yes' : lithic?.status || 'unknown', lithic?.error],
    ['Public URL', appSettings?.publicUrl?.startsWith('https://') ? 'yes' : 'no', <Link key="url" to="/admin/settings">{appSettings?.publicUrl || tx("Set in Settings")}</Link>],
    ['Cards issued', `${issued}/${cardholders.length}`, issued < cardholders.length ? <Link to="/admin/cardholders">{tx("Issue missing cards")}</Link> : null],
    [
      'ASA responder',
      lithic?.asaEnrolled ? (lithic?.asaReachable ? 'enrolled' : 'unreachable') : 'local mode',
      lithic?.asaEnrolled && !lithic?.asaReachable ? (
        <Link key="asa" to="/admin/asa" style={{ color: 'var(--danger)' }}>{tx("Lithic cannot reach {0}; every authorization declines. Disenroll or enroll a public HTTPS URL.", { 0: lithic.asaUrl })}</Link>
      ) : (
        <Link key="asa" to="/admin/asa">{tx("Configure")}</Link>
      ),
    ],
    ['ASA signature secret', lithic?.asaSecretConfigured ? 'yes' : 'no', null],
    ['Events webhooks', null, <Link key="int" to="/admin/integrations">{tx("Manage subscriptions")}</Link>],
    ['Program funding', null, <Link key="led" to="/admin/ledger">{tx("Ledger")}</Link>],
  ]

  return (
    <div className="page-stack">
      <p className="muted" style={{ maxWidth: '70ch', margin: 0 }}>{t('admin.intro', { country: t(`country.${country}`) })}</p>
      <section className="kpis">
        <article className="kpi lilac">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={CableIcon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>{t('admin.connectionsIn', { country: t(`country.${country}`) })}</h3>
          <div className="meta">{t('admin.agenciesMeta', { count: agencies.length })}</div>
          <div className="amount">{scoped.length}</div>
        </article>
        <article className="kpi peach">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={BankIcon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>{t('admin.creditsPosted')}</h3>
          <div className="meta">{t('admin.creditsMeta')}</div>
          <div className="amount">{eur(creditVol)}</div>
        </article>
        <article className="kpi dark">
          <div className="kpi-head">
            <div className="kpi-ico">
              <HugeiconsIcon icon={BanIcon} size={18} color="currentColor" />
            </div>
          </div>
          <h3>{t('admin.mccDeclines')}</h3>
          <div className="meta">{tx("All cardholders")}</div>
          <div className="amount">{declines}</div>
        </article>
      </section>

      <div className="grid-2">
        <Section
          title={tx("Program setup")}
          hint={tx("Lithic {0}.", { 0: environment })}
          actions={<ActionButton onClick={() => post('/api/admin/lithic/status').then(refresh)}>{tx("Check again")}</ActionButton>}
        >
          <ul className="checklist">
            {checklist.map(([label, value, extra]) => (
              <li key={label}>
                <span>{label}</span>
                <span className="toolbar">
                  {value && <StatusBadge status={value} />}
                  {extra}
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={tx("Operations")} hint={tx("Health, database backups and email delivery. Reset restores demo data but keeps logins and Lithic secrets.")}>
          <ul className="checklist" style={{ marginBottom: 14 }}>
            <li>
              <span>{tx("Health")}</span>
              <span className="toolbar">
                <StatusBadge status={health.data?.status === 'ok' ? 'yes' : health.data?.status || 'unknown'} />
                <a href="/api/health" target="_blank" rel="noreferrer">
                  /api/health
                </a>
              </span>
            </li>
            <li>
              <span>{tx("Last backup")}</span>
              <span className="toolbar">{tx("{0} · {1} kept", { 0: backups.data?.lastBackupAt ? formatDateTime(backups.data.lastBackupAt) : 'never', 1: backups.data?.backups?.length || 0 })}<ActionButton onClick={() => post('/api/admin/backups').then(backups.reload)}>{tx("Back up now")}</ActionButton>
              </span>
            </li>
            <li>
              <span>{tx("Email")}</span>
              <span className="toolbar">
                <StatusBadge status={mail?.configured ? 'yes' : 'no'} />
                {mail?.configured ? `${queued} queued · ${failedMail} failed` : 'Set SMTP_URL to send alerts'}
                {mail?.configured && queued ? <ActionButton onClick={() => post('/api/admin/outbox/deliver').then(refresh)}>{tx("Send now")}</ActionButton> : null}
              </span>
            </li>
          </ul>
          <div className="toolbar">
            {lithic?.configured && <ActionButton onClick={() => post('/api/admin/sync').then(refresh)}>{tx("Sync all transactions")}</ActionButton>}
            <ActionButton className="btn danger" confirmText={tx("Reset all demo data?")} onClick={() => post('/api/admin/reset').then(refresh)}>
              {t('admin.resetDemo')}
            </ActionButton>
          </div>
        </Section>
      </div>

      <div className="card-head">
        <h2 style={{ margin: 0 }}>{t('admin.agenciesFor')}</h2>
        <Link className="btn" to="/admin/connections/new">
          {t('admin.newConnection')}
        </Link>
      </div>
      <div className="conn-grid">
        {agencies.map((a) => {
          const live = connections.find((c) => c.id === a.id)
          return (
            <article className="conn-card" key={a.id}>
              <StatusBadge status={live ? live.status : 'not connected'} />
              <h3>{a.name}</h3>
              <div className="muted">{a.agency}</div>
              <div style={{ fontSize: '0.85rem' }}>{a.system}</div>
              <div style={{ fontSize: '0.85rem' }}>{tx("{0} MCCs · purpose {1}", { 0: a.mccs.length, 1: a.purpose })}</div>
              {live ? <Link to={`/admin/connections/${live.id}`}>{tx("Open")}</Link> : <Link to={`/admin/connections/new?agency=${a.id}`}>{tx("Connect")}</Link>}
            </article>
          )
        })}
        {!agencies.length && <p className="empty">{tx("No catalogued agencies for this country. Create a custom connection.")}</p>}
      </div>
    </div>
  )
}
