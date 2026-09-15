import { randomUUID } from 'node:crypto'
import { LithicError, isUuid, qs } from './lithicApi.js'
import { allowlistFor, authorizeAsa, cashPolicyFor, holderById, notify, reconcileTransaction } from './domain.js'
import { CASH_MCC_CODES, QUASI_CASH_MCC_CODES, isCashMcc } from '../src/lib/cash.js'
import { appSettings } from './settings.js'

const MCC_RULE = 'Stipend MCC allowlist'
const VELOCITY_RULE = 'Stipend daily velocity'
const LEGACY_CASH_BLOCK_RULE = 'Stipend cash block'
const LEGACY_CASH_BUDGET_RULE = 'Stipend cash budget'
const CASH_BLOCK_RULE = 'Stipend program cash block'
const CASH_MCC_BLOCK_RULE = 'Stipend program cash category block'
const CASH_RULE_PREFIX = 'Stipend cash rule '
const QUASI_CASH_RULE_PREFIX = 'Stipend quasi-cash rule '
const CASH_PERIOD_WINDOWS = { DAY: { type: 'DAY' }, WEEK: { type: 'WEEK', day_of_week: 1 }, MONTH: { type: 'MONTH', day_of_month: 1 } }
const KYC_ADDRESS = { address1: '123 Main Street', city: 'New York', state: 'NY', postal_code: '10128', country: 'USA' }
const WALLET_SOURCES = { APPLE_PAY: 'APPLE_PAY', GOOGLE_PAY: 'GOOGLE', SAMSUNG_PAY: 'SAMSUNG_PAY' }

export class AppError extends Error {
  constructor(message, status = 400, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

/** Everything that talks to Lithic. Writes to local state always go through db.mutate. */
export function createLithicService({ lithic, db, env = {} }) {
  const settings = () => appSettings(db.read(), env)

  function requireLithic() {
    if (!lithic.configured) throw new AppError('LITHIC_API_KEY is not set. Copy .env.example to .env.', 503)
  }

  function holderOrThrow(holderId) {
    const holder = holderById(db.read(), holderId)
    if (!holder) throw new AppError('Unknown cardholder', 404)
    return holder
  }

  function cardTokenOrThrow(holderId) {
    const holder = holderOrThrow(holderId)
    if (!isUuid(holder.card?.token)) throw new AppError('This cardholder has no Lithic card yet. Issue one first.', 409)
    return holder.card.token
  }

  function patchHolder(holderId, fn) {
    db.mutate((s) => {
      const holder = holderById(s, holderId)
      if (holder) fn(holder, s)
    })
  }

  function setLithicStatus(fields) {
    db.mutate((s) => {
      s.lithic = { ...(s.lithic || {}), ...fields, checkedAt: new Date().toISOString() }
    })
  }

  // ---------- program ----------

  async function status() {
    if (!lithic.configured) {
      setLithicStatus({ status: 'unconfigured', error: 'LITHIC_API_KEY is not set' })
      return db.read().lithic
    }
    try {
      await lithic.get('/v1/status').catch(() => lithic.get('/v1/accounts?page_size=1'))
      const asa = await lithic.get('/v1/responder_endpoints?type=AUTH_STREAM_ACCESS').catch(() => null)
      setLithicStatus({
        status: 'live',
        environment: lithic.environment,
        error: null,
        asaEnrolled: Boolean(asa?.enrolled),
        asaUrl: asa?.url || null,
        asaReachable: Boolean(asa?.enrolled) && isPublicHttps(asa?.url),
      })
    } catch (err) {
      setLithicStatus({ status: 'error', error: err.message })
    }
    return db.read().lithic
  }

  // ---------- cards & account holders ----------

  function cardMemo(holder) {
    return `Stipend · ${holder.firstName} ${holder.lastName} · ${holder.id}`
  }

  async function issueCard(holderId) {
    requireLithic()
    const holder = holderOrThrow(holderId)
    if (isUuid(holder.card?.token)) return holder
    const tos = new Date().toISOString()
    let accountHolderToken = holder.lithicHolder
    let accountToken = holder.lithicAccount
    if (!isUuid(accountHolderToken)) {
      const created = await lithic.post(
        '/v1/account_holders',
        {
          workflow: 'KYC_BYO',
          tos_timestamp: tos,
          kyc_passed_timestamp: tos,
          external_id: holder.id,
          individual: {
            first_name: holder.firstName,
            last_name: holder.lastName,
            dob: holder.dob || '1990-01-15',
            phone_number: toE164(holder.phone),
            email: holder.email,
            government_id: '000-00-0000',
            address: KYC_ADDRESS,
          },
        },
        { idempotencyKey: stableUuid(`holder:${holder.id}`) },
      )
      accountHolderToken = created.token
      accountToken = created.account_token
    }
    const card = await lithic.post(
      '/v1/cards',
      {
        type: 'VIRTUAL',
        account_token: accountToken,
        memo: cardMemo(holder),
        state: 'OPEN',
        spend_limit: settings().cardSpendLimitCents,
        spend_limit_duration: settings().cardSpendLimitDuration,
      },
      { idempotencyKey: stableUuid(`card:${holder.id}:${accountToken}`) },
    )
    patchHolder(holderId, (h) => {
      h.lithicHolder = accountHolderToken
      h.lithicAccount = accountToken
      h.card = { ...h.card, ...publicCard(card) }
    })
    await syncRules(holderId).catch(() => null)
    return holderById(db.read(), holderId)
  }

  async function refreshCard(holderId) {
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.get(`/v1/cards/${token}`)
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, ...publicCard(card) }
    })
    return publicCard(card)
  }

  async function setCardState(holderId, state) {
    if (!['OPEN', 'PAUSED', 'CLOSED'].includes(state)) throw new AppError('Invalid card state')
    const holder = holderOrThrow(holderId)
    if (isUuid(holder.card?.token)) {
      const card = await lithic.patch(`/v1/cards/${holder.card.token}`, { state })
      patchHolder(holderId, (h) => {
        h.card = { ...h.card, ...publicCard(card) }
      })
    } else {
      patchHolder(holderId, (h) => {
        h.card = { ...h.card, state }
      })
    }
    db.mutate((s) =>
      notify(s, { holderId, title: state === 'OPEN' ? 'Card unfrozen' : state === 'PAUSED' ? 'Card frozen' : 'Card closed', kind: 'card' }),
    )
  }

  async function updateSpendLimit(holderId, { spendLimitCents, duration }) {
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.patch(`/v1/cards/${token}`, {
      spend_limit: Math.max(0, Math.round(spendLimitCents)),
      spend_limit_duration: duration || 'MONTHLY',
    })
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, ...publicCard(card) }
    })
  }

  async function spendLimits(holderId) {
    return lithic.get(`/v1/cards/${cardTokenOrThrow(holderId)}/spend_limits`)
  }

  async function embedSession(holderId, { type = 'CARD_EMBED', targetOrigin }) {
    if (!['CARD_EMBED', 'PIN_SETTING_EMBED'].includes(type)) throw new AppError('Invalid embed type')
    const token = cardTokenOrThrow(holderId)
    const session = await lithic.post(`/v1/cards/${token}/embed`, { type, target_origin: targetOrigin })
    return { session: session.session, environment: lithic.environment === 'production' ? 'PRODUCTION' : 'SANDBOX' }
  }

  function shippingFor(holder, address) {
    return {
      first_name: holder.firstName.slice(0, 24),
      last_name: holder.lastName.slice(0, 24),
      ...KYC_ADDRESS,
      ...(address || {}),
    }
  }

  async function resolveProductId() {
    if (settings().cardProductId) return settings().cardProductId
    return '100'
  }

  async function convertPhysical(holderId, { shippingMethod = 'STANDARD', address } = {}) {
    const holder = holderOrThrow(holderId)
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.post(`/v1/cards/${token}/convert_physical`, {
      product_id: await resolveProductId(),
      shipping_method: shippingMethod,
      shipping_address: shippingFor(holder, address),
    })
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, ...publicCard(card) }
      h.physical = { orderedAt: new Date().toISOString(), shippingMethod }
    })
    return publicCard(card)
  }

  async function reissue(holderId, { shippingMethod = 'STANDARD', address } = {}) {
    const holder = holderOrThrow(holderId)
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.post(`/v1/cards/${token}/reissue`, {
      product_id: await resolveProductId(),
      shipping_method: shippingMethod,
      ...(address ? { shipping_address: shippingFor(holder, address) } : {}),
    })
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, ...publicCard(card) }
      h.physical = { ...(h.physical || {}), reissuedAt: new Date().toISOString() }
    })
    return publicCard(card)
  }

  async function renew(holderId, { shippingMethod = 'STANDARD', address, expMonth, expYear } = {}) {
    const holder = holderOrThrow(holderId)
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.post(`/v1/cards/${token}/renew`, {
      shipping_address: shippingFor(holder, address),
      shipping_method: shippingMethod,
      ...(expMonth ? { exp_month: String(expMonth).padStart(2, '0') } : {}),
      ...(expYear ? { exp_year: String(expYear) } : {}),
    })
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, ...publicCard(card) }
      h.physical = { ...(h.physical || {}), renewedAt: new Date().toISOString() }
    })
    return publicCard(card)
  }

  async function accountHolder(holderId) {
    const holder = holderOrThrow(holderId)
    if (!isUuid(holder.lithicHolder)) return null
    const row = await lithic.get(`/v1/account_holders/${holder.lithicHolder}`)
    patchHolder(holderId, (h) => {
      h.kyc = { status: row.status, statusReasons: row.status_reasons || [], checkedAt: new Date().toISOString() }
    })
    return {
      token: row.token,
      status: row.status,
      statusReasons: row.status_reasons || [],
      email: row.individual?.email || row.email,
      phone: row.individual?.phone_number || row.phone_number,
      created: row.created,
    }
  }

  async function updateAccountHolder(holderId, fields) {
    const holder = holderOrThrow(holderId)
    const local = {}
    for (const key of ['firstName', 'lastName', 'email', 'phone', 'city', 'beneficiaryRef']) {
      if (typeof fields[key] === 'string' && fields[key].trim()) local[key] = fields[key].trim()
    }
    if (local.beneficiaryRef) {
      const clash = (db.read().cardholders || []).find((c) => c.id !== holderId && c.beneficiaryRef === local.beneficiaryRef)
      if (clash) throw new AppError('Another cardholder already uses this beneficiary reference.', 409)
    }
    if (isUuid(holder.lithicHolder) && lithic.configured) {
      const body = {}
      if (local.email) body.email = local.email
      if (local.phone) body.phone_number = toE164(local.phone)
      if (local.firstName) body.first_name = local.firstName
      if (local.lastName) body.last_name = local.lastName
      if (Object.keys(body).length) await lithic.patch(`/v1/account_holders/${holder.lithicHolder}`, body)
    }
    patchHolder(holderId, (h, s) => {
      Object.assign(h, local)
      const user = (s.users || []).find((u) => u.cardholderId === holderId)
      if (user && local.email) user.email = local.email
    })
  }

  // ---------- auth rules ----------

  async function listRules(cardToken) {
    requireLithic()
    const data = await lithic.get(`/v2/auth_rules${qs({ page_size: 100, card_token: cardToken })}`)
    return (data.data || []).filter((r) => !cardToken || (r.card_tokens || []).includes(cardToken) || r.program_level)
  }

  async function syncRules(holderId) {
    const holder = holderOrThrow(holderId)
    if (!lithic.configured || !isUuid(holder.card?.token)) return null
    const state = db.read()
    const lists = allowlistFor(state, holderId)
    const rules = await listRules(holder.card.token)
    const mine = rules.filter((r) => (r.card_tokens || []).includes(holder.card.token))
    const cashApproved = Boolean(cashPolicyFor(state, holderId))
    const allowedMccs = cashApproved ? [...new Set([...lists.mccs, ...CASH_MCC_CODES])].sort() : lists.mccs
    const mccRuleToken =
      lists.mccs.length && !lists.unrestricted
        ? await upsertRule(mine, holder.card.token, MCC_RULE, 'CONDITIONAL_ACTION', {
            action: 'DECLINE',
            conditions: [{ attribute: 'MCC', operation: 'IS_NOT_ONE_OF', value: allowedMccs }],
          })
        : await deactivate(mine, MCC_RULE)
    // Card-level cash rules from an earlier version; cash is now governed by program and account rules.
    await deactivate(mine, LEGACY_CASH_BLOCK_RULE)
    // A reissued card of someone with cash must be excluded from the program-wide cash block again.
    const cashRules = db.read().lithic?.cashRules
    if (cashApproved && !(cashRules?.excludedCardTokens || []).includes(holder.card.token)) scheduleCashSync()
    const funded = new Set(state.envelopes.filter((e) => e.cardholderId === holderId && e.balanceCents > 0).map((e) => e.connectionId))
    const dailyCap = state.connections.filter((c) => funded.has(c.id)).reduce((sum, c) => sum + (c.dailyLimitCents || settings().defaultDailyLimitCents), 0)
    const velocityRuleToken = dailyCap
      ? await upsertRule(mine, holder.card.token, VELOCITY_RULE, 'VELOCITY_LIMIT', {
          scope: 'CARD',
          period: { type: 'DAY' },
          limit_amount: dailyCap,
          limit_count: null,
        }).catch(() => null)
      : await deactivate(mine, VELOCITY_RULE)
    patchHolder(holderId, (h) => {
      h.card = { ...h.card, mccRuleToken, velocityRuleToken, rulesSyncedAt: new Date().toISOString() }
    })
    return { mccRuleToken, velocityRuleToken }
  }

  function upsertRule(existing, cardToken, name, type, parameters) {
    return upsertScopedRule(existing, name, type, parameters, { card_tokens: [cardToken] })
  }

  /** Create or update a rule so its parameters, associations (cards, accounts or program) and ACTIVE state match. */
  async function upsertScopedRule(existing, name, type, parameters, scope) {
    const named = existing.filter((r) => r.name === name)
    const found = named.find((r) => r.state === 'ACTIVE') || named[0]
    if (!found) {
      const created = await lithic.post('/v2/auth_rules', { name, type, ...scope, event_stream: 'AUTHORIZATION', parameters })
      await lithic.post(`/v2/auth_rules/${created.token}/promote`)
      return created.token
    }
    const scopeChanged = Object.entries(scope).some(([key, value]) =>
      Array.isArray(value) ? [...(found[key] || [])].sort().join() !== [...value].sort().join() : found[key] !== value,
    )
    if (scopeChanged) await lithic.patch(`/v2/auth_rules/${found.token}`, scope)
    // Lithic re-activates a rule only by promoting a draft.
    if (found.state !== 'ACTIVE' || !sameParameters(found.current_version?.parameters, parameters)) {
      await lithic.post(`/v2/auth_rules/${found.token}/draft`, { parameters })
      await lithic.post(`/v2/auth_rules/${found.token}/promote`)
    }
    return found.token
  }

  async function listAllRules(query) {
    const rules = []
    let startingAfter
    for (let page = 0; page < 20; page++) {
      const data = await lithic.get(`/v2/auth_rules${qs({ page_size: 100, ...query, starting_after: startingAfter })}`)
      rules.push(...(data.data || []))
      if (!data.has_more || !data.data?.length) break
      startingAfter = data.data[data.data.length - 1].token
    }
    return rules
  }

  /**
   * Cash is blocked program-wide: one rule declines any cash part (ATM, cashback, cash disbursement),
   * one declines cash and quasi-cash merchant categories. Cardholders in a cash rule are excluded from
   * both, and each cash rule becomes account-level velocity limits shared by its members' accounts.
   */
  async function syncCashRules() {
    requireLithic()
    const state = db.read()
    const members = (state.cardholders || []).filter((h) => cashPolicyFor(state, h.id))
    const excludedCardTokens = [...new Set(members.map((h) => h.card?.token).filter(isUuid))].sort()
    const programRules = await listAllRules({ scope: 'PROGRAM' })
    const programScope = { program_level: true, excluded_card_tokens: excludedCardTokens }
    const blockCashAmount = await upsertScopedRule(programRules, CASH_BLOCK_RULE, 'CONDITIONAL_ACTION', {
      action: 'DECLINE',
      conditions: [{ attribute: 'CASH_AMOUNT', operation: 'IS_GREATER_THAN', value: 0 }],
    }, programScope)
    const blockCashMccs = await upsertScopedRule(programRules, CASH_MCC_BLOCK_RULE, 'CONDITIONAL_ACTION', {
      action: 'DECLINE',
      conditions: [{ attribute: 'MCC', operation: 'IS_ONE_OF', value: CASH_MCC_CODES }],
    }, programScope)

    const accountRules = await listAllRules({ scope: 'ACCOUNT' })
    const tokens = {}
    const wanted = new Set()
    for (const rule of state.cashRules || []) {
      const accounts = [...new Set(members.filter((h) => h.cash.ruleId === rule.id).map((h) => h.lithicAccount).filter(isUuid))]
      const cashName = `${CASH_RULE_PREFIX}${rule.id}`
      const quasiName = `${QUASI_CASH_RULE_PREFIX}${rule.id}`
      if (!accounts.length) continue
      wanted.add(cashName)
      wanted.add(quasiName)
      const period = CASH_PERIOD_WINDOWS[rule.period] || CASH_PERIOD_WINDOWS.MONTH
      tokens[rule.id] = {
        // ATM withdrawals, cash disbursements and cashback, as reported in cash_amount.
        cash: await upsertScopedRule(accountRules, cashName, 'VELOCITY_LIMIT', {
          scope: 'ACCOUNT',
          period,
          limit_amount: null,
          limit_count: null,
          limit_cash_amount: rule.limitCents,
        }, { account_tokens: accounts }),
        // Quasi-cash and money transfers carry no cash_amount; cap them by category.
        quasiCash: await upsertScopedRule(accountRules, quasiName, 'VELOCITY_LIMIT', {
          scope: 'ACCOUNT',
          period,
          filters: { include_mccs: QUASI_CASH_MCC_CODES },
          limit_amount: rule.limitCents,
          limit_count: null,
        }, { account_tokens: accounts }),
      }
    }
    for (const rule of accountRules) {
      const ours = rule.name === LEGACY_CASH_BUDGET_RULE || rule.name?.startsWith(CASH_RULE_PREFIX) || rule.name?.startsWith(QUASI_CASH_RULE_PREFIX)
      if (ours && !wanted.has(rule.name) && rule.state === 'ACTIVE') await lithic.patch(`/v2/auth_rules/${rule.token}`, { state: 'INACTIVE' }).catch(() => null)
    }
    const result = { blockCashAmount, blockCashMccs, excludedCardTokens, perRule: tokens, syncedAt: new Date().toISOString() }
    db.mutate((s) => {
      s.lithic = { ...(s.lithic || {}), cashRules: result }
    })
    return result
  }

  // Cash decisions often come in bursts (bulk assignment); run one sync at a time and once more if asked meanwhile.
  let cashSync = null
  let cashSyncAgain = false
  function scheduleCashSync() {
    if (!lithic.configured) return Promise.resolve(null)
    if (cashSync) {
      cashSyncAgain = true
      return cashSync
    }
    cashSync = syncCashRules()
      .catch((err) => {
        db.mutate((s) => {
          s.lithic = { ...(s.lithic || {}), cashRules: { ...(s.lithic?.cashRules || {}), error: err.message, failedAt: new Date().toISOString() } }
        })
        return null
      })
      .finally(() => {
        cashSync = null
        if (cashSyncAgain) {
          cashSyncAgain = false
          scheduleCashSync()
        }
      })
    return cashSync
  }

  async function deactivate(existing, name) {
    for (const rule of existing.filter((r) => r.name === name && r.state === 'ACTIVE')) {
      await lithic.patch(`/v2/auth_rules/${rule.token}`, { state: 'INACTIVE' }).catch(() => null)
    }
    return null
  }

  const ruleResults = (ruleToken, { begin, end, eventToken } = {}) =>
    lithic.get(`/v2/auth_rules/results${qs({ auth_rule_token: ruleToken, event_token: eventToken, begin, end, page_size: 50 })}`)
  const ruleReport = (ruleToken, begin, end) => lithic.get(`/v2/auth_rules/${ruleToken}/report${qs({ begin, end })}`)
  const requestBacktest = (ruleToken, start, end) => lithic.post(`/v2/auth_rules/${ruleToken}/backtests`, { start, end })
  const getBacktest = (ruleToken, backtestToken) => lithic.get(`/v2/auth_rules/${ruleToken}/backtests/${backtestToken}`)
  const setRuleState = (ruleToken, state) => lithic.patch(`/v2/auth_rules/${ruleToken}`, { state })

  async function transactionRuleResults(txnId) {
    const txn = (db.read().transactions || []).find((t) => t.id === txnId)
    if (!txn?.live) return []
    const tokens = (txn.events || []).map((e) => e.token).filter(isUuid)
    const results = []
    for (const token of tokens) {
      const data = await ruleResults(undefined, { eventToken: token }).catch(() => ({ data: [] }))
      results.push(...(data.data || []))
    }
    return results
  }

  // ---------- transactions ----------

  async function fetchTxn(token) {
    for (let i = 0; i < 6; i++) {
      try {
        return await lithic.get(`/v1/transactions/${token}`)
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    return null
  }

  function reconcile(txn, source) {
    return db.mutate((s) => reconcileTransaction(s, txn, { source }))
  }

  async function syncTransactions(holderId) {
    requireLithic()
    const holders = holderId ? [holderOrThrow(holderId)] : db.read().cardholders.filter((c) => isUuid(c.card?.token))
    let count = 0
    for (const holder of holders) {
      if (!isUuid(holder.card?.token)) continue
      const data = await lithic.get(`/v1/transactions${qs({ card_token: holder.card.token, page_size: 100 })}`)
      for (const txn of data.data || []) {
        reconcile(txn, 'sync')
        count++
      }
      await refreshCard(holder.id).catch(() => null)
    }
    setLithicStatus({ lastSyncAt: new Date().toISOString() })
    return { count }
  }

  /**
   * Sandbox purchase. When Lithic cannot reach our ASA responder, Stipend runs the same engine
   * right after Lithic approves and reverses the authorization if no envelope can pay.
   */
  async function simulatePurchase(holderId, { amountCents, mcc, merchant, city, country, partialApprovalCapable, cashCents = 0, clear = true }) {
    const holder = holderOrThrow(holderId)
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError('Amount must be a positive number of cents.')
    const cash = Number.isInteger(cashCents) && cashCents > 0 ? Math.min(cashCents, amountCents) : 0
    const descriptor = String(merchant || `MCC ${mcc} merchant`).slice(0, 25)
    const merchantCountry = country || 'DEU'
    // Lithic's simulate API cannot send a cashback amount, so cashback purchases are decided by Stipend alone.
    const cashbackOnly = cash > 0 && !isCashMcc(mcc)

    if (!lithic.configured || !isUuid(holder.card?.token) || cashbackOnly) {
      const token = `local_${randomUUID()}`
      db.mutate((s) =>
        authorizeAsa(
          s,
          {
            token,
            amount: amountCents,
            card: { token: holder.card?.token || `local-${holder.id}` },
            merchant: { descriptor, mcc, country: merchantCountry, city },
            cash_amount: cash,
            pos: { terminal: { partial_approval_capable: Boolean(partialApprovalCapable) } },
          },
          { source: 'local' },
        ),
      )
      if (!isUuid(holder.card?.token) || cashbackOnly) {
        db.mutate((s) => {
          const t = s.transactions.find((x) => x.id === token)
          if (t) {
            t.cardholderId = holder.id
            t.live = false
            if (cashbackOnly && lithic.configured) t.note = t.note || 'Cashback simulated by Stipend only (Lithic cannot simulate cashback).'
          }
        })
      }
      return db.read().transactions.find((t) => t.id === token)
    }

    const card = await lithic.get(`/v1/cards/${holder.card.token}`)
    if (!card.pan) throw new AppError('Lithic did not return a PAN for this card (sandbox only).', 409)
    const sim = await lithic.post('/v1/simulate/authorize', {
      pan: card.pan,
      amount: amountCents,
      descriptor,
      mcc,
      merchant_acceptor_city: String(city || 'BERLIN').slice(0, 13).toUpperCase(),
      merchant_acceptor_country: merchantCountry,
      partial_approval_capable: Boolean(partialApprovalCapable),
    })
    if (!sim.token) throw new AppError(sim.message || 'Lithic did not create an authorization', 502)
    let txn = await fetchTxn(sim.token)
    if (!txn) throw new AppError('Authorization created but not yet visible; sync again in a moment.', 202)
    const program = db.read().lithic || {}
    if (!program.asaEnrolled && txn.result === 'APPROVED') {
      const response = db.mutate((s) =>
        authorizeAsa(
          s,
          {
            token: sim.token,
            amount: amountCents,
            card: { token: holder.card.token },
            merchant: { descriptor, mcc, country: merchantCountry, city },
            pos: { terminal: { partial_approval_capable: Boolean(partialApprovalCapable) } },
          },
          { source: 'simulate' },
        ),
      )
      if (response.result !== 'APPROVED') {
        await lithic.post('/v1/simulate/void', { token: sim.token, amount: amountCents, type: 'AUTHORIZATION_REVERSAL' }).catch(() => null)
        txn = (await fetchTxn(sim.token)) || txn
        const reconciled = reconcile({ ...txn, status: 'DECLINED', result: 'DECLINED' }, 'simulate')
        db.mutate((s) => {
          const t = s.transactions.find((x) => x.id === sim.token)
          if (t) t.note = `Reversed by Stipend: ${t.note || response.result}`
        })
        return reconciled
      }
      if (response.approved_amount && response.approved_amount < amountCents) {
        await lithic.post('/v1/simulate/void', { token: sim.token, amount: amountCents - response.approved_amount }).catch(() => null)
      }
    }
    if (program.asaEnrolled && !program.asaReachable && txn.result !== 'APPROVED') {
      const reconciled = reconcile(txn, 'simulate')
      db.mutate((s) => {
        const t = s.transactions.find((x) => x.id === sim.token)
        if (t && !t.note) t.note = `Lithic declined; the enrolled ASA responder (${program.asaUrl}) is not reachable from Lithic.`
      })
      return reconciled
    }
    if (clear && txn.result === 'APPROVED') {
      const approved = db.read().transactions.find((t) => t.id === sim.token)?.amountCents || amountCents
      await lithic.post('/v1/simulate/clearing', { token: sim.token, amount: approved }).catch(() => null)
      txn = (await fetchTxn(sim.token)) || txn
    }
    return reconcile(txn, 'simulate')
  }

  async function simulateAction(txnId, { action, amountCents }) {
    requireLithic()
    const local = (db.read().transactions || []).find((t) => t.id === txnId)
    if (!local || !isUuid(txnId)) throw new AppError('Only Lithic transactions can be simulated on.', 404)
    const amount = Number.isInteger(amountCents) && amountCents > 0 ? amountCents : local.amountCents
    let token = txnId
    switch (action) {
      case 'clearing':
        await lithic.post('/v1/simulate/clearing', { token: txnId, amount })
        break
      case 'void':
        await lithic.post('/v1/simulate/void', { token: txnId, amount, type: 'AUTHORIZATION_REVERSAL' })
        break
      case 'expire':
        await lithic.post(`/v1/transactions/${txnId}/expire_authorization`)
        break
      case 'return': {
        const holder = holderOrThrow(local.cardholderId)
        const card = await lithic.get(`/v1/cards/${holder.card.token}`)
        const res = await lithic.post('/v1/simulate/return', { pan: card.pan, amount, descriptor: String(local.merchant?.descriptor || 'REFUND').slice(0, 25) })
        token = res.token
        break
      }
      case 'return_reversal':
        await lithic.post('/v1/simulate/return_reversal', { token: txnId })
        break
      case 'authorization_advice':
        await lithic.post('/v1/simulate/authorization_advice', { token: txnId, amount })
        break
      default:
        throw new AppError('Unknown simulation')
    }
    const txn = await fetchTxn(token)
    if (!txn) return null
    const reconciled = reconcile(txn, 'simulate')
    if (action === 'return' && reconciled && local.envelopeId) {
      db.mutate((s) => {
        const t = s.transactions.find((x) => x.id === token)
        if (t && t.envelopeId !== local.envelopeId && !t.debitedCents) t.envelopeId = local.envelopeId
      })
    }
    return reconciled
  }

  async function enhancedData(txnId) {
    return lithic.get(`/v1/transactions/${txnId}/enhanced_commercial_data`)
  }

  // ---------- 3DS ----------

  async function simulate3ds(holderId, { amountCents, merchant, mcc, country }) {
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.get(`/v1/cards/${token}`)
    const res = await lithic.post('/v1/three_ds_authentication/simulate', {
      pan: card.pan,
      merchant: {
        country: country || 'DEU',
        id: 'STIPENDDEMO01',
        mcc: mcc || '5411',
        name: String(merchant || 'ONLINE SHOP').slice(0, 25),
      },
      transaction: { amount: amountCents || 100, currency: 'EUR' },
    })
    const detail = res.token ? await lithic.get(`/v1/three_ds_authentication/${res.token}`).catch(() => null) : null
    return { token: res.token, authentication: detail }
  }

  async function enterOtp(token, otp) {
    await lithic.post('/v1/three_ds_decisioning/simulate/enter_otp', { token, otp })
    return lithic.get(`/v1/three_ds_authentication/${token}`)
  }

  // ---------- wallets & tokenizations ----------

  async function tokenizations(holderId) {
    const token = cardTokenOrThrow(holderId)
    const data = await lithic.get(`/v1/tokenizations${qs({ card_token: token, page_size: 50 })}`)
    return (data.data || []).map((t) => ({
      token: t.token,
      status: t.status,
      requestor: t.token_requestor_name,
      channel: t.tokenization_channel,
      created: t.created_at,
      updated: t.updated_at,
    }))
  }

  async function tokenizationAction(holderId, tokenizationToken, action) {
    if (!['pause', 'unpause', 'deactivate', 'activate', 'resend_activation_code'].includes(action)) throw new AppError('Unknown action')
    const cardToken = cardTokenOrThrow(holderId)
    const row = await lithic.get(`/v1/tokenizations/${tokenizationToken}`)
    if (row.card_token !== cardToken) throw new AppError('Token does not belong to this card', 403)
    await lithic.post(`/v1/tokenizations/${tokenizationToken}/${action}`)
    return tokenizations(holderId)
  }

  async function simulateTokenization(holderId, wallet) {
    const token = cardTokenOrThrow(holderId)
    const card = await lithic.get(`/v1/cards/${token}`)
    const exp = `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`
    const res = await lithic.post('/v1/simulate/tokenizations', {
      pan: card.pan,
      cvv: card.cvv,
      expiration_date: exp,
      tokenization_source: WALLET_SOURCES[wallet] || 'MERCHANT',
    })
    db.mutate((s) => notify(s, { holderId, title: 'Card added to a wallet (sandbox)', body: `${wallet} · ${res.status || 'created'}`, kind: 'wallet' }))
    return res
  }

  /**
   * Web push needs the BIN enabled for digital wallet provisioning by Lithic. Probe once a day:
   * a 404 from web_provision means the program cannot offer Add to Apple/Google Wallet.
   */
  async function webPushAvailability(holderId) {
    const cached = db.read().lithic?.webPush
    if (cached && Date.now() - Date.parse(cached.checkedAt) < 86400000) return cached.status
    const token = cardTokenOrThrow(holderId)
    let status = 'unknown'
    try {
      await lithic.post(`/v1/cards/${token}/web_provision`, { digital_wallet: 'APPLE_PAY' })
      status = 'available'
    } catch (err) {
      if (err.status === 404) status = 'unavailable'
    }
    db.mutate((s) => {
      s.lithic = { ...(s.lithic || {}), webPush: { status, checkedAt: new Date().toISOString() } }
    })
    return status
  }

  async function webProvision(holderId, body) {
    const token = cardTokenOrThrow(holderId)
    const wallet = body.digitalWallet === 'GOOGLE_PAY' ? 'GOOGLE_PAY' : 'APPLE_PAY'
    const req = { digital_wallet: wallet }
    if (wallet === 'GOOGLE_PAY') {
      if (body.serverSessionId) req.server_session_id = body.serverSessionId
      if (body.clientDeviceId) req.client_device_id = body.clientDeviceId
      if (body.clientWalletAccountId) req.client_wallet_account_id = body.clientWalletAccountId
    }
    try {
      return await lithic.post(`/v1/cards/${token}/web_provision`, req)
    } catch (err) {
      if (err.status === 404) {
        throw new AppError('Lithic web push provisioning is not enabled for this program. Use the sandbox tokenization instead.', 409)
      }
      throw err
    }
  }

  // ---------- disputes ----------

  async function fileDispute(holderId, { transactionId, reason, note }) {
    const txn = (db.read().transactions || []).find((t) => t.id === transactionId && t.cardholderId === holderId)
    if (!txn) throw new AppError('Unknown transaction', 404)
    if (txn.status !== 'SETTLED') throw new AppError('Only settled purchases can be disputed.')
    if ((db.read().disputes || []).some((d) => d.transactionId === transactionId && !['WITHDRAWN', 'CASE_CLOSED'].includes(d.status))) {
      throw new AppError('This purchase already has an open dispute.', 409)
    }
    let remote = null
    if (lithic.configured && isUuid(transactionId)) {
      remote = await lithic.post('/v1/disputes', {
        transaction_token: transactionId,
        amount: txn.amountCents,
        reason,
        customer_note: String(note || '').slice(0, 5000) || undefined,
        customer_filed_date: new Date().toISOString(),
      })
    }
    return db.mutate((s) => {
      const row = {
        id: remote?.token || `dsp_${randomUUID().slice(0, 8)}`,
        lithicToken: remote?.token || null,
        cardholderId: holderId,
        transactionId,
        merchant: txn.merchant,
        amountCents: txn.amountCents,
        reason,
        note: note || '',
        status: remote?.status || 'LOCAL',
        resolutionReason: remote?.resolution_reason || null,
        evidence: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      }
      s.disputes = [row, ...(s.disputes || [])]
      notify(s, { holderId, title: 'Dispute filed', body: `${txn.merchant?.descriptor} · ${reason}`, kind: 'dispute' })
      return row
    })
  }

  function disputeOrThrow(disputeId, holderId) {
    const row = (db.read().disputes || []).find((d) => d.id === disputeId)
    if (!row || (holderId && row.cardholderId !== holderId)) throw new AppError('Unknown dispute', 404)
    return row
  }

  function applyRemoteDispute(remote) {
    db.mutate((s) => {
      const row = (s.disputes || []).find((d) => d.lithicToken === remote.token)
      if (!row) return
      const changed = row.status !== remote.status
      row.status = remote.status
      row.resolutionReason = remote.resolution_reason || null
      row.updated = new Date().toISOString()
      if (changed) notify(s, { holderId: row.cardholderId, title: `Dispute ${String(remote.status).toLowerCase().replaceAll('_', ' ')}`, body: row.merchant?.descriptor, kind: 'dispute' })
    })
  }

  async function refreshDispute(disputeId, holderId) {
    const row = disputeOrThrow(disputeId, holderId)
    if (!row.lithicToken) return row
    const remote = await lithic.get(`/v1/disputes/${row.lithicToken}`)
    applyRemoteDispute(remote)
    const evidence = await lithic.get(`/v1/disputes/${row.lithicToken}/evidences?page_size=50`).catch(() => ({ data: [] }))
    db.mutate((s) => {
      const d = s.disputes.find((x) => x.id === disputeId)
      if (d) d.evidence = (evidence.data || []).map((e) => ({ token: e.token, filename: e.filename, status: e.upload_status, created: e.created }))
    })
    return disputeOrThrow(disputeId)
  }

  async function withdrawDispute(disputeId, holderId) {
    const row = disputeOrThrow(disputeId, holderId)
    if (row.lithicToken) await lithic.del(`/v1/disputes/${row.lithicToken}`)
    db.mutate((s) => {
      const d = s.disputes.find((x) => x.id === disputeId)
      if (d) {
        d.status = 'WITHDRAWN'
        d.updated = new Date().toISOString()
      }
    })
  }

  async function uploadEvidence(disputeId, holderId, { filename, contentType, base64 }) {
    const row = disputeOrThrow(disputeId, holderId)
    if (!row.lithicToken) throw new AppError('Evidence can only be attached to disputes filed with Lithic.', 409)
    if (!/\.(pdf|png|jpe?g)$/i.test(filename || '')) throw new AppError('Evidence must be a PDF, PNG or JPG file.')
    const bytes = Buffer.from(String(base64 || ''), 'base64')
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new AppError('Evidence file must be between 1 byte and 8 MB.')
    const evidence = await lithic.post(`/v1/disputes/${row.lithicToken}/evidences`, { filename })
    const put = await fetch(evidence.upload_url, { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType || 'application/octet-stream' } })
    if (!put.ok) throw new AppError(`Evidence upload failed (${put.status})`, 502)
    return refreshDispute(disputeId, holderId)
  }

  async function deleteEvidence(disputeId, holderId, evidenceToken) {
    const row = disputeOrThrow(disputeId, holderId)
    await lithic.del(`/v1/disputes/${row.lithicToken}/evidences/${evidenceToken}`)
    return refreshDispute(disputeId, holderId)
  }

  async function managedDisputes(holderId) {
    const token = holderId ? cardTokenOrThrow(holderId) : undefined
    return lithic.get(`/v2/disputes${qs({ card_token: token, page_size: 50 })}`)
  }

  // ---------- money movement ----------

  async function financialAccounts() {
    requireLithic()
    const data = await lithic.get('/v1/financial_accounts?page_size=100')
    return data.data || []
  }

  async function programAccount() {
    const accounts = await financialAccounts()
    return accounts.find((a) => a.type === 'ISSUING' && !a.account_token) || accounts.find((a) => a.type === 'OPERATING') || null
  }

  async function disburse({ amountCents, memo, accountToken, externalId }) {
    if (!lithic.configured) return { attempted: false, posted: false, reason: 'Lithic not configured' }
    try {
      const accounts = await financialAccounts()
      const program = accounts.find((a) => a.type === 'ISSUING' && !a.account_token)
      const dest = accounts.find((a) => a.type === 'ISSUING' && a.account_token === accountToken)
      if (!program || !dest) return { attempted: true, posted: false, error: 'No program and cardholder ISSUING accounts to move funds between' }
      const res = await lithic.post('/v1/book_transfers', {
        from_financial_account_token: program.token,
        to_financial_account_token: dest.token,
        category: 'BALANCE_OR_FUNDING',
        type: 'DISBURSE',
        subtype: 'STIPEND_ENVELOPE',
        amount: amountCents,
        memo: String(memo || 'Stipend envelope credit').slice(0, 512),
        ...(externalId ? { external_id: String(externalId) } : {}),
      })
      return { attempted: true, posted: true, token: res.token, status: res.status }
    } catch (err) {
      return { attempted: true, posted: false, error: err.message }
    }
  }

  async function reverseTransfer(transferToken, memo) {
    if (!lithic.configured || !isUuid(transferToken)) return null
    return lithic.post(`/v1/book_transfers/${transferToken}/reverse`, { memo: String(memo || 'Stipend recall').slice(0, 512) }).catch((err) => ({ error: err.message }))
  }

  async function fundProgram({ amountCents, financialAccountToken, memo }) {
    requireLithic()
    const account = financialAccountToken ? { token: financialAccountToken } : await programAccount()
    if (!account) throw new AppError('No program financial account found', 404)
    return lithic.post('/v1/simulate/payments/receipt', {
      financial_account_token: account.token,
      token: randomUUID(),
      receipt_type: 'RECEIPT_CREDIT',
      amount: amountCents,
      memo: memo || 'Stipend program funding (sandbox ACH receipt)',
    })
  }

  const balances = (financialAccountToken) => lithic.get(`/v1/balances${qs({ financial_account_token: financialAccountToken })}`)
  const accountActivity = (params) => lithic.get(`/v1/account_activity${qs({ page_size: 50, ...params })}`)
  const bookTransfers = () => lithic.get('/v1/book_transfers?page_size=50')
  const settlementSummary = (date) => lithic.get(`/v1/reports/settlement/summary/${date}`)

  // ---------- ASA & events administration ----------

  async function responder(type = 'AUTH_STREAM_ACCESS') {
    return lithic.get(`/v1/responder_endpoints${qs({ type })}`)
  }

  async function enrollResponder(type, url) {
    if (!/^https:\/\//.test(url || '')) throw new AppError('Lithic needs a public HTTPS URL (use a tunnel in development).')
    await lithic.post('/v1/responder_endpoints', { type, url })
    if (type === 'AUTH_STREAM_ACCESS') await syncAsaSecret()
    return status()
  }

  async function disenrollResponder(type) {
    await lithic.del(`/v1/responder_endpoints${qs({ type })}`)
    return status()
  }

  async function syncAsaSecret(rotate = false) {
    if (rotate) await lithic.post('/v1/auth_stream/secret/rotate')
    const { secret } = await lithic.get('/v1/auth_stream/secret')
    db.mutate((s) => {
      s.settings = { ...(s.settings || {}), asaSecret: secret }
    })
    return { configured: true, preview: preview(secret) }
  }

  async function subscriptions() {
    const data = await lithic.get('/v1/event_subscriptions?page_size=100')
    const secrets = db.read().settings?.webhookSecrets || {}
    return (data.data || []).map((sub) => ({ ...sub, secretStored: Boolean(secrets[sub.token]) }))
  }

  async function syncSubscriptionSecret(token, rotate = false) {
    if (rotate) await lithic.post(`/v1/event_subscriptions/${token}/secret/rotate`)
    const { secret } = await lithic.get(`/v1/event_subscriptions/${token}/secret`)
    db.mutate((s) => {
      s.settings = { ...(s.settings || {}), webhookSecrets: { ...(s.settings?.webhookSecrets || {}), [token]: secret } }
    })
    return { preview: preview(secret) }
  }

  async function createSubscription({ url, eventTypes, description }) {
    if (!/^https:\/\//.test(url || '')) throw new AppError('Lithic needs a public HTTPS URL (use a tunnel in development).')
    const sub = await lithic.post('/v1/event_subscriptions', {
      url,
      description: description || 'Stipend',
      event_types: eventTypes?.length ? eventTypes : undefined,
    })
    await syncSubscriptionSecret(sub.token)
    return sub
  }

  async function deleteSubscription(token) {
    await lithic.del(`/v1/event_subscriptions/${token}`)
    db.mutate((s) => {
      const next = { ...(s.settings?.webhookSecrets || {}) }
      delete next[token]
      s.settings = { ...(s.settings || {}), webhookSecrets: next }
    })
  }

  const recoverSubscription = (token, begin) => lithic.post(`/v1/event_subscriptions/${token}/recover${qs({ begin })}`, {})
  const replayMissing = (token, begin) => lithic.post(`/v1/event_subscriptions/${token}/replay_missing${qs({ begin })}`)
  const sendExample = (token, eventType) => lithic.post(`/v1/simulate/event_subscriptions/${token}/send_example`, { event_type: eventType })
  const subscriptionAttempts = (token) => lithic.get(`/v1/event_subscriptions/${token}/attempts?page_size=50`)
  const listEvents = (params) => lithic.get(`/v1/events${qs({ page_size: 50, ...params })}`)

  /** Apply an Events API message. Unknown events are only logged. */
  async function handleEvent(event) {
    const type = event.event_type
    const payload = event.payload || event
    switch (type) {
      case 'card_transaction.updated':
        if (payload.token) reconcile(payload, 'webhook')
        break
      case 'dispute.updated':
        if (payload.token) applyRemoteDispute(payload)
        break
      case 'card.updated':
      case 'card.converted':
      case 'card.shipped':
      case 'card.renewed':
      case 'card.reissued': {
        const holder = db.read().cardholders.find((c) => c.card?.token === (payload.card_token || payload.token))
        if (holder) {
          await refreshCard(holder.id).catch(() => null)
          if (type === 'card.shipped') {
            db.mutate((s) => notify(s, { holderId: holder.id, title: 'Your card has shipped', body: payload.tracking_number ? `Tracking ${payload.tracking_number}` : '', kind: 'card' }))
          }
        }
        break
      }
      case 'account_holder.updated':
      case 'account_holder.verification': {
        const holder = db.read().cardholders.find((c) => c.lithicHolder === (payload.token || payload.account_holder_token))
        if (holder) await accountHolder(holder.id).catch(() => null)
        break
      }
      case 'tokenization.result':
      case 'tokenization.updated':
      case 'digital_wallet.tokenization_result':
      case 'digital_wallet.tokenization_updated': {
        const holder = db.read().cardholders.find((c) => c.card?.token === payload.card_token)
        if (holder) db.mutate((s) => notify(s, { holderId: holder.id, title: 'Wallet token updated', body: payload.status || payload.tokenization_result_details?.issuer_decision || '', kind: 'wallet' }))
        break
      }
      case 'three_ds_authentication.created':
      case 'three_ds_authentication.challenge': {
        const holder = db.read().cardholders.find((c) => c.card?.token === payload.card_token)
        if (holder) db.mutate((s) => notify(s, { holderId: holder.id, title: 'Online purchase verification', body: payload.merchant?.name || '', kind: '3ds' }))
        break
      }
      case 'book_transfer_transaction.updated':
        db.mutate((s) => {
          for (const credit of s.credits || []) {
            if (credit.lithicTransfer?.token === payload.token) credit.lithicTransfer = { ...credit.lithicTransfer, status: payload.status }
          }
        })
        break
      case 'balance.updated':
        db.mutate((s) => {
          s.lithic = { ...(s.lithic || {}), lastBalance: payload }
        })
        break
      default:
        break
    }
  }

  // ---------- monitoring ----------

  async function monitoringCases() {
    try {
      const data = await lithic.get('/v1/transaction_monitoring/cases?page_size=50')
      return { available: true, data: data.data || [] }
    } catch (err) {
      return { available: false, error: err.message, data: [] }
    }
  }

  const updateMonitoringCase = (token, body) => lithic.patch(`/v1/transaction_monitoring/cases/${token}`, body)

  return {
    status,
    issueCard,
    refreshCard,
    setCardState,
    updateSpendLimit,
    spendLimits,
    embedSession,
    convertPhysical,
    reissue,
    renew,
    accountHolder,
    updateAccountHolder,
    listRules,
    syncRules,
    syncCashRules,
    scheduleCashSync,
    ruleResults,
    ruleReport,
    requestBacktest,
    getBacktest,
    setRuleState,
    transactionRuleResults,
    syncTransactions,
    simulatePurchase,
    simulateAction,
    enhancedData,
    simulate3ds,
    enterOtp,
    tokenizations,
    tokenizationAction,
    simulateTokenization,
    webProvision,
    webPushAvailability,
    fileDispute,
    refreshDispute,
    withdrawDispute,
    uploadEvidence,
    deleteEvidence,
    managedDisputes,
    financialAccounts,
    disburse,
    reverseTransfer,
    fundProgram,
    balances,
    accountActivity,
    bookTransfers,
    settlementSummary,
    responder,
    enrollResponder,
    disenrollResponder,
    syncAsaSecret,
    subscriptions,
    createSubscription,
    deleteSubscription,
    syncSubscriptionSecret,
    recoverSubscription,
    replayMissing,
    sendExample,
    subscriptionAttempts,
    listEvents,
    handleEvent,
    monitoringCases,
    updateMonitoringCase,
  }
}

export function publicCard(card) {
  return {
    token: card.token,
    type: card.type,
    state: card.state,
    lastFour: card.last_four,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    network: card.network || (String(card.pan || '').startsWith('4') ? 'Visa' : 'Mastercard'),
    memo: card.memo,
    accountToken: card.account_token,
    spendLimit: card.spend_limit,
    spendLimitDuration: card.spend_limit_duration,
    pinStatus: card.pin_status,
  }
}

function sameParameters(current, wanted) {
  if (!current) return false
  const picked = Object.fromEntries(Object.keys(wanted).map((k) => [k, current[k]]))
  return stableJson(picked) === stableJson(wanted)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined && value[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function isPublicHttps(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname) && !u.hostname.endsWith('.local')
  } catch {
    return false
  }
}

function preview(secret) {
  return secret ? `${String(secret).slice(0, 10)}…${String(secret).slice(-4)}` : null
}

function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 10 ? `+1${digits.slice(-10)}` : '+15555550100'
}

// Deterministic v4-shaped UUID so retries of the same create reuse Lithic's idempotency key.
function stableUuid(seed) {
  let h = 0n
  for (const ch of seed) h = (h * 131n + BigInt(ch.charCodeAt(0))) % 2n ** 128n
  const hex = h.toString(16).padStart(32, '0').slice(-32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export { LithicError }
