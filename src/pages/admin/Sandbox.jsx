import { useMemo, useState } from 'react'
import { useStore } from '../../store.jsx'
import { api, get, post } from '../../api.js'
import { signBody } from '../../lib/hmac.js'
import { samplePain001, sampleJson, sampleCamt056 } from '../../lib/pain001.js'
import { eur, formatDateTime } from '../../lib/format.js'
import CodeEditor from '../../components/CodeEditor.jsx'
import MccSelect from '../../components/MccSelect.jsx'
import { ActionButton, ErrorText, JsonView, Section, StatusBadge, Tabs } from '../../components/ui.jsx'
import { useI18n } from '../../i18n/I18n.jsx'

export default function Sandbox() {
  const { tx } = useI18n()
  const { environment } = useStore()
  const [tab, setTab] = useState('hooks')
  return (
    <div className="page-stack">
      {environment !== 'sandbox' && <p className="synth">{tx("Lithic simulations are disabled outside the sandbox. Hook tests still work.")}</p>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['hooks', tx("Agency hooks")],
          ['purchase', tx("Purchases")],
          ['lifecycle', tx("Transaction lifecycle")],
        ]}
      />
      {tab === 'hooks' && <HookTester />}
      {tab === 'purchase' && <PurchaseTester />}
      {tab === 'lifecycle' && <LifecycleTester />}
    </div>
  )
}

function HookTester() {
  const { tx } = useI18n()
  const { connections, cardholders, allCredits, country, refresh } = useStore()
  const scoped = connections.filter((c) => c.country === country)
  const [connectionId, setConnectionId] = useState('')
  const conn = scoped.find((c) => c.id === connectionId) || scoped[0]
  const [kind, setKind] = useState('credit')
  const [format, setFormat] = useState('pain001')
  const [holderIds, setHolderIds] = useState([cardholders[0]?.id].filter(Boolean))
  const [amount, setAmount] = useState('150.00')
  const [edited, setEdited] = useState(null)
  const [response, setResponse] = useState(null)
  const [error, setError] = useState('')
  const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100) || 0
  const credits = allCredits.filter((c) => c.connectionId === conn?.id && c.status !== 'RECALLED')
  const [creditId, setCreditId] = useState('')
  const recallTarget = credits.find((c) => c.id === creditId) || credits[0]

  const build = (stamp) => {
    if (!conn) return ''
    if (kind === 'recall') return recallTarget ? sampleCamt056({ endToEndId: recallTarget.endToEndId, amountCents: recallTarget.amountCents }) : ''
    const people = cardholders.filter((c) => holderIds.includes(c.id))
    if (format === 'json') {
      if (people.length <= 1) return sampleJson({ connectionId: conn.id, amountCents: cents, endToEndId: `E2E-${stamp}`, purpose: conn.purpose, beneficiaryRef: people[0]?.beneficiaryRef })
      return JSON.stringify({ message_id: `MSG-${stamp}`, credits: people.map((p, i) => ({ amount: cents, currency: 'EUR', end_to_end_id: `E2E-${stamp}-${i + 1}`, beneficiary_ref: p.beneficiaryRef, remittance: `Credit via ${conn.name}` })) }, null, 2)
    }
    return samplePain001({
      connectionName: conn.name,
      debtorName: conn.agency,
      purpose: conn.purpose,
      transactions: people.map((p, i) => ({ amountCents: cents, endToEndId: `E2E-${stamp}-${i + 1}`, creditorName: `${p.firstName} ${p.lastName}`, creditorIban: p.iban, beneficiaryRef: p.beneficiaryRef, remittance: `Credit via ${conn.name}` })),
    })
  }
  const preview = useMemo(() => build('PREVIEW'), [conn, kind, format, holderIds, cents, recallTarget]) // eslint-disable-line react-hooks/exhaustive-deps
  const body = edited ?? preview

  async function send() {
    setError('')
    setResponse(null)
    try {
      const { hmacSecret } = await post(`/api/admin/connections/${conn.id}/secret`, {})
      const raw = edited ?? build(Date.now().toString(36).toUpperCase())
      const sig = await signBody(hmacSecret, raw)
      const res = await fetch(`/api/hooks/${kind === 'recall' ? 'recalls' : 'credits'}/${encodeURIComponent(conn.id)}`, {
        method: 'POST',
        headers: { 'X-Stipend-Signature': `sha256=${sig}`, Accept: 'application/json' },
        body: raw,
      })
      setResponse({ status: res.status, body: await res.json().catch(() => null) })
      setEdited(null)
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!scoped.length) return <p className="empty">{tx("Create a connection in this country first.")}</p>
  return (
    <div className="grid-2">
      <Section title={tx("Signed agency request")} hint={tx("Signs the body with the connection secret and posts it to the public hook, exactly like a paying system would.")}>
        <div className="field">
          <label htmlFor="sb-conn">{tx("Connection")}</label>
          <select id="sb-conn" value={conn?.id} onChange={(e) => { setConnectionId(e.target.value); setEdited(null) }}>
            {scoped.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Tabs value={kind} onChange={(k) => { setKind(k); setEdited(null) }} tabs={[['credit', tx("Credit")], ['recall', tx("Recall (camt.056)")]]} />
        {kind === 'credit' ? (
          <>
            <div className="row-2" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="sb-format">{tx("Format")}</label>
                <select id="sb-format" value={format} onChange={(e) => { setFormat(e.target.value); setEdited(null) }}>
                  <option value="pain001">{tx("ISO 20022 pain.001")}</option>
                  <option value="json">JSON</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="sb-amount">{tx("Amount per beneficiary (EUR)")}</label>
                <input id="sb-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setEdited(null) }} />
              </div>
            </div>
            <div className="field">
              <label>{tx("Beneficiaries")}</label>
              <div className="mcc-grid">
                {cardholders.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`mcc-opt ${holderIds.includes(c.id) ? 'on' : ''}`}
                    onClick={() => { setHolderIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id])); setEdited(null) }}
                  >
                    {c.firstName} {c.lastName} · {c.beneficiaryRef}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="sb-credit">{tx("Credit to recall")}</label>
            <select id="sb-credit" value={recallTarget?.id || ''} onChange={(e) => { setCreditId(e.target.value); setEdited(null) }}>
              {credits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.endToEndId} · {eur(c.amountCents)} · {formatDateTime(c.created)}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn" type="button" onClick={send} disabled={!body || (kind === 'credit' && !holderIds.length)}>{tx("Send signed request")}</button>
        <ErrorText error={error} />
      </Section>
      <Section title={tx("Request and response")}>
        <CodeEditor language={body.trim().startsWith('{') ? 'json' : 'xml'} value={body} onChange={setEdited} minHeight={260} maxHeight={360} />
        {response && (
          <div style={{ marginTop: 12 }}>
            <p>
              HTTP {response.status} {response.body?.groupStatus && <StatusBadge status={response.body.groupStatus} />}
              {response.body?.reportId && (
                <>
                  {' '}
                  <a href={`/api/admin/reports/${response.body.reportId}`}>{tx("Status report")}</a>
                </>
              )}
            </p>
            <JsonView value={response.body} />
          </div>
        )}
      </Section>
    </div>
  )
}

function PurchaseTester() {
  const { tx } = useI18n()
  const { cardholders, refresh } = useStore()
  const [holderId, setHolderId] = useState(cardholders[0]?.id || '')
  const [mcc, setMcc] = useState('5411')
  const [merchant, setMerchant] = useState('TEST MERCHANT')
  const [amount, setAmount] = useState('25.00')
  const [country, setCountry] = useState('DEU')
  const [partial, setPartial] = useState(false)
  const [cash, setCash] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function run(e) {
    e.preventDefault()
    setError('')
    setResult(null)
    try {
      setResult(
        await api('POST', `/api/me/purchases?cardholderId=${encodeURIComponent(holderId)}`, {
          amountCents: Math.round(parseFloat(amount.replace(',', '.')) * 100),
          mcc,
          merchant,
          country,
          partialApprovalCapable: partial,
          cashCents: cash ? Math.round(parseFloat(cash.replace(',', '.')) * 100) : 0,
        }),
      )
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Section title={tx("Simulate a card purchase")} hint={tx("Authorizes in the Lithic sandbox (or locally without a Lithic card), runs the envelope engine and clears approved purchases.")}>
      <form onSubmit={run}>
        <div className="row-2">
          <div className="field">
            <label htmlFor="pt-holder">{tx("Cardholder")}</label>
            <select id="pt-holder" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
              {cardholders.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName} {c.card?.token ? `· ••${c.card.lastFour}` : '· local'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pt-merchant">{tx("Merchant descriptor")}</label>
            <input id="pt-merchant" maxLength={25} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </div>
        </div>
        <div className="row-2">
          <div className="field">
            <label htmlFor="pt-mcc">MCC</label>
            <MccSelect id="pt-mcc" value={mcc} onChange={setMcc} />
          </div>
          <div className="field">
            <label htmlFor="pt-amount">{tx("Amount")}</label>
            <input id="pt-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pt-cash">{tx("Cash / cashback amount (EUR)")}</label>
          <input id="pt-cash" inputMode="decimal" placeholder={tx("0 = none. At cash categories (ATM, quasi-cash, money transfer) the whole amount is cash.")} value={cash} onChange={(e) => setCash(e.target.value)} />
        </div>
        <div className="row-2">
          <div className="field">
            <label htmlFor="pt-country">{tx("Merchant country (alpha-3)")}</label>
            <input id="pt-country" maxLength={3} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
          </div>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />{' '}{tx("Partial approval capable")}</label>
        </div>
        <button className="btn" type="submit">{tx("Authorize")}</button>
      </form>
      <ErrorText error={error} />
      {result && <JsonView value={result} />}
    </Section>
  )
}

function LifecycleTester() {
  const { tx } = useI18n()
  const { allTransactions, refresh, cardholders } = useStore()
  const live = allTransactions.filter((t) => t.live)
  const [txnId, setTxnId] = useState(live[0]?.id || '')
  const txn = live.find((t) => t.id === txnId)
  const [amount, setAmount] = useState('')
  const [output, setOutput] = useState(null)
  const cents = amount ? Math.round(parseFloat(amount.replace(',', '.')) * 100) : undefined

  const action = (name) => async () => {
    setOutput(await post(`/api/admin/transactions/${txnId}/simulate`, { action: name, amountCents: cents }))
    await refresh()
  }

  if (!live.length) return <p className="empty">{tx("No Lithic transactions yet. Simulate a purchase first.")}</p>
  return (
    <Section title={tx("Transaction lifecycle")} hint={tx("Drive a live sandbox transaction through clearing, reversal, expiry and refunds. Envelopes follow the reconciled Lithic state.")}>
      <div className="row-2">
        <div className="field">
          <label htmlFor="lc-txn">{tx("Transaction")}</label>
          <select id="lc-txn" value={txnId} onChange={(e) => setTxnId(e.target.value)}>
            {live.map((t) => {
              const h = cardholders.find((c) => c.id === t.cardholderId)
              return (
                <option key={t.id} value={t.id}>
                  {t.merchant?.descriptor} · {eur(t.amountCents)} · {t.status} · {h?.firstName}
                </option>
              )
            })}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lc-amount">{tx("Amount (blank = transaction amount)")}</label>
          <input id="lc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </div>
      {txn && (
        <p>
          <StatusBadge status={txn.status} />{' '}{tx("{0} · envelope debit {1}", { 0: txn.kind, 1: eur(txn.debitedCents) })}</p>
      )}
      <div className="toolbar">
        <ActionButton onClick={action('clearing')}>{tx("Clear")}</ActionButton>
        <ActionButton onClick={action('authorization_advice')}>{tx("Authorization advice")}</ActionButton>
        <ActionButton onClick={action('void')}>{tx("Reverse (void)")}</ActionButton>
        <ActionButton onClick={action('expire')}>{tx("Expire authorization")}</ActionButton>
        <ActionButton onClick={action('return')}>{tx("Refund (return)")}</ActionButton>
        <ActionButton onClick={action('return_reversal')}>{tx("Return reversal")}</ActionButton>
        <ActionButton onClick={async () => setOutput(await get(`/api/admin/transactions/${txnId}/enhanced`))}>{tx("Enhanced data (L2/L3)")}</ActionButton>
      </div>
      {output && <JsonView value={output} />}
    </Section>
  )
}
