import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { get } from '../../api.js'
import { eur, formatDateTime } from '../../lib/format.js'
import { ActionButton, ErrorText, KeyValues, Section, SecretOnce, StatusBadge, JsonView, useLoad } from '../../components/ui.jsx'
import ConfirmDialog from '../../components/ConfirmDialog.jsx'
import { useI18n } from '../../i18n/I18n.jsx'
import { CASH_PER, useCashRuleLabel } from './Cardholders.jsx'

const SHIPPING = ['STANDARD', 'STANDARD_WITH_TRACKING', 'PRIORITY', 'EXPRESS', '2_DAY', 'EXPEDITED']

export default function CardholderDetail() {
  const { tx } = useI18n()
  const { id } = useParams()
  const navigate = useNavigate()
  const { allTransactions, act, selectCardholder, lithic, version } = useStore()
  const [edit, setEdit] = useState(null)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [kyc, setKyc] = useState(null)
  const [shipping, setShipping] = useState('STANDARD')
  const [limit, setLimit] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // This page is the only one that needs a whole cardholder, so it asks for one rather than
  // every operator carrying every cardholder's phone number, IBAN and Lithic tokens in the
  // shared payload. Keyed on the program version as well as the id: every write bumps it,
  // which is what reloads this after issuing a card or deciding a cash request.
  const detail = useLoad(() => get(`/api/admin/cardholders/${id}`), [id, version])
  const person = detail.data

  if (!person) {
    return detail.loading ? (
      <p className="empty">{tx("Loading…")}</p>
    ) : (
      <p>{tx("Unknown cardholder.")}{' '}<Link to="/admin/cardholders">{tx("Back")}</Link>
      </p>
    )
  }
  const login = person.login
  const card = person.card || {}
  const live = Boolean(card.token)
  const txns = allTransactions.filter((t) => t.cardholderId === person.id).slice(0, 15)
  const cardAction = (action, body = {}) => act('POST', `/api/admin/cardholders/${person.id}/card/${action}`, body)

  async function saveProfile(e) {
    e.preventDefault()
    setError('')
    try {
      await act('PATCH', `/api/admin/cardholders/${person.id}`, edit)
      setEdit(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-title">
        <div>
          <h2 style={{ margin: 0 }}>
            {person.firstName} {person.lastName}
          </h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {person.email} · {person.city}
          </p>
        </div>
        <div className="row-actions">
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              selectCardholder(person.id)
              navigate('/')
            }}
          >{tx("Open cardholder app")}</button>
          <button className="btn danger" type="button" onClick={() => setConfirmDelete(true)}>{tx("Delete")}</button>
        </div>
      </div>

      <div className="grid-2">
        <Section title={tx("Profile")} actions={!edit && <button className="btn ghost" type="button" onClick={() => setEdit({ firstName: person.firstName, lastName: person.lastName, email: person.email, phone: person.phone || '', city: person.city, beneficiaryRef: person.beneficiaryRef })}>{tx("Edit")}</button>}>
          {edit ? (
            <form onSubmit={saveProfile}>
              {[
                ['firstName', 'First name'],
                ['lastName', 'Last name'],
                ['email', 'Email'],
                ['phone', 'Phone'],
                ['city', 'City'],
                ['beneficiaryRef', 'Beneficiary reference'],
              ].map(([key, label]) => (
                <div className="field" key={key}>
                  <label htmlFor={`p-${key}`}>{label}</label>
                  <input id={`p-${key}`} value={edit[key]} onChange={(e) => setEdit({ ...edit, [key]: e.target.value })} />
                </div>
              ))}
              <ErrorText error={error} />
              <div className="card-actions">
                <button className="btn ghost" type="button" onClick={() => setEdit(null)}>{tx("Cancel")}</button>
                <button className="btn" type="submit">{tx("Save (also updates Lithic account holder)")}</button>
              </div>
            </form>
          ) : (
            <KeyValues
              rows={[
                [tx("Stipend IBAN"), <code key="i">{person.iban}</code>],
                [tx("Beneficiary reference"), <code key="r">{person.beneficiaryRef}</code>],
                [tx("Phone"), person.phone || '—'],
                [tx("Login"), login ? `${login.email}${login.mustChangePassword ? ' (must change password)' : ''}` : 'none'],
                [tx("Account holder"), person.lithicHolder || '—'],
                [tx("Account"), person.lithicAccount || '—'],
              ]}
            />
          )}
          <div className="toolbar" style={{ marginTop: 12 }}>
            <ActionButton onClick={async () => setPassword((await act('POST', `/api/admin/cardholders/${person.id}/password`)).temporaryPassword)}>{tx("Reset password")}</ActionButton>
          </div>
          <SecretOnce label={tx("Temporary password")} value={password} onDone={() => setPassword('')} />
        </Section>

        <Section
          title="KYC"
          hint={tx("Lithic account holder verification status.")}
          actions={person.lithicHolder && <ActionButton onClick={async () => setKyc(await get(`/api/admin/cardholders/${person.id}/kyc`))}>{tx("Check")}</ActionButton>}
        >
          <KeyValues rows={[[tx("Status"), <StatusBadge key="k" status={kyc?.status || person.kyc?.status} />], [tx("Reasons"), (kyc?.statusReasons || person.kyc?.statusReasons || []).join(', ') || '—'], [tx("Checked"), person.kyc?.checkedAt ? formatDateTime(person.kyc.checkedAt) : '—']]} />
        </Section>
      </div>

      <Section
        title={tx("Card")}
        actions={
          <div className="toolbar">
            {!live && lithic?.configured && <ActionButton className="btn" onClick={() => act('POST', `/api/admin/cardholders/${person.id}/issue`)}>{tx("Issue virtual card")}</ActionButton>}
            {live && <ActionButton onClick={() => cardAction('refresh')}>{tx("Refresh")}</ActionButton>}
            {live && <ActionButton onClick={() => act('POST', `/api/admin/cardholders/${person.id}/rules/sync`)}>{tx("Sync auth rules")}</ActionButton>}
          </div>
        }
      >
        <KeyValues
          rows={[
            [tx("State"), <StatusBadge key="s" status={card.state} />],
            [tx("Type"), card.type],
            [tx("Last four"), card.lastFour || '—'],
            [tx("Expiry"), card.expMonth ? `${card.expMonth}/${card.expYear}` : '—'],
            [tx("Spend limit"), card.spendLimit ? `${eur(card.spendLimit)} ${String(card.spendLimitDuration || '').toLowerCase()}` : '—'],
            [tx("MCC rule"), card.mccRuleToken || '—'],
            [tx("Velocity rule"), card.velocityRuleToken || '—'],
            [tx("Physical"), person.physical ? JSON.stringify(person.physical) : '—'],
          ]}
        />
        {live && (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="toolbar">
              {card.state === 'OPEN' && <ActionButton onClick={() => cardAction('state', { state: 'PAUSED' })}>{tx("Freeze")}</ActionButton>}
              {card.state === 'PAUSED' && <ActionButton onClick={() => cardAction('state', { state: 'OPEN' })}>{tx("Unfreeze")}</ActionButton>}
              {card.state !== 'CLOSED' && (
                <ActionButton className="btn danger" confirmText={tx("Close this card permanently?")} onClick={() => cardAction('state', { state: 'CLOSED' })}>{tx("Close card")}</ActionButton>
              )}
            </div>
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault()
                cardAction('spend-limit', { spendLimitCents: Math.round(parseFloat(limit.replace(',', '.')) * 100), duration: 'MONTHLY' }).catch((err) => setError(err.message))
              }}
            >
              <label className="field" style={{ margin: 0 }}>
                <span>{tx("Monthly spend limit (EUR)")}</span>
                <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={card.spendLimit ? (card.spendLimit / 100).toFixed(2) : ''} />
              </label>
              <button className="btn ghost" type="submit" disabled={!limit}>{tx("Update limit")}</button>
            </form>
            <div className="toolbar">
              <label className="field" style={{ margin: 0 }}>
                <span>{tx("Shipping method")}</span>
                <select value={shipping} onChange={(e) => setShipping(e.target.value)}>
                  {SHIPPING.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              {card.type !== 'PHYSICAL' && <ActionButton onClick={() => cardAction('physical', { shippingMethod: shipping })}>{tx("Convert to physical")}</ActionButton>}
              {card.type === 'PHYSICAL' && <ActionButton onClick={() => cardAction('reissue', { shippingMethod: shipping })}>{tx("Reissue")}</ActionButton>}
              <ActionButton onClick={() => cardAction('renew', { shippingMethod: shipping })}>{tx("Renew")}</ActionButton>
            </div>
            <ErrorText error={error} />
          </div>
        )}
      </Section>

      <CashBudgetPanel person={person} />

      <Section title={tx("Recent transactions")}>
        {!txns.length && <p className="empty">{tx("No transactions.")}</p>}
        <table className="data">
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.merchant?.descriptor}</strong>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {t.merchant?.mcc} · {t.note || (t.detailedResults || []).join(', ')}
                  </div>
                </td>
                <td>{formatDateTime(t.created)}</td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td style={{ textAlign: 'right' }}>{eur(t.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {/* What Lithic answered when Check was pressed. This read person.kycRaw, a field no
          query has ever returned and no column has ever held, so the panel could not appear
          at all. The stored kyc block is a summary; this is the reply behind it. */}
      {kyc && <JsonView value={kyc} />}
      {confirmDelete && (
        <ConfirmDialog
          title={tx("Delete {0} {1}?", { 0: person.firstName, 1: person.lastName })}
          body={tx("Closes the Lithic card, removes the login and the envelopes. Transaction history is kept.")}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await act('DELETE', `/api/admin/cardholders/${person.id}`)
            navigate('/admin/cardholders')
          }}
        />
      )}
    </div>
  )
}

function CashBudgetPanel({ person }) {
  const { tx } = useI18n()
  const { act, cashRules = [] } = useStore()
  const ruleLabel = useCashRuleLabel()
  const cash = person.cash || { status: 'NONE' }
  const usage = person.cashUsage
  // Suggest the rule closest to what was requested.
  const suggested =
    cashRules.find((r) => r.limitCents === cash.requestedCents && r.period === cash.requestedPeriod) ||
    cashRules.find((r) => r.period === cash.requestedPeriod && r.limitCents >= (cash.requestedCents || 0)) ||
    cashRules[0]
  const [ruleId, setRuleId] = useState(cash.status === 'APPROVED' ? cash.ruleId : suggested?.id || '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const per = (p) => tx(CASH_PER[p] || 'per month')

  async function decide(decision) {
    setError('')
    try {
      await act('POST', `/api/admin/cardholders/${person.id}/cash`, { decision, ruleId, note })
      setNote('')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Section
      title={tx("Cash budget")}
      hint={tx("Cash is off until you add this cardholder to a cash rule. The rule's limit covers ATM and bank-counter cash, quasi-cash, money transfers and cashback at the till.")}
      actions={<StatusBadge status={cash.status === 'APPROVED' ? 'ACTIVE' : cash.status} />}
    >
      <KeyValues
        rows={[
          [tx("Requested"), cash.requestedCents ? `${eur(cash.requestedCents)} ${per(cash.requestedPeriod)}` : '—'],
          [tx("Reason"), cash.reason || '—'],
          [tx("Cash rule"), cash.status === 'APPROVED' && cash.ruleName ? `${cash.ruleName}: ${eur(cash.limitCents)} ${per(cash.period)}` : '—'],
          [tx("Used this period"), usage ? `${eur(usage.usedCents)} / ${eur(usage.limitCents)}` : '—'],
          [tx("Decided"), cash.decidedAt ? `${formatDateTime(cash.decidedAt)} · ${cash.decidedBy || ''}` : '—'],
        ]}
      />
      {!cashRules.length ? (
        <p className="muted cash-note">
          {tx("Create a cash rule first.")} <Link to="/admin/cardholders">{tx("Cash rules")}</Link>
        </p>
      ) : (
        <div className="toolbar" style={{ marginTop: 14, alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0 }}>
            <span>{tx("Cash rule")}</span>
            <select className="cash-select" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              {cashRules.map((r) => (
                <option key={r.id} value={r.id}>
                  {ruleLabel(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0, flex: '1 1 220px' }}>
            <span>{tx("Note to cardholder")}</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <ActionButton className="btn" disabled={!ruleId || (cash.status === 'APPROVED' && cash.ruleId === ruleId)} onClick={() => decide('APPROVE')}>
            {cash.status === 'APPROVED' ? tx("Move to rule") : tx("Add to cash rule")}
          </ActionButton>
          {cash.status === 'REQUESTED' && <ActionButton onClick={() => decide('REJECT')}>{tx("Reject request")}</ActionButton>}
          {cash.status === 'APPROVED' && (
            <ActionButton className="btn danger" confirmText={tx("Turn cash off for this cardholder? ATM withdrawals, quasi-cash and cashback will decline again.")} onClick={() => decide('REVOKE')}>
              {tx("Turn cash off")}
            </ActionButton>
          )}
        </div>
      )}
      <ErrorText error={error} />
    </Section>
  )
}
