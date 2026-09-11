import { useStore } from '../store.jsx'
import { eur, formatDateTime } from '../lib/format.js'
import { PROTOCOLS } from '../data/agencies.js'
import { mccName } from '../data/mccs.js'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/I18n.jsx'

export default function Incoming() {
  const { t } = useI18n()
  const { credits, connections, envelopes } = useStore()
  return (
    <>
      <p className="synth">{t('synth.credits')}</p>
      <p style={{ color: 'var(--muted)', marginTop: 0, maxWidth: '62ch' }}>
        {t('incoming.intro')}
      </p>
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('incoming.connection')}</th>
                <th>{t('incoming.protocol')}</th>
                <th>{t('incoming.e2e')}</th>
                <th>{t('incoming.when')}</th>
                <th style={{ textAlign: 'right' }}>{t('incoming.credited')}</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => {
                const conn = connections.find((x) => x.id === c.connectionId)
                const proto = PROTOCOLS.find((p) => p.id === c.protocol)
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{conn?.name || c.connectionId}</strong>
                      <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{conn?.agency}</div>
                    </td>
                    <td>{proto?.label || c.protocol}</td>
                    <td>
                      <code>{c.endToEndId}</code>
                    </td>
                    <td>{formatDateTime(c.created)}</td>
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

      <h2 style={{ marginTop: 28 }}>{t('incoming.included')}</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        {t('incoming.includedHint')}
      </p>
      <div className="conn-grid">
        {envelopes.map((e) => (
          <article className="conn-card" key={e.id}>
            <h3>{e.connectionName}</h3>
            <div style={{ color: 'var(--muted)' }}>{t('incoming.leftOf', { amount: eur(e.balanceCents) })}</div>
            <div className="chips" style={{ marginTop: 8 }}>
              {e.mccs.slice(0, 8).map((code) => (
                <span className="chip" key={code}>
                  {code} {mccName(code)}
                </span>
              ))}
              {e.mccs.length > 8 && <span className="chip">+{e.mccs.length - 8}</span>}
            </div>
            <Link to="/restrictions" className="btn ghost" style={{ marginTop: 10, alignSelf: 'start' }}>
              {t('incoming.allRestrictions')}
            </Link>
          </article>
        ))}
      </div>
    </>
  )
}
