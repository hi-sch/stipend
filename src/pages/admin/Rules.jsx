import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { get, patch, post } from '../../api.js'
import { ActionButton, ErrorText, JsonView, Modal, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

export default function Rules() {
  const { tx } = useI18n()
  const { cardholders, lithic } = useStore()
  const [holderId, setHolderId] = useState(cardholders.find((c) => c.card?.token)?.id || '')
  const rules = useLoad(() => (lithic?.configured ? get(`/api/admin/rules${holderId ? `?cardholderId=${holderId}` : ''}`) : []), [holderId, lithic?.configured])
  const [panel, setPanel] = useState(null)

  if (!lithic?.configured) return <p className="empty">{tx("Configure LITHIC_API_KEY to manage Lithic auth rules.")}</p>

  return (
    <div className="page-stack">
      <Section
        title={tx("Authorization rules")}
        hint={tx("Stipend keeps one MCC allowlist and one daily velocity rule per card in sync with funded envelopes. Program-level rules are listed too.")}
        actions={
          <div style={{ whiteSpace: 'nowrap', display: 'flex', gap: 8 }}>
            <select className="country-select" value={holderId} onChange={(e) => setHolderId(e.target.value)} aria-label={tx("Cardholder")}>
              <option value="">{tx("All rules")}</option>
              {cardholders.filter((c) => c.card?.token).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
            </select>
            {holderId && <ActionButton onClick={() => post(`/api/admin/cardholders/${holderId}/rules/sync`).then(rules.reload)}>{tx("Sync from envelopes")}</ActionButton>}
            <button className="btn ghost" type="button" onClick={rules.reload}>{tx("Refresh")}</button>
          </div>
        }
      >
        <ErrorText error={rules.error} />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("Name")}</th>
                <th>{tx("Type")}</th>
                <th>{tx("Scope")}</th>
                <th>{tx("State")}</th>
                <th>{tx("Version")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(rules.data || []).map((r) => (
                <tr key={r.token}>
                  <td>
                    <strong>{r.name || r.token}</strong>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>{r.token}</div>
                  </td>
                  <td>{r.type}</td>
                  <td>{r.program_level ? 'program' : `${(r.card_tokens || []).length} card(s)`}</td>
                  <td>
                    <StatusBadge status={r.state} />
                  </td>
                  <td>{r.current_version?.version ?? '—'}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn ghost" type="button" onClick={() => setPanel({ kind: 'params', rule: r })}>{tx("Parameters")}</button>
                      <button className="btn ghost" type="button" onClick={() => setPanel({ kind: 'results', rule: r })}>{tx("Results")}</button>
                      <button className="btn ghost" type="button" onClick={() => setPanel({ kind: 'report', rule: r })}>{tx("Report")}</button>
                      {r.type === 'CONDITIONAL_ACTION' && (
                        <button className="btn ghost" type="button" onClick={() => setPanel({ kind: 'backtest', rule: r })}>{tx("Backtest")}</button>
                      )}
                      <ActionButton className={r.state === 'ACTIVE' ? 'btn danger' : 'btn success'} onClick={() => patch(`/api/admin/rules/${r.token}`, { state: r.state === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }).then(rules.reload)}>
                        {r.state === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
              {!rules.loading && !(rules.data || []).length && (
                <tr>
                  <td colSpan={6}>
                    <p className="empty">{tx("No rules yet. Issue a card and credit an envelope to create them.")}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
      {panel && <RulePanel panel={panel} onClose={() => setPanel(null)} />}
    </div>
  )
}

function RulePanel({ panel, onClose }) {
  const { tx } = useI18n()
  const { rule, kind } = panel
  const [begin, setBegin] = useState(daysAgo(7))
  const [end, setEnd] = useState(today())
  const [data, setData] = useState(kind === 'params' ? rule.current_version : null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      setData(await fn())
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const title = { params: 'Parameters', results: 'Evaluation results', report: 'Performance report', backtest: 'Backtest' }[kind]
  return (
    <Modal title={`${title} · ${rule.name || rule.token}`} onClose={onClose} wide>
      {kind !== 'params' && (
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault()
            if (kind === 'results') run(() => get(`/api/admin/rules/${rule.token}/results?begin=${begin}T00:00:00Z&end=${end}T23:59:59Z`))
            if (kind === 'report') run(() => get(`/api/admin/rules/${rule.token}/report?begin=${begin}&end=${end}`))
            if (kind === 'backtest') {
              run(async () => {
                const { backtest_token: token } = await post(`/api/admin/rules/${rule.token}/backtests`, { start: `${begin}T00:00:00Z`, end: `${end}T23:59:59Z` })
                return { backtest_token: token, note: 'Backtests run asynchronously. Fetch results in a minute.' }
              })
            }
          }}
        >
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("From")}</span>
            <input type="date" value={begin} onChange={(e) => setBegin(e.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("To")}</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {kind === 'backtest' ? 'Request backtest' : 'Load'}
          </button>
          {kind === 'backtest' && data?.backtest_token && (
            <button className="btn ghost" type="button" disabled={busy} onClick={() => run(() => get(`/api/admin/rules/${rule.token}/backtests/${data.backtest_token}`))}>{tx("Fetch results")}</button>
          )}
        </form>
      )}
      <ErrorText error={error} />
      {data && <JsonView value={data} minHeight={260} maxHeight={480} />}
    </Modal>
  )
}
