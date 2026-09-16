import { isUuid } from './lithicApi.js'
import { verifyPassword } from './accounts.js'
import { requestCash, withCash, withdrawCashRequest } from './domain.js'
import { getCardholder, updateCardholder } from './db/repo.js'
import { ALERT_GROUP_KEYS } from '../src/lib/alerts.js'

/**
 * Everything a cardholder can do to their own card.
 *
 * Every route here resolves the cardholder through holderIdFor, which is what lets an
 * operator open the app as somebody (`?cardholderId=`) without any of these handlers
 * knowing about it. A cardholder can only ever be themselves; the check lives in one place
 * rather than in twenty.
 *
 * Dependencies are handed in rather than imported, the same way the responder and ledger
 * routes work. wrapDomain and originOf in particular are defined in app.js, and importing
 * them from here would make the two modules circular.
 */
export function registerCardholderRoutes({
  route,
  db,
  service,
  lithic,
  env,
  environment,
  audit,
  holderIdFor,
  requireSandbox,
  syncThrottle,
  wrapDomain,
  originOf,
  AppError,
}) {
  route('POST', '/api/me/sync', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    if (!lithic.configured) return { skipped: 'Lithic not configured' }

    const last = syncThrottle.get(holderId) || 0
    if (Date.now() - last < 20000) return { skipped: 'throttled' }
    syncThrottle.set(holderId, Date.now())

    const holder = await getCardholder(db.pool, holderId)
    if (!isUuid(holder.card?.token)) return { skipped: 'no card' }
    return service.syncTransactions(holderId)
  })

  route('POST', '/api/me/notifications/read', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    await db.query('UPDATE notifications SET read_at = now() WHERE cardholder_id = $1 AND read_at IS NULL', [holderId])
    return { ok: true }
  })

  route('PATCH', '/api/me/prefs', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    const b = ctx.body || {}
    const next = {}

    if (b.emailAlerts !== undefined) next.emailAlerts = Boolean(b.emailAlerts)
    if (b.emailMuted !== undefined) {
      if (!Array.isArray(b.emailMuted) || b.emailMuted.some((g) => !ALERT_GROUP_KEYS.includes(g))) {
        throw new AppError(`emailMuted must list alert types: ${ALERT_GROUP_KEYS.join(', ')}`)
      }
      next.emailMuted = [...new Set(b.emailMuted)]
    }

    const holder = await db.tx((c) => updateCardholder(c, holderId, { prefs: next }))
    return holder.prefs
  })

  /** Cardholders keep their own contact details current; changing the sign-in email needs the password. */
  route('PATCH', '/api/me/profile', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    const b = ctx.body || {}
    const holder = await getCardholder(db.pool, holderId)
    const fields = {}

    if (b.phone !== undefined) {
      const phone = String(b.phone).trim()
      if (!/^\+?[0-9 ()/-]{6,30}$/.test(phone)) throw new AppError('Enter a phone number with country code, for example +49 30 1234567.')
      fields.phone = phone
    }

    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase()
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new AppError('Enter a valid email address.')
      if (email !== String(holder.email).toLowerCase()) {
        if (ctx.user.role === 'cardholder') {
          const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [ctx.user.id])
          if (!verifyPassword(String(b.currentPassword || ''), rows[0].password_hash)) throw new AppError('Current password is incorrect.', 401)
        }
        const { rows: clash } = await db.query('SELECT 1 FROM users WHERE lower(email) = $1 AND (cardholder_id IS DISTINCT FROM $2)', [email, holderId])
        if (clash.length) throw new AppError('This email address is already in use.', 409)
        fields.email = email
      }
    }

    if (!Object.keys(fields).length) return withCash(db.pool, holder)

    await service.updateAccountHolder(holderId, fields)
    await audit(ctx, 'me.profile', { target: holderId, details: { fields: Object.keys(fields) } })
    return withCash(db.pool, await getCardholder(db.pool, holderId))
  })

  route('POST', '/api/me/card/state', 'user', async (ctx) => {
    const state = ctx.body?.state
    if (ctx.user.role === 'cardholder' && !['OPEN', 'PAUSED'].includes(state)) throw new AppError('Cardholders can only freeze or unfreeze.', 403)
    await service.setCardState(await holderIdFor(ctx), state)
    return { ok: true }
  })

  route('POST', '/api/me/card/embed', 'user', async (ctx) =>
    service.embedSession(await holderIdFor(ctx), { type: ctx.body?.type, targetOrigin: originOf(ctx.req) }),
  )
  route('GET', '/api/me/card/spend-limits', 'user', async (ctx) => service.spendLimits(await holderIdFor(ctx)))
  route('GET', '/api/me/tokenizations', 'user', async (ctx) => service.tokenizations(await holderIdFor(ctx)))
  route('POST', '/api/me/tokenizations/:token/:action', 'user', async (ctx) =>
    service.tokenizationAction(await holderIdFor(ctx), ctx.params.token, ctx.params.action),
  )
  route('POST', '/api/me/wallets/simulate', 'user', async (ctx) => {
    requireSandbox()
    return service.simulateTokenization(await holderIdFor(ctx), ctx.body?.wallet)
  })
  route('POST', '/api/me/wallets/web-provision', 'user', async (ctx) => service.webProvision(await holderIdFor(ctx), ctx.body || {}))
  route('GET', '/api/me/wallets/config', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    const applePay = environment === 'sandbox' || !lithic.configured ? 'unavailable' : await service.webPushAvailability(holderId).catch(() => 'unknown')
    return {
      sandbox: environment === 'sandbox',
      applePay,
      googlePay: environment !== 'sandbox' && Boolean(env.LITHIC_GOOGLE_INTEGRATOR_ID) && applePay !== 'unavailable',
      applePartnerId: env.LITHIC_APPLE_PARTNER_ID || 'ORG-97a7c2b2-11ec-4d6d-a3f7-c3d06f4b2703',
      googleIntegratorId: env.LITHIC_GOOGLE_INTEGRATOR_ID || '',
    }
  })
  route('POST', '/api/me/purchases', 'user', async (ctx) => {
    requireSandbox()
    const b = ctx.body || {}
    return service.simulatePurchase(await holderIdFor(ctx), {
      amountCents: Number(b.amountCents),
      mcc: String(b.mcc || ''),
      merchant: b.merchant,
      city: b.city,
      country: b.country,
      partialApprovalCapable: Boolean(b.partialApprovalCapable),
      cashCents: Number(b.cashCents) || 0,
    })
  })

  route('POST', '/api/me/cash-request', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    return wrapDomain(() =>
      db.tx((c) => requestCash(c, holderId, { amountCents: Number(ctx.body?.amountCents), period: ctx.body?.period, reason: ctx.body?.reason })),
    )
  })
  route('DELETE', '/api/me/cash-request', 'user', async (ctx) => {
    const holderId = await holderIdFor(ctx)
    return wrapDomain(() => db.tx((c) => withdrawCashRequest(c, holderId)))
  })
  route('POST', '/api/me/3ds', 'user', async (ctx) => {
    requireSandbox()
    return service.simulate3ds(await holderIdFor(ctx), ctx.body || {})
  })
  route('POST', '/api/me/3ds/:token/otp', 'user', async (ctx) => {
    requireSandbox()
    await holderIdFor(ctx)
    return service.enterOtp(ctx.params.token, String(ctx.body?.otp || ''))
  })
  route('POST', '/api/me/disputes', 'user', async (ctx) => service.fileDispute(await holderIdFor(ctx), ctx.body || {}))
  route('POST', '/api/me/disputes/:id/refresh', 'user', async (ctx) => service.refreshDispute(ctx.params.id, await holderIdFor(ctx)))
  route('POST', '/api/me/disputes/:id/withdraw', 'user', async (ctx) => {
    await service.withdrawDispute(ctx.params.id, await holderIdFor(ctx))
    return { ok: true }
  })
  route('POST', '/api/me/disputes/:id/evidence', 'user', async (ctx) => service.uploadEvidence(ctx.params.id, await holderIdFor(ctx), ctx.body || {}))
  route('DELETE', '/api/me/disputes/:id/evidence/:token', 'user', async (ctx) =>
    service.deleteEvidence(ctx.params.id, await holderIdFor(ctx), ctx.params.token),
  )
}
