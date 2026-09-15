import { useState } from 'react'
import { get } from '../../api.js'
import { formatDateTime } from '../../lib/format.js'
import { ErrorText, JsonView, Modal, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Audit() {
  const { tx } = useI18n()
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [query, setQuery] = useState({ actor: '', action: '' })
  const [older, setOlder] = useState([])
  const [open, setOpen] = useState(null)
  const params = (extra = {}) => new URLSearchParams(Object.entries({ ...query, limit: 100, ...extra }).filter(([, v]) => v)).toString()
  const page = useLoad(() => get(`/api/admin/audit?${params()}`), [query])
  const rows = [...(page.data || []), ...older]

  async function loadOlder() {
    const last = rows[rows.length - 1]
    if (!last) return
    setOlder([...older, ...(await get(`/api/admin/audit?${params({ before: last.id })}`))])
  }

  return (
    <Section
      title={tx("Audit log")}
      hint={tx("Every operator change, sign-in and failed sign-in. Secrets and uploaded files are redacted.")}
      actions={
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            setOlder([])
            setQuery({ actor, action })
          }}
        >
          <input aria-label={tx("Actor email")} placeholder={tx("Actor email")} value={actor} onChange={(e) => setActor(e.target.value)} />
          <input aria-label={tx("Action contains")} placeholder={tx("Action contains")} value={action} onChange={(e) => setAction(e.target.value)} />
          <button className="btn ghost" type="submit">{tx("Filter")}</button>
        </form>
      }
    >
      <ErrorText error={page.error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{tx("When")}</th>
              <th>{tx("Actor")}</th>
              <th>{tx("Action")}</th>
              <th>{tx("Target")}</th>
              <th>{tx("Outcome")}</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="clickable" tabIndex={0} onClick={() => setOpen(row)} onKeyDown={(e) => e.key === 'Enter' && setOpen(row)}>
                <td>{formatDateTime(row.at)}</td>
                <td>{row.actor}</td>
                <td>
                  <code>{row.action}</code>
                </td>
                <td style={{ fontSize: '0.8rem' }}>{row.target || '—'}</td>
                <td>
                  <StatusBadge status={row.outcome === 'ok' ? 'yes' : row.outcome} />
                </td>
                <td className="muted">{row.ip || ''}</td>
              </tr>
            ))}
            {!page.loading && !rows.length && (
              <tr>
                <td colSpan={6}>
                  <p className="empty">{tx("No audit entries.")}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length >= 100 && (
        <button className="btn ghost" type="button" onClick={loadOlder} style={{ marginTop: 12 }}>{tx("Load older entries")}</button>
      )}
      {open && (
        <Modal title={open.action} onClose={() => setOpen(null)} wide>
          <JsonView value={open} minHeight={240} />
        </Modal>
      )}
    </Section>
  )
}
