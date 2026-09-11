import { Link } from 'react-router-dom'
import { useStore } from '../../store.jsx'

import { eur } from '../../lib/format.js'
import { HugeiconsIcon } from '@hugeicons/react'
import { CableIcon, BankIcon, BanIcon } from '@hugeicons/core-free-icons'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Overview() {
  const { t } = useI18n()
  const { country, connections, credits, transactions, agenciesForCountry, resetDemo } = useStore()
  const scoped = connections.filter((c) => c.country === country)
  const creditVol = credits
    .filter((c) => scoped.some((x) => x.id === c.connectionId))
    .reduce((s, c) => s + c.amountCents, 0)
  const declines = transactions.filter((t) => t.status === 'DECLINED').length
  const agencies = agenciesForCountry(country)

  return (
    <>
      <p className="synth">{t('synth.program')}</p>
      <p style={{ color: 'var(--muted)', maxWidth: '70ch', marginTop: 0 }}>
        {t('admin.intro', { country: t(`country.${country}`) })}
      </p>
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
          <div className="meta">PROGRAM_USAGE_RESTRICTION / AUTH_RULE</div>
          <div className="amount">{declines}</div>
        </article>
      </section>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{t('admin.agenciesFor')}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" type="button" onClick={resetDemo}>
            {t('admin.resetDemo')}
          </button>
          <Link className="btn" to="/admin/connections/new">
            {t('admin.newConnection')}
          </Link>
        </div>
      </div>
      <div className="conn-grid">
        {agencies.map((a) => {
          const live = connections.find((c) => c.id === a.id)
          return (
            <article className="conn-card" key={a.id}>
              <span className={`badge ${live ? 'ok' : 'warn'}`}>{live ? live.status : 'not connected'}</span>
              <h3>{a.name}</h3>
              <div style={{ color: 'var(--muted)' }}>{a.agency}</div>
              <div style={{ fontSize: '0.85rem' }}>{a.system}</div>
              <div style={{ fontSize: '0.85rem' }}>{a.mccs.length} MCCs · purpose {a.purpose}</div>
              {live ? (
                <Link to={`/admin/connections/${live.id}`}>Open</Link>
              ) : (
                <Link to={`/admin/connections/new?agency=${a.id}`}>Connect</Link>
              )}
            </article>
          )
        })}
        {!agencies.length && <p className="empty">No catalogued agencies for this country. Create a custom connection.</p>}
      </div>
    </>
  )
}
