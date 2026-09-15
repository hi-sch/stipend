import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { eur, formatDateTime } from '../../lib/format.js'
import { countryName } from '../../data/agencies.js'
import { ActionButton, ErrorText, Section, StatusBadge } from '../../components/ui.jsx'
import { CASH_MCCS, CASH_PERIODS } from '../../lib/cash.js'
import { useI18n } from '../../i18n/I18n.jsx'

export const CASH_PERIOD_LABELS = { DAY: 'Day', WEEK: 'Week', MONTH: 'Month' }
export const CASH_PER = { DAY: 'per day', WEEK: 'per week', MONTH: 'per month' }
const toCents = (value) => Math.round(parseFloat(String(value).replace(',', '.')) * 100)

export function useCashRuleLabel() {
  const { tx } = useI18n()
  return (rule) => `${rule.name} · ${eur(rule.limitCents)} ${tx(CASH_PER[rule.period] || 'per month')}`
}

export default function Cardholders() {
  const { tx } = useI18n()
  const navigate = useNavigate()
  const { cardholders, cashRules = [], selectCardholder, act, lithic } = useStore()
  const ruleLabel = useCashRuleLabel()
  const [selected, setSelected] = useState(() => new Set())
  const [bulkRule, setBulkRule] = useState('')
  const [error, setError] = useState('')

  const chosen = cardholders.map((p) => p.id).filter((id) => selected.has(id))
  const allChosen = cardholders.length > 0 && chosen.length === cardholders.length
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function assign(ruleId, cardholderIds) {
    setError('')
    try {
      await act('POST', '/api/admin/cash-rules/assign', { ruleId: ruleId || null, cardholderIds })
      return true
    } catch (err) {
      setError(err.message)
      return false
    }
  }

  return (
    <div className="page-stack">
      <div className="page-title">
        <p className="muted" style={{ margin: 0 }}>{tx("People who receive envelope credits. Each has a login, a Stipend IBAN and a Lithic card.")}</p>
        <Link className="btn" to="/admin/cardholders/new">{tx("New cardholder")}</Link>
      </div>
      <div className="card">
        {chosen.length > 0 && (
          <div className="bulk-bar" role="region" aria-label={tx("Bulk actions")}>
            <strong>{tx("{0} selected", { 0: chosen.length })}</strong>
            <select className="cash-select" aria-label={tx("Cash rule")} value={bulkRule} onChange={(e) => setBulkRule(e.target.value)}>
              <option value="">{tx("Choose a cash rule")}</option>
              {cashRules.map((r) => (
                <option key={r.id} value={r.id}>
                  {ruleLabel(r)}
                </option>
              ))}
            </select>
            <ActionButton className="btn" disabled={!bulkRule} onClick={() => assign(bulkRule, chosen).then((ok) => ok && setSelected(new Set()))}>
              {tx("Add to cash rule")}
            </ActionButton>
            <ActionButton
              confirmText={tx("Turn cash off for the selected cardholders? ATM withdrawals, quasi-cash and cashback will decline again.")}
              onClick={() => assign(null, chosen).then((ok) => ok && setSelected(new Set()))}
            >
              {tx("Turn cash off")}
            </ActionButton>
            <button className="btn ghost" type="button" onClick={() => setSelected(new Set())}>
              {tx("Clear selection")}
            </button>
          </div>
        )}
        <ErrorText error={error} />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label={tx("Select all cardholders")}
                    checked={allChosen}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(cardholders.map((p) => p.id)))}
                  />
                </th>
                <th>{tx("Name")}</th>
                <th>{tx("Beneficiary")}</th>
                <th>{tx("Card")}</th>
                <th>KYC</th>
                <th>{tx("Envelopes")}</th>
                <th>{tx("Available")}</th>
                <th>{tx("Cash")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {cardholders.map((p) => {
                const name = `${p.firstName} ${p.lastName}`
                const approved = p.cash?.status === 'APPROVED'
                return (
                  <tr key={p.id} className="clickable" onClick={() => navigate(`/admin/cardholders/${p.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={tx("Select {0}", { 0: name })} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    </td>
                    <td>
                      <strong>{name}</strong>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>
                        {p.email} · {p.city}, {countryName(p.country)}
                      </div>
                    </td>
                    <td>
                      <code>{p.beneficiaryRef}</code>
                    </td>
                    <td>{p.card?.token ? <>••{p.card.lastFour} <StatusBadge status={p.card.state} /></> : <span className="muted">{tx("not issued")}</span>}</td>
                    <td>
                      <StatusBadge status={p.kyc?.status} />
                    </td>
                    <td>{p.summary?.count ?? 0}</td>
                    <td>{eur(p.summary?.available ?? 0)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="cash-select"
                        aria-label={tx("Cash rule for {0}", { 0: name })}
                        value={approved ? p.cash.ruleId || '' : ''}
                        onChange={(e) => assign(e.target.value, [p.id])}
                      >
                        <option value="">{tx("Cash off")}</option>
                        {cashRules.map((r) => (
                          <option key={r.id} value={r.id}>
                            {ruleLabel(r)}
                          </option>
                        ))}
                      </select>
                      {approved && p.cashUsage && (
                        <div className="muted" style={{ fontSize: '0.8rem' }}>
                          {tx("{0} used", { 0: eur(p.cashUsage.usedCents) })}
                        </div>
                      )}
                      {p.cash?.status === 'REQUESTED' && (
                        <div style={{ fontSize: '0.8rem' }}>
                          <StatusBadge status="REQUESTED" />{' '}
                          {eur(p.cash.requestedCents)} {tx(CASH_PER[p.cash.requestedPeriod] || 'per month')}
                        </div>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        <button
                          className="btn ghost"
                          type="button"
                          onClick={() => {
                            selectCardholder(p.id)
                            navigate('/')
                          }}
                        >{tx("Open app")}</button>
                        {!p.card?.token && lithic?.configured && (
                          <ActionButton onClick={() => act('POST', `/api/admin/cardholders/${p.id}/issue`)}>{tx("Issue card")}</ActionButton>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <CashRules />
    </div>
  )
}

function RuleFields({ value, onChange }) {
  const { tx } = useI18n()
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value })
  return (
    <>
      <label className="field" style={{ margin: 0, flex: '1 1 200px' }}>
        <span>{tx("Rule name")}</span>
        <input required maxLength={80} value={value.name} onChange={set('name')} />
      </label>
      <label className="field" style={{ margin: 0 }}>
        <span>{tx("Limit (EUR)")}</span>
        <input required inputMode="decimal" value={value.limit} onChange={set('limit')} />
      </label>
      <label className="field" style={{ margin: 0 }}>
        <span>{tx("Period")}</span>
        <select value={value.period} onChange={set('period')}>
          {CASH_PERIODS.map((p) => (
            <option key={p} value={p}>
              {tx(CASH_PERIOD_LABELS[p])}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

/** Shared cash limits. Each rule is one set of account-level velocity limits on Lithic, shared by its members. */
function CashRules() {
  const { tx } = useI18n()
  const { cashRules = [], cardholders, act, lithic } = useStore()
  const empty = { name: '', limit: '100', period: 'MONTH' }
  const [draft, setDraft] = useState(empty)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const sync = lithic?.cashRules

  async function save(e, rule) {
    e.preventDefault()
    setError('')
    const fields = rule ? editing : draft
    const limitCents = toCents(fields.limit)
    if (!Number.isFinite(limitCents) || limitCents <= 0) {
      setError(tx("Enter a limit above 0."))
      return
    }
    try {
      const body = { name: fields.name, limitCents, period: fields.period }
      if (rule) {
        await act('PATCH', `/api/admin/cash-rules/${rule.id}`, body)
        setEditing(null)
      } else {
        await act('POST', '/api/admin/cash-rules', body)
        setDraft(empty)
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const names = (ids) =>
    ids
      .map((id) => cardholders.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => `${c.firstName} ${c.lastName}`)
      .join(', ')

  return (
    <Section
      title={tx("Cash rules")}
      hint={tx("Cash is off for every card. Add cardholders to a rule to allow cash up to its limit; the limit is per cardholder account. It counts ATM and bank-counter cash, quasi-cash, money transfers and cashback at the till.")}
      actions={lithic?.configured && <ActionButton onClick={() => act('POST', '/api/admin/cash-rules/sync')}>{tx("Sync with Lithic")}</ActionButton>}
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{tx("Rule name")}</th>
              <th>{tx("Limit")}</th>
              <th>{tx("Members")}</th>
              <th style={{ textAlign: 'right' }}>{tx("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {!cashRules.length && (
              <tr>
                <td colSpan={4} className="empty">
                  {tx("No cash rules yet.")}
                </td>
              </tr>
            )}
            {cashRules.map((rule) =>
              editing?.id === rule.id ? (
                <tr key={rule.id}>
                  <td colSpan={4}>
                    <form className="toolbar" style={{ alignItems: 'flex-end' }} onSubmit={(e) => save(e, rule)}>
                      <RuleFields value={editing} onChange={setEditing} />
                      <button className="btn" type="submit">{tx("Save")}</button>
                      <button className="btn ghost" type="button" onClick={() => setEditing(null)}>{tx("Cancel")}</button>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={rule.id}>
                  <td>
                    <strong>{rule.name}</strong>
                  </td>
                  <td>{eur(rule.limitCents)} {tx(CASH_PER[rule.period])}</td>
                  <td>
                    {rule.memberIds.length}
                    {rule.memberIds.length > 0 && <div className="muted" style={{ fontSize: '0.8rem' }}>{names(rule.memberIds)}</div>}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn ghost" type="button" onClick={() => setEditing({ id: rule.id, name: rule.name, limit: (rule.limitCents / 100).toFixed(2), period: rule.period })}>
                        {tx("Edit")}
                      </button>
                      <ActionButton
                        className="btn ghost"
                        disabled={rule.memberIds.length > 0}
                        confirmText={tx("Delete this cash rule?")}
                        onClick={() => act('DELETE', `/api/admin/cash-rules/${rule.id}`)}
                      >
                        {tx("Delete")}
                      </ActionButton>
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <form className="toolbar" style={{ alignItems: 'flex-end', marginTop: 14 }} onSubmit={(e) => save(e, null)}>
        <RuleFields value={draft} onChange={setDraft} />
        <button className="btn" type="submit">{tx("Add rule")}</button>
      </form>
      <ErrorText error={error} />
      {sync?.error && <ErrorText error={tx("Lithic sync failed: {0}", { 0: sync.error })} />}
      {sync?.syncedAt && !sync.error && <p className="muted cash-note">{tx("Synced with Lithic {0}", { 0: formatDateTime(sync.syncedAt) })}</p>}
      <details className="cash-categories">
        <summary>{tx("What counts as cash")}</summary>
        <ul>
          {Object.entries(CASH_MCCS).map(([code, label]) => (
            <li key={code}>
              <code>{code}</code> {tx(label)}
            </li>
          ))}
          <li>{tx("Cashback at any merchant, e.g. a supermarket till (the network's cashback amount)")}</li>
        </ul>
      </details>
    </Section>
  )
}
