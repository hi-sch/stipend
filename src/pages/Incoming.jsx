import { Link } from 'react-router-dom'
import { useStore } from '../store.jsx'
import { eur, formatDateTime } from '../lib/format.js'
import { PROTOCOLS } from '../data/agencies.js'
import { mccName } from '../data/mccs.js'
import { KeyValues, Section, StatusBadge } from '../components/ui.jsx'
import { useI18n } from '../i18n/I18n.jsx'

export default function Incoming() {
  const { t } = useI18n()
  const { credits, connections, envelopes, cardholder } = useStore()
  return (
    <div className="page-stack">
      <Section title={t('incoming.details')} hint={t('incoming.detailsHint')}>
        <KeyValues
          rows={[
            [t('incoming.iban'), <code key="i">{String(cardholder.iban || '').replace(/(.{4})/g, '$1 ').trim()}</code>],
            [t('incoming.reference'), <code key="r">{cardholder.beneficiaryRef}</code>],
          ]}
        />
      </Section>
      <div className="card">
        <p className="muted" style={{ marginTop: 0, maxWidth: '62ch' }}>{t('incoming.intro')}</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('incoming.connection')}</th>
                <th>{t('incoming.protocol')}</th>
                <th>{t('incoming.e2e')}</th>
                <th>{t('incoming.when')}</th>
                <th>{t('incoming.status')}</th>
                <th style={{ textAlign: 'right' }}>{t('incoming.credited')}</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => {
                const conn = connections.find((x) => x.id === c.connectionId)
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{conn?.name || c.connectionId}</strong>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>{conn?.agency}</div>
                    </td>
                    <td>{PROTOCOLS.find((p) => p.id === c.protocol)?.label || c.protocol}</td>
                    <td>
                      <code>{c.endToEndId}</code>
                    </td>
                    <td>{formatDateTime(c.created)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                      {c.recalledCents ? <div className="muted" style={{ fontSize: '0.78rem' }}>{t('incoming.recalled')}: {eur(c.recalledCents)}</div> : null}
                    </td>
                    <td className="pos" style={{ textAlign: 'right' }}>
                      +{eur(c.amountCents)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2>{t('incoming.included')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{t('incoming.includedHint')}</p>
        <div className="conn-grid">
          {envelopes.map((e) => (
            <article className="conn-card" key={e.id}>
              <h3>{e.connectionName}</h3>
              <div className="muted">{t('incoming.leftOf', { amount: eur(e.balanceCents) })}</div>
              <div className="chips" style={{ marginTop: 8 }}>
                {(e.mccs || []).slice(0, 8).map((code) => (
                  <span className="chip" key={code}>
                    {code} {mccName(code)}
                  </span>
                ))}
                {(e.mccs || []).length > 8 && <span className="chip">+{e.mccs.length - 8}</span>}
              </div>
              <Link to="/restrictions" className="btn ghost" style={{ marginTop: 10, alignSelf: 'start' }}>
                {t('incoming.allRestrictions')}
              </Link>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
