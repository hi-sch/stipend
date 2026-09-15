import { randomUUID } from 'node:crypto'
import { isUuid, qs } from './lithicApi.js'

const CATEGORIES = ['EXTERNAL_WIRE', 'EXTERNAL_ACH', 'EXTERNAL_CHECK', 'EXTERNAL_FEDNOW', 'EXTERNAL_RTP', 'EXTERNAL_TRANSFER']
const DIRECTIONS = ['DEPOSIT', 'WITHDRAWAL']
const PROGRESS = ['SETTLED', 'RELEASED']
const ACTIONS = ['settle', 'release', 'cancel', 'reverse']

/** Lithic holds and external payments on financial accounts (operator ledger tools). */
export function registerLedgerRoutes({ route, lithic, AppError }) {
  const today = () => new Date().toISOString().slice(0, 10)
  function ready() {
    if (!lithic.configured) throw new AppError('LITHIC_API_KEY is not set.', 503)
  }
  function account(value) {
    if (!isUuid(value)) throw new AppError('Choose a financial account.')
    return value
  }
  function cents(value) {
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0) throw new AppError('Amount must be a positive number of cents.')
    return n
  }

  route('GET', '/api/admin/ledger/holds', 'admin', (ctx) => {
    ready()
    return lithic.get(`/v1/financial_accounts/${account(ctx.query.get('financialAccountToken'))}/holds${qs({ page_size: 50 })}`)
  })

  route('POST', '/api/admin/ledger/holds', 'admin', (ctx) => {
    ready()
    const b = ctx.body || {}
    const expires = b.expiresAt ? new Date(b.expiresAt) : null
    if (expires && Number.isNaN(expires.getTime())) throw new AppError('Invalid expiry date.')
    return lithic.post(`/v1/financial_accounts/${account(b.financialAccountToken)}/holds`, {
      token: randomUUID(),
      amount: cents(b.amountCents),
      memo: b.memo ? String(b.memo).slice(0, 512) : undefined,
      user_defined_id: b.reference ? String(b.reference).slice(0, 64) : undefined,
      ...(expires ? { expiration_datetime: expires.toISOString() } : {}),
    })
  })

  route('POST', '/api/admin/ledger/holds/:token/void', 'admin', (ctx) => {
    ready()
    if (!isUuid(ctx.params.token)) throw new AppError('Unknown hold', 404)
    return lithic.post(`/v1/holds/${ctx.params.token}/void`, { memo: ctx.body?.memo ? String(ctx.body.memo).slice(0, 512) : null })
  })

  route('GET', '/api/admin/ledger/external-payments', 'admin', (ctx) => {
    ready()
    const fa = ctx.query.get('financialAccountToken')
    return lithic.get(`/v1/external_payments${qs({ financial_account_token: isUuid(fa) ? fa : undefined, page_size: 50 })}`)
  })

  route('POST', '/api/admin/ledger/external-payments', 'admin', (ctx) => {
    ready()
    const b = ctx.body || {}
    if (!CATEGORIES.includes(b.category)) throw new AppError(`Category must be one of ${CATEGORIES.join(', ')}.`)
    if (!DIRECTIONS.includes(b.paymentType)) throw new AppError('Payment type must be DEPOSIT or WITHDRAWAL.')
    if (b.progressTo && !PROGRESS.includes(b.progressTo)) throw new AppError('progress_to must be SETTLED or RELEASED.')
    return lithic.post('/v1/external_payments', {
      token: randomUUID(),
      financial_account_token: account(b.financialAccountToken),
      amount: cents(b.amountCents),
      category: b.category,
      payment_type: b.paymentType,
      effective_date: /^\d{4}-\d{2}-\d{2}$/.test(b.effectiveDate || '') ? b.effectiveDate : today(),
      memo: b.memo ? String(b.memo).slice(0, 512) : undefined,
      user_defined_id: b.reference ? String(b.reference).slice(0, 64) : undefined,
      ...(b.progressTo ? { progress_to: b.progressTo } : {}),
    })
  })

  route('POST', '/api/admin/ledger/external-payments/:token/:action', 'admin', (ctx) => {
    ready()
    const { token, action } = ctx.params
    if (!isUuid(token)) throw new AppError('Unknown external payment', 404)
    if (!ACTIONS.includes(action)) throw new AppError('Unknown action', 404)
    const b = ctx.body || {}
    return lithic.post(`/v1/external_payments/${token}/${action}`, {
      effective_date: /^\d{4}-\d{2}-\d{2}$/.test(b.effectiveDate || '') ? b.effectiveDate : today(),
      memo: b.memo ? String(b.memo).slice(0, 512) : undefined,
      ...(action === 'settle' && PROGRESS.includes(b.progressTo) ? { progress_to: b.progressTo } : {}),
    })
  })
}

export const LEDGER_OPTIONS = { CATEGORIES, DIRECTIONS, PROGRESS, ACTIONS }
