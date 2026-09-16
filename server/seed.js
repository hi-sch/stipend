import { randomBytes } from 'node:crypto'
import { buildSeed } from '../src/data/seed.js'
import { generatePassword, hashPassword } from './accounts.js'
import { id, virtualIbanFor } from './domain.js'
import { ensureAccount, postEntry } from './db/ledger.js'
import { secretBox } from './db/secrets.js'

/**
 * First-run data.
 *
 * The demo program is written as rows rather than as a document, and every opening balance
 * is posted to the journal as an ADJUSTMENT entry. Without that the seeded envelopes would
 * hold money the ledger has no record of, and the first reconciliation run would correctly
 * report every one of them as a break.
 *
 * Seeding is skipped when the database already holds a program, so a restarting pod never
 * writes demo data over real data.
 */
export async function seedDatabase({ client, env = {}, log } = {}) {
  const { rows: existing } = await client.query('SELECT 1 FROM cardholders LIMIT 1')
  if (existing.length) {
    // Say so. A database holding rows but no operator — a half-used development database,
    // a restored dump — otherwise gives a program nobody can sign in to, with nothing in
    // the log to explain why.
    const { rows: operators } = await client.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`)
    if (operators[0].n === 0) {
      log?.warn?.('seeding skipped: the database already holds cardholders, but it has no operator to sign in with', {
        hint: 'point DATABASE_URL at an empty database, or create an operator by hand',
      })
    } else {
      log?.info?.('seeding skipped: the database already holds a program')
    }
    return { seeded: false, credentials: [] }
  }

  const demo = buildSeed()
  const now = new Date().toISOString()

  const adminPassword = env.STIPEND_ADMIN_PASSWORD || generatePassword()
  const holderPassword = env.STIPEND_CARDHOLDER_PASSWORD || generatePassword()

  // ---- program identity and settings

  await client.query(
    `INSERT INTO program_meta (key, value) VALUES ('operator', $1::jsonb), ('seededAt', $2::jsonb), ('lithic', $3::jsonb), ('settings', $4::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [
      JSON.stringify(demo.operator),
      JSON.stringify(now),
      JSON.stringify({ status: 'idle', error: null }),
      JSON.stringify({ asaSecret: null, webhookSecrets: {}, asaMode: 'local' }),
    ],
  )

  // ---- connections

  for (const c of demo.connections) {
    await client.query(
      `INSERT INTO connections (id, name, agency, country, system, protocol, purpose, status, mccs, countries,
                                daily_limit_cents, cash_allowed, hook_path, hmac_secret, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        c.id,
        c.name,
        c.agency ?? null,
        c.country ?? null,
        c.system ?? null,
        c.protocol,
        c.purpose ?? null,
        c.status ?? 'live',
        c.mccs ?? [],
        c.countries ?? [],
        15000,
        // Only the Jobcenter connection allows cash in the demo program.
        c.id === 'de-jobcenter',
        `/api/hooks/credits/${c.id}`,
        secretBox().seal(c.hmacSecret ?? `whk_${randomBytes(24).toString('base64url')}`),
        c.createdAt ?? now,
      ],
    )
  }

  // ---- cardholders

  for (const holder of demo.cardholders) {
    await client.query(
      `INSERT INTO cardholders (id, first_name, last_name, email, phone, city, country, iban_ref,
                                beneficiary_ref, iban, lithic_account, card, kyc, prefs, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)`,
      [
        holder.id,
        holder.firstName,
        holder.lastName,
        holder.email,
        holder.phone ?? null,
        holder.city ?? null,
        holder.country ?? null,
        holder.ibanRef ?? null,
        'DE-BA-100042',
        virtualIbanFor(holder.id),
        null,
        // The demo card carries no PAN or CVV: card data is only ever shown through
        // Lithic's embed, and a seeded PAN would be a fake secret in a real database.
        JSON.stringify({ ...holder.card, token: null, pan: undefined, cvv: undefined }),
        JSON.stringify({ status: 'NOT_SUBMITTED' }),
        JSON.stringify({ emailAlerts: false }),
        now,
      ],
    )
  }

  // ---- users

  // ON CONFLICT DO NOTHING so a reset, which keeps operator logins, does not collide with
  // the operator who asked for it.
  await client.query(
    `INSERT INTO users (id, email, name, role, password_hash, must_change_password, created_at)
     VALUES ($1,$2,$3,'admin',$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    ['usr_ops', 'ops@stipend.demo', demo.operator.name, hashPassword(adminPassword), !env.STIPEND_ADMIN_PASSWORD, now],
  )

  const cardholder = demo.cardholder
  await client.query(
    `INSERT INTO users (id, email, name, role, password_hash, must_change_password, cardholder_id, created_at)
     VALUES ($1,$2,$3,'cardholder',$4,$5,$6,$7)
     ON CONFLICT DO NOTHING`,
    [
      'usr_lena',
      cardholder.email,
      `${cardholder.firstName} ${cardholder.lastName}`,
      hashPassword(holderPassword),
      !env.STIPEND_CARDHOLDER_PASSWORD,
      cardholder.id,
      now,
    ],
  )

  // ---- cash rule, with nobody in it

  await client.query(
    `INSERT INTO cash_rules (id, name, limit_cents, period, created_at) VALUES ($1,$2,$3,$4,$5)`,
    ['cash_100_month', 'Standard cash allowance', 10000, 'MONTH', now],
  )

  // ---- envelopes, and their opening balances in the journal

  for (const e of demo.envelopes) {
    await client.query(
      `INSERT INTO envelopes (id, cardholder_id, connection_id, connection_name, balance_cents, spent_cents,
                              mccs, countries, color, received_at, end_to_end_id, remittance, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        e.id,
        e.cardholderId,
        e.connectionId,
        e.connectionName,
        e.balanceCents,
        e.spentCents ?? 0,
        e.mccs ?? [],
        e.countries ?? [],
        e.color ?? null,
        e.receivedAt ?? now,
        e.endToEndId ?? null,
        e.remittance ?? null,
        e.receivedAt ?? now,
      ],
    )

    // The journal has to agree with the balance from the first moment, or reconciliation
    // reports the seeded envelope as drifted. The counterpart is the funding account of
    // the connection the money came from, which is what a real credit would have used.
    const envelopeAccount = await ensureAccount(client, { kind: 'ENVELOPE', ref: e.id, envelopeId: e.id, cardholderId: e.cardholderId })
    const funding = await ensureAccount(client, { kind: 'FUNDING', ref: e.connectionId, connectionId: e.connectionId })

    await postEntry(client, {
      idempotencyKey: `seed:opening:${e.id}`,
      kind: 'ADJUSTMENT',
      at: e.receivedAt ?? now,
      source: 'seed',
      cardholderId: e.cardholderId,
      memo: 'Seeded opening balance',
      lines: [
        { accountId: funding, direction: 'DR', amountCents: e.balanceCents },
        { accountId: envelopeAccount, direction: 'CR', amountCents: e.balanceCents },
      ],
    })
  }

  // ---- credits

  for (const c of demo.credits) {
    await client.query(
      `INSERT INTO credits (id, connection_id, cardholder_id, envelope_id, amount_cents, recalled_cents,
                            currency, end_to_end_id, protocol, remittance, status, method, lithic_category, created_at)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        c.id,
        c.connectionId,
        c.cardholderId,
        demo.envelopes.find((e) => e.connectionId === c.connectionId && e.cardholderId === c.cardholderId)?.id ?? null,
        c.amountCents,
        c.currency ?? 'EUR',
        c.endToEndId,
        c.protocol ?? null,
        c.remittance ?? null,
        c.status ?? 'SETTLED',
        c.method ?? null,
        c.lithicCategory ?? null,
        c.created ?? now,
      ],
    )
  }

  // ---- transactions
  //
  // Seeded history is demonstration only: debited_cents stays 0 and nothing is posted to
  // the journal for it, because the opening balances above already account for the money.
  // Posting these as well would double-count the spend.

  for (const t of demo.transactions) {
    await client.query(
      `INSERT INTO transactions (id, cardholder_id, card_token, kind, status, result, detailed_results,
                                 merchant, currency, requested_cents, amount_cents, envelope_id,
                                 cash_cents, debited_cents, source, live, lithic, created_at, updated_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,0,0,'seed',false,$12::jsonb,$13,$13)`,
      [
        t.id,
        t.cardholderId,
        t.kind ?? 'PURCHASE',
        t.status,
        t.result ?? null,
        t.detailedResults ?? [],
        JSON.stringify(t.merchant ?? {}),
        t.currency ?? 'EUR',
        t.amountCents,
        t.amountCents,
        t.envelopeId,
        JSON.stringify(t.lithic ?? {}),
        t.created ?? now,
      ],
    )
  }

  return {
    seeded: true,
    credentials: [
      { role: 'operator', email: 'ops@stipend.demo', password: adminPassword, generated: !env.STIPEND_ADMIN_PASSWORD },
      { role: 'cardholder', email: cardholder.email, password: holderPassword, generated: !env.STIPEND_CARDHOLDER_PASSWORD },
    ],
  }
}

// Kept for callers that only want a fresh identifier while seeding fixtures.
export { id }
