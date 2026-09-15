import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { del, get, post } from '../../api.js'
import { formatDateTime } from '../../lib/format.js'
import { ActionButton, ErrorText, JsonView, Modal, Section, StatusBadge, Tabs, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

const EVENT_TYPES = [
  'card_transaction.updated',
  'dispute.updated',
  'dispute_evidence.upload_failed',
  'card.created',
  'card.updated',
  'card.converted',
  'card.shipped',
  'card.renewed',
  'card.reissued',
  'account_holder.updated',
  'account_holder.verification',
  'tokenization.result',
  'tokenization.updated',
  'three_ds_authentication.created',
  'three_ds_authentication.challenge',
  'book_transfer_transaction.updated',
  'balance.updated',
  'auth_rules.backtest_report.created',
]

export default function Integrations() {
  const { tx } = useI18n()
  const { webhooks, lithic } = useStore()
  const [tab, setTab] = useState('subscriptions')
  return (
    <div className="page-stack">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['subscriptions', tx("Event subscriptions")],
          ['received', tx("Received webhooks")],
          ['events', tx("Lithic events")],
        ]}
      />
      {tab === 'subscriptions' && (lithic?.configured ? <Subscriptions /> : <p className="empty">{tx("Configure LITHIC_API_KEY first.")}</p>)}
      {tab === 'received' && <Received webhooks={webhooks} />}
      {tab === 'events' && (lithic?.configured ? <EventsList /> : <p className="empty">{tx("Configure LITHIC_API_KEY first.")}</p>)}
    </div>
  )
}

function Subscriptions() {
  const { tx } = useI18n()
  const { publicOrigin } = useStore()
  const subs = useLoad(() => get('/api/admin/events/subscriptions'), [])
  const [url, setUrl] = useState(`${publicOrigin}/api/webhooks/lithic`)
  const [types, setTypes] = useState(['card_transaction.updated', 'dispute.updated', 'card.shipped', 'tokenization.result'])
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)

  async function create(e) {
    e.preventDefault()
    setError('')
    try {
      await post('/api/admin/events/subscriptions', { url, eventTypes: types })
      await subs.reload()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <>
      <Section title={tx("Subscriptions")} hint={tx("Stipend fetches and stores each subscription's signing secret, so incoming webhooks are verified without editing .env.")}>
        <ErrorText error={subs.error} />
        <table className="data">
          <tbody>
            {(subs.data || []).map((s) => (
              <tr key={s.token}>
                <td>
                  <strong>{s.url}</strong>
                  <div className="muted" style={{ fontSize: '0.78rem' }}>{(s.event_types || ['all events']).join(', ')}</div>
                </td>
                <td>
                  <StatusBadge status={s.disabled ? 'no' : 'ACTIVE'} />
                </td>
                <td>{s.secretStored ? <StatusBadge status="yes" /> : <span className="muted">{tx("secret not stored")}</span>}</td>
                <td>
                  <button className="btn ghost" type="button" onClick={() => setDetail(s)}>{tx("Manage")}</button>
                </td>
              </tr>
            ))}
            {!subs.loading && !(subs.data || []).length && (
              <tr>
                <td>
                  <p className="empty">{tx("No subscriptions yet.")}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>
      <Section title={tx("New subscription")} hint={tx("Needs a public HTTPS URL; use a tunnel in development.")}>
        <form onSubmit={create}>
          <div className="field">
            <label htmlFor="sub-url">{tx("Webhook URL")}</label>
            <input id="sub-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="mcc-grid">
            {EVENT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className={`mcc-opt ${types.includes(type) ? 'on' : ''}`}
                onClick={() => setTypes((list) => (list.includes(type) ? list.filter((x) => x !== type) : [...list, type]))}
              >
                {type}
              </button>
            ))}
          </div>
          <ErrorText error={error} />
          <button className="btn" type="submit" style={{ marginTop: 12 }}>{tx("Create subscription")}</button>
        </form>
      </Section>
      {detail && <SubscriptionDetail sub={detail} onClose={() => setDetail(null)} onChanged={subs.reload} />}
    </>
  )
}

function SubscriptionDetail({ sub, onClose, onChanged }) {
  const { tx } = useI18n()
  const [begin, setBegin] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 16))
  const [eventType, setEventType] = useState('card_transaction.updated')
  const [output, setOutput] = useState(null)
  const base = `/api/admin/events/subscriptions/${sub.token}`
  const show = (label) => (value) => setOutput({ label, value: value ?? { ok: true } })
  const iso = () => new Date(begin).toISOString()

  return (
    <Modal title={sub.url} onClose={onClose} wide>
      <div className="stack">
        <div className="toolbar">
          <ActionButton onClick={() => post(`${base}/secret`, {}).then(show('Secret stored')).then(onChanged)}>{tx("Fetch secret")}</ActionButton>
          <ActionButton confirmText={tx("Rotate the signing secret?")} onClick={() => post(`${base}/secret`, { rotate: true }).then(show('Secret rotated')).then(onChanged)}>{tx("Rotate secret")}</ActionButton>
          <ActionButton onClick={() => get(`${base}/attempts`).then(show('Delivery attempts'))}>{tx("Delivery attempts")}</ActionButton>
          <ActionButton
            className="btn danger"
            confirmText={tx("Delete this subscription?")}
            onClick={async () => {
              await del(base)
              await onChanged()
              onClose()
            }}
          >{tx("Delete")}</ActionButton>
        </div>
        <div className="toolbar">
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("Since")}</span>
            <input type="datetime-local" value={begin} onChange={(e) => setBegin(e.target.value)} />
          </label>
          <ActionButton onClick={() => post(`${base}/recover`, { begin: iso() }).then(show('Resending failed messages'))}>{tx("Resend failed")}</ActionButton>
          <ActionButton onClick={() => post(`${base}/replay`, { begin: iso() }).then(show('Replaying missing messages'))}>{tx("Replay missing")}</ActionButton>
        </div>
        <div className="toolbar">
          <select className="country-select" value={eventType} onChange={(e) => setEventType(e.target.value)} aria-label={tx("Event type")}>
            {EVENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <ActionButton onClick={() => post(`${base}/example`, { eventType }).then(show('Example sent'))}>{tx("Send example")}</ActionButton>
        </div>
        {output && (
          <>
            <strong>{output.label}</strong>
            <JsonView value={output.value} />
          </>
        )}
      </div>
    </Modal>
  )
}

function Received({ webhooks }) {
  const { tx } = useI18n()
  const [open, setOpen] = useState(null)
  return (
    <Section title={tx("Received webhooks")} hint={tx("The last 100 Events API messages. Unsigned messages are only accepted in the sandbox when no secret is stored.")}>
      {!webhooks.length && <p className="empty">{tx("Nothing received yet.")}</p>}
      <table className="data">
        <tbody>
          {webhooks.map((w) => (
            <tr key={w.id} className="clickable" onClick={() => setOpen(w)}>
              <td>{formatDateTime(w.at)}</td>
              <td>{w.eventType}</td>
              <td>
                <StatusBadge status={w.verified ? 'yes' : 'unsigned'} />
              </td>
              <td>{w.duplicate ? 'duplicate' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <Modal title={open.eventType || 'Webhook'} onClose={() => setOpen(null)} wide>
          <JsonView value={open.event} minHeight={300} maxHeight={520} />
        </Modal>
      )}
    </Section>
  )
}

function EventsList() {
  const { tx } = useI18n()
  const [type, setType] = useState('')
  const events = useLoad(() => get(`/api/admin/events${type ? `?eventType=${type}` : ''}`), [type])
  const [open, setOpen] = useState(null)
  return (
    <Section
      title={tx("Lithic events")}
      hint={tx("Events Lithic generated for this program, whether or not a subscription delivered them.")}
      actions={
        <select className="country-select" value={type} onChange={(e) => setType(e.target.value)} aria-label={tx("Event type")}>
          <option value="">{tx("All types")}</option>
          {EVENT_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      }
    >
      <ErrorText error={events.error} />
      <table className="data">
        <tbody>
          {(events.data?.data || []).map((e) => (
            <tr key={e.token} className="clickable" onClick={() => setOpen(e)}>
              <td>{formatDateTime(e.created)}</td>
              <td>{e.event_type}</td>
              <td className="muted">{e.token}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <Modal title={open.event_type} onClose={() => setOpen(null)} wide>
          <JsonView value={open} minHeight={300} maxHeight={520} />
        </Modal>
      )}
    </Section>
  )
}
