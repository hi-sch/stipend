import { useState } from 'react'
import { useStore } from '../../store.jsx'
import { get, post } from '../../api.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { ActionButton, ErrorText, JsonView, OkText, Section, StatusBadge, useLoad } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Ledger() {
  const { tx } = useI18n()
  const { lithic, environment } = useStore()
  const ledger = useLoad(() => (lithic?.configured ? get('/api/admin/ledger') : null), [lithic?.configured])
  const [account, setAccount] = useState('')
  const activity = useLoad(() => (lithic?.configured ? get(`/api/admin/ledger/activity${account ? `?financialAccountToken=${account}` : ''}`) : null), [account, lithic?.configured])
  const transfers = useLoad(() => (lithic?.configured ? get('/api/admin/ledger/book-transfers') : null), [lithic?.configured])
  const [amount, setAmount] = useState('10000.00')
  const [funded, setFunded] = useState('')
  const [date, setDate] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10))
  const [settlement, setSettlement] = useState(null)

  if (!lithic?.configured) return <p className="empty">{tx("Configure LITHIC_API_KEY to see the Lithic ledger.")}</p>
  const balances = Object.fromEntries((ledger.data?.balances || []).map((b) => [b.financial_account_token, b]))

  return (
    <div className="page-stack">
      <Section title={tx("Financial accounts")} actions={<button className="btn ghost" type="button" onClick={ledger.reload}>{tx("Refresh")}</button>}>
        <ErrorText error={ledger.error} />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{tx("Account")}</th>
                <th>{tx("Type")}</th>
                <th>{tx("Status")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Available")}</th>
                <th style={{ textAlign: 'right' }}>{tx("Pending")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(ledger.data?.accounts || []).map((a) => (
                <tr key={a.token} className={account === a.token ? 'on' : ''}>
                  <td>
                    <strong>{a.nickname || (a.account_token ? 'Cardholder account' : 'Program')}</strong>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>{a.token}</div>
                  </td>
                  <td>{a.type}</td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td style={{ textAlign: 'right' }}>{balances[a.token] ? eur(balances[a.token].available_amount) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{balances[a.token] ? eur(balances[a.token].pending_amount) : '—'}</td>
                  <td>
                    <button className="btn ghost" type="button" onClick={() => setAccount(a.token)}>{tx("Activity")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid-2">
        {environment === 'sandbox' && (
          <Section title={tx("Fund the program")} hint={tx("Simulates an inbound ACH credit into the program ISSUING account so DISBURSE book transfers for envelope credits can post.")}>
            <form
              className="toolbar"
              style={{ display: 'flex', alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault()
              }}
            >
              <label className="field" style={{ margin: 0 }}>
                <span>{tx("Amount (USD in sandbox)")}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <div style={{ padding: '3px 4px' }}>
                <ActionButton
                  className="btn"
                  onClick={async () => {
                    const res = await post('/api/admin/ledger/fund', { amountCents: Math.round(parseFloat(amount.replace(',', '.')) * 100), financialAccountToken: account || undefined })
                    setFunded(`Receipt ${res.result || 'submitted'} · ${res.transaction_event_token || ''}`)
                    await ledger.reload()
                  }}
                >{tx("Simulate ACH receipt")}</ActionButton>
              </div>
            </form>
            <OkText>{funded}</OkText>
          </Section>
        )}
        <Section title={tx("Settlement summary")} hint={tx("Settlement reports are an enterprise product and are usually empty in the sandbox.")}>
          <div className="toolbar">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={tx("Report date")} />
            <ActionButton onClick={async () => setSettlement(await get(`/api/admin/ledger/settlement?date=${date}`))}>{tx("Load")}</ActionButton>
          </div>
          {settlement && <JsonView value={settlement} />}
        </Section>
      </div>

      <Holds accounts={ledger.data?.accounts || []} account={account} />
      <ExternalPayments accounts={ledger.data?.accounts || []} account={account} />

      <Section title={tx("Account activity")} hint={account ? `Account ${account}` : 'All public accounts'}>
        <ErrorText error={activity.error} />
        <table className="data">
          <tbody>
            {(activity.data?.data || []).map((row) => (
              <tr key={row.token}>
                <td>{formatDateTime(row.created)}</td>
                <td>
                  {row.family} · {row.category}
                  <div className="muted" style={{ fontSize: '0.78rem' }}>{row.descriptor}</div>
                </td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td style={{ textAlign: 'right' }}>{eur(row.settled_amount ?? row.pending_amount ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={tx("Book transfers")}>
        <ErrorText error={transfers.error} />
        <table className="data">
          <tbody>
            {(transfers.data?.data || []).map((row) => (
              <tr key={row.token}>
                <td>{formatDateTime(row.created)}</td>
                <td>
                  {row.category} · {row.events?.[0]?.type}
                  <div className="muted" style={{ fontSize: '0.78rem' }}>{row.events?.[0]?.memo || row.external_id}</div>
                </td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td style={{ textAlign: 'right' }}>{eur(row.settled_amount ?? row.pending_amount ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}

function AccountSelect({ accounts, value, onChange, id }) {
  const { tx } = useI18n()
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{tx("Choose account…")}</option>
      {accounts.map((a) => (
        <option key={a.token} value={a.token}>
          {a.type} · {a.nickname || (a.account_token ? 'cardholder' : 'program')} · {a.token.slice(0, 8)}
        </option>
      ))}
    </select>
  )
}

function Holds({ accounts, account }) {
  const { tx } = useI18n()
  const [fa, setFa] = useState(account || '')
  const holds = useLoad(() => (fa ? get(`/api/admin/ledger/holds?financialAccountToken=${fa}`) : null), [fa])
  const [amount, setAmount] = useState('50.00')
  const [memo, setMemo] = useState('')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')
  return (
    <Section title={tx("Holds")} hint={tx("Reserve funds on a financial account (for example while a recall is investigated) and release them by voiding the hold.")}>
      <form
        className="toolbar"
        style={{ display: 'flex', alignItems: 'flex-end' }}
        onSubmit={async (e) => {
          e.preventDefault()
          setError('')
          try {
            await post('/api/admin/ledger/holds', { financialAccountToken: fa, amountCents: Math.round(parseFloat(amount.replace(',', '.')) * 100), memo, expiresAt: expires || undefined })
            await holds.reload()
          } catch (err) {
            setError(err.message)
          }
        }}
      >
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Account")}</span>
          <AccountSelect accounts={accounts} value={fa} onChange={setFa} id="hold-account" />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Amount")}</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Memo")}</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Expires")}</span>
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <div style={{ padding: '3px 4px' }}>
          <button className="btn" type="submit" disabled={!fa}>{tx("Place hold")}</button>
        </div>
      </form>
      <ErrorText error={error || holds.error} />
      <table className="data" style={{ marginTop: 12 }}>
        <tbody>
          {(holds.data?.data || []).map((h) => (
            <tr key={h.token}>
              <td>{formatDateTime(h.created)}</td>
              <td>{h.events?.[0]?.memo || h.user_defined_id || '—'}</td>
              <td>
                <StatusBadge status={h.status} />
              </td>
              <td style={{ textAlign: 'right' }}>{eur(h.pending_amount)}</td>
              <td>{h.status === 'PENDING' && <ActionButton onClick={() => post(`/api/admin/ledger/holds/${h.token}/void`, { memo: 'Released by operator' }).then(holds.reload)}>{tx("Void")}</ActionButton>}</td>
            </tr>
          ))}
          {fa && !holds.loading && !(holds.data?.data || []).length && (
            <tr>
              <td>
                <p className="empty">{tx("No holds on this account.")}</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Section>
  )
}

const CATEGORIES = ['EXTERNAL_TRANSFER', 'EXTERNAL_ACH', 'EXTERNAL_WIRE', 'EXTERNAL_CHECK', 'EXTERNAL_FEDNOW', 'EXTERNAL_RTP']

function ExternalPayments({ accounts, account }) {
  const { tx } = useI18n()
  const payments = useLoad(() => get(`/api/admin/ledger/external-payments${account ? `?financialAccountToken=${account}` : ''}`), [account])
  const [form, setForm] = useState({ financialAccountToken: account || '', amount: '1000.00', category: 'EXTERNAL_TRANSFER', paymentType: 'DEPOSIT', progressTo: '', memo: 'Agency funding' })
  const [error, setError] = useState('')
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  return (
    <Section title={tx("External payments")} hint={tx("Record money that moved outside Lithic, such as an agency funding the program by SEPA, and progress it through settlement.")}>
      <form
        className="toolbar"
        onSubmit={async (e) => {
          e.preventDefault()
          setError('')
          try {
            await post('/api/admin/ledger/external-payments', { ...form, amountCents: Math.round(parseFloat(form.amount.replace(',', '.')) * 100), progressTo: form.progressTo || undefined })
            await payments.reload()
          } catch (err) {
            setError(err.message)
          }
        }}
      >
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Account")}</span>
          <AccountSelect accounts={accounts} value={form.financialAccountToken} onChange={set('financialAccountToken')} id="ext-account" />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Amount")}</span>
          <input inputMode="decimal" value={form.amount} onChange={(e) => set('amount')(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Type")}</span>
          <select value={form.paymentType} onChange={(e) => set('paymentType')(e.target.value)}>
            <option>DEPOSIT</option>
            <option>WITHDRAWAL</option>
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Category")}</span>
          <select value={form.category} onChange={(e) => set('category')(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Progress to")}</span>
          <select value={form.progressTo} onChange={(e) => set('progressTo')(e.target.value)}>
            <option value="">{tx("Pending")}</option>
            <option>SETTLED</option>
            <option>RELEASED</option>
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{tx("Memo")}</span>
          <input value={form.memo} onChange={(e) => set('memo')(e.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={!form.financialAccountToken}>{tx("Record payment")}</button>
      </form>
      <ErrorText error={error || payments.error} />
      <table className="data" style={{ marginTop: 12 }}>
        <tbody>
          {(payments.data?.data || []).map((p) => (
            <tr key={p.token}>
              <td>{formatDateTime(p.created)}</td>
              <td>
                {p.payment_type} · {p.category}
                <div className="muted" style={{ fontSize: '0.78rem' }}>{p.events?.[0]?.memo || p.user_defined_id || ''}</div>
              </td>
              <td>
                <StatusBadge status={p.status} />
              </td>
              <td style={{ textAlign: 'right' }}>{eur(p.settled_amount || p.pending_amount || 0)}</td>
              <td>
                <div className="row-actions">
                  {['settle', 'release', 'cancel', 'reverse'].map((action) => (
                    <ActionButton key={action} onClick={() => post(`/api/admin/ledger/external-payments/${p.token}/${action}`, { memo: `${action} by operator` }).then(payments.reload)}>
                      {action}
                    </ActionButton>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}
