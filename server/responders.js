import { envelopesFor, holderByCard, notify } from './domain.js'
import { verifyLithicWebhook } from './hmacNode.js'
import { isPublicHttps } from './lithicService.js'
import { isUuid, qs } from './lithicApi.js'
import { getProgramSettings, patchProgramSettings } from './db/meta.js'

const KINDS = {
  'three-ds': { type: 'THREE_DS_DECISIONING', secretPath: '/v1/three_ds_decisioning/secret', settingsKey: 'threeDsSecret', envKey: 'LITHIC_3DS_SECRET' },
  tokenization: { type: 'TOKENIZATION_DECISIONING', secretPath: '/v1/tokenization_decisioning/secret', settingsKey: 'tokenizationSecret', envKey: 'LITHIC_TOKENIZATION_SECRET' },
}

export const DEFAULT_POLICY = { threeDsChallengeAboveCents: 10000, tokenizationMode: 'recommendation' }

const RESPONDER_LOG_KEEP = 300

async function policyOf(client) {
  const settings = await getProgramSettings(client)
  return { ...DEFAULT_POLICY, ...(settings.responders || {}) }
}

async function logDecision(client, entry) {
  await client.query(
    `INSERT INTO responder_log (kind, token, decision, reason, amount_cents, request, response)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      entry.kind,
      entry.token ?? null,
      entry.decision,
      entry.reason,
      entry.amountCents ?? null,
      JSON.stringify({ holderId: entry.holderId ?? null, merchant: entry.merchant ?? null, mcc: entry.mcc ?? null }),
      JSON.stringify(entry.response ?? {}),
    ],
  )
  await client.query(
    `DELETE FROM responder_log WHERE id NOT IN (SELECT id FROM responder_log ORDER BY at DESC LIMIT $1)`,
    [RESPONDER_LOG_KEEP],
  )
}

/**
 * 3DS decisioning: decline online purchases no envelope could pay for (the authorization would
 * fail anyway), challenge large ones, approve the rest. Non-payment authentications pass.
 */
export async function decideThreeDs(client, request) {
  const holder = await holderByCard(client, request.card_token)
  const merchant = request.merchant || {}
  const amountCents = Number(request.transaction?.amount ?? 0)
  const policy = await policyOf(client)

  let decision = 'APPROVE'
  let reason = 'Envelope can pay this merchant'

  if (!holder) {
    decision = 'DECLINE'
    reason = 'Card is not managed by Stipend'
  } else if (holder.card?.state !== 'OPEN') {
    decision = 'DECLINE'
    reason = `Card is ${String(holder.card?.state || 'unknown').toLowerCase()}`
  } else if (request.message_category === 'NON_PAYMENT_AUTHENTICATION') {
    reason = 'Non-payment authentication'
  } else {
    // 3DS merchant country is not reliably ISO alpha-3, so only the MCC allowlist is checked here;
    // the authorization that follows still enforces country rules.
    const mcc = String(merchant.mcc || '')
    const envelopes = await envelopesFor(client, holder.id)
    const covers = envelopes.filter((e) => e.balanceCents > 0 && (!(e.mccs || []).length || e.mccs.includes(mcc)))
    if (!covers.length) {
      decision = 'DECLINE'
      reason = `No envelope allows MCC ${merchant.mcc || 'unknown'}`
    } else if (amountCents > policy.threeDsChallengeAboveCents) {
      decision = 'CHALLENGE_REQUESTED'
      reason = `Amount above ${policy.threeDsChallengeAboveCents} cents`
    }
  }

  const response = { three_ds_authentication_decision: decision }

  await logDecision(client, {
    kind: '3ds',
    holderId: holder?.id || null,
    token: request.token || null,
    merchant: merchant.name || null,
    mcc: merchant.mcc || null,
    amountCents,
    decision,
    reason,
    response,
  })

  if (holder && decision !== 'APPROVE') {
    await notify(client, {
      holderId: holder.id,
      title: decision === 'DECLINE' ? 'Online purchase blocked' : 'Confirm your online purchase',
      body: `${merchant.name || 'Merchant'} · ${reason}`,
      kind: '3ds',
    })
  }

  return response
}

/** Tokenization decisioning: only open cards; follow the wallet's recommendation unless policy overrides. */
export async function decideTokenization(client, request) {
  const holder = await holderByCard(client, request.card_token)
  const policy = await policyOf(client)
  const recommended = request.wallet_decisioning_info?.recommended_decision

  let decision = 'APPROVE'
  let reason = 'Card open'

  if (!holder) {
    decision = 'DECLINE'
    reason = 'Card is not managed by Stipend'
  } else if (holder.card?.state !== 'OPEN') {
    decision = 'DECLINE'
    reason = `Card is ${String(holder.card?.state || 'unknown').toLowerCase()}`
  } else if (policy.tokenizationMode === 'authenticate') {
    decision = 'AUTHENTICATE'
    reason = 'Policy requires verification for every wallet'
  } else if (policy.tokenizationMode === 'recommendation' && recommended === 'DECLINED') {
    decision = 'DECLINE'
    reason = 'Wallet recommended decline'
  } else if (policy.tokenizationMode === 'recommendation' && recommended === 'REQUIRE_ADDITIONAL_AUTHENTICATION') {
    decision = 'AUTHENTICATE'
    reason = 'Wallet recommended additional verification'
  }

  const response = {
    tokenization_decision: decision,
    phone_number: toE164(holder?.phone),
    email: holder?.email || 'support@stipend.local',
    mobile_application_name: 'Stipend',
  }

  await logDecision(client, {
    kind: 'tokenization',
    holderId: holder?.id || null,
    token: request.tokenization_token || null,
    merchant: request.tokenization_source || null,
    decision,
    reason,
    response: { tokenization_decision: decision },
  })

  if (holder) {
    await notify(client, {
      holderId: holder.id,
      title: decision === 'APPROVE' ? 'Card added to a wallet' : decision === 'AUTHENTICATE' ? 'Verify adding your card to a wallet' : 'Wallet request blocked',
      body: reason,
      kind: 'wallet',
    })
  }

  return response
}

export function registerResponderRoutes({ route, db, lithic, env = {}, environment, AppError }) {
  function kindOrThrow(kind) {
    const spec = KINDS[kind]
    if (!spec) throw new AppError('Unknown responder', 404)
    return spec
  }

  async function verify(ctx, spec) {
    const settings = await getProgramSettings(db.pool)
    const secret = settings[spec.settingsKey] || env[spec.envKey]
    if (secret) {
      const check = verifyLithicWebhook(secret, ctx.raw, ctx.req.headers)
      if (!check.ok) throw new AppError(`Invalid signature (${check.reason})`, 401)
    } else if (environment === 'production') {
      throw new AppError('Responder secret not configured', 401)
    }
  }

  route('POST', '/api/responders/three-ds', 'public', async (ctx) => {
    await verify(ctx, KINDS['three-ds'])
    return db.tx((c) => decideThreeDs(c, ctx.body || {}))
  })

  route('POST', '/api/responders/tokenization', 'public', async (ctx) => {
    await verify(ctx, KINDS.tokenization)
    return db.tx((c) => decideTokenization(c, ctx.body || {}))
  })

  async function storeSecret(spec, rotate) {
    if (rotate) await lithic.post(`${spec.secretPath}/rotate`)
    const { secret } = await lithic.get(spec.secretPath)
    await db.tx((c) => patchProgramSettings(c, { [spec.settingsKey]: secret }))
    return { preview: `${String(secret).slice(0, 10)}…${String(secret).slice(-4)}` }
  }

  route('GET', '/api/admin/responders', 'admin', async () => {
    const settings = await getProgramSettings(db.pool)
    const { rows: log } = await db.query('SELECT * FROM responder_log ORDER BY at DESC LIMIT 100')

    const out = {
      policy: { ...DEFAULT_POLICY, ...(settings.responders || {}) },
      log: log.map((r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind,
        token: r.token,
        decision: r.decision,
        reason: r.reason,
        amountCents: r.amount_cents,
        ...(r.request || {}),
      })),
    }

    for (const [kind, spec] of Object.entries(KINDS)) {
      const endpoint = lithic.configured ? await lithic.get(`/v1/responder_endpoints${qs({ type: spec.type })}`).catch((err) => ({ error: err.message })) : null
      out[kind] = { endpoint, secretConfigured: Boolean(settings[spec.settingsKey] || env[spec.envKey]), path: `/api/responders/${kind}` }
    }

    return out
  })

  route('POST', '/api/admin/responders/:kind/enroll', 'admin', async (ctx) => {
    const spec = kindOrThrow(ctx.params.kind)
    const url = String(ctx.body?.url || '')
    if (!isPublicHttps(url)) throw new AppError('Lithic needs a public HTTPS URL (use a tunnel in development).')
    await lithic.post('/v1/responder_endpoints', { type: spec.type, url })
    return storeSecret(spec, false)
  })

  route('DELETE', '/api/admin/responders/:kind', 'admin', async (ctx) => {
    const spec = kindOrThrow(ctx.params.kind)
    await lithic.del(`/v1/responder_endpoints${qs({ type: spec.type })}`)
    return { ok: true }
  })

  route('POST', '/api/admin/responders/:kind/secret', 'admin', (ctx) => storeSecret(kindOrThrow(ctx.params.kind), Boolean(ctx.body?.rotate)))

  route('PATCH', '/api/admin/responders/settings', 'admin', async (ctx) => {
    const threshold = Number(ctx.body?.threeDsChallengeAboveCents)
    const mode = ctx.body?.tokenizationMode

    return db.tx(async (c) => {
      const next = await policyOf(c)
      if (Number.isInteger(threshold) && threshold >= 0) next.threeDsChallengeAboveCents = threshold
      if (['recommendation', 'approve', 'authenticate'].includes(mode)) next.tokenizationMode = mode
      await patchProgramSettings(c, { responders: next })
      return next
    })
  })

  return { isUuid }
}

function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 10 ? `+${digits}` : '+15555550100'
}
