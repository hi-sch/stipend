import { randomBytes } from 'node:crypto'
import { buildSeed } from '../src/data/seed.js'
import { generatePassword, hashPassword } from './accounts.js'
import { virtualIbanFor } from './domain.js'

/**
 * First-run state. Passwords come from STIPEND_ADMIN_PASSWORD / STIPEND_CARDHOLDER_PASSWORD,
 * or are generated and returned once so the server can print them.
 */
export function buildServerSeed(env = {}) {
  const demo = buildSeed()
  const credentials = []
  const adminPassword = env.STIPEND_ADMIN_PASSWORD || generatePassword()
  const holderPassword = env.STIPEND_CARDHOLDER_PASSWORD || generatePassword()
  if (!env.STIPEND_ADMIN_PASSWORD) credentials.push({ email: 'ops@stipend.demo', password: adminPassword, role: 'admin' })
  if (!env.STIPEND_CARDHOLDER_PASSWORD) credentials.push({ email: demo.cardholder.email, password: holderPassword, role: 'cardholder' })

  const cardholders = demo.cardholders.map((c) => ({
    ...c,
    card: { ...c.card, token: null, pan: undefined, cvv: undefined },
    beneficiaryRef: 'DE-BA-100042',
    iban: virtualIbanFor(c.id),
    prefs: { emailAlerts: false },
    kyc: { status: 'NOT_SUBMITTED' },
  }))
  for (const holder of cardholders) {
    delete holder.card.pan
    delete holder.card.cvv
  }
  const connections = demo.connections.map((c) => ({
    ...c,
    hookPath: `/api/hooks/credits/${c.id}`,
    hmacSecret: `whk_${randomBytes(24).toString('base64url')}`,
    dailyLimitCents: 15000,
    // Only living-cost benefits may be paid out as cash; rent and health money stay on the card.
    cashAllowed: c.id === 'de-jobcenter',
  }))
  const transactions = demo.transactions.map((t) => ({
    ...t,
    kind: 'PURCHASE',
    debitedCents: t.status === 'DECLINED' ? 0 : t.amountCents,
    live: false,
    source: 'seed',
  }))
  const now = new Date().toISOString()
  return {
    state: {
      seededAt: now,
      operator: demo.operator,
      users: [
        { id: 'usr_ops', email: 'ops@stipend.demo', name: demo.operator.name, role: 'admin', passwordHash: hashPassword(adminPassword), mustChangePassword: !env.STIPEND_ADMIN_PASSWORD, createdAt: now },
        { id: 'usr_lena', email: demo.cardholder.email, name: `${demo.cardholder.firstName} ${demo.cardholder.lastName}`, role: 'cardholder', cardholderId: demo.cardholder.id, passwordHash: hashPassword(holderPassword), mustChangePassword: !env.STIPEND_CARDHOLDER_PASSWORD, createdAt: now },
      ],
      cardholders,
      connections,
      // Cash withdrawals are off for everyone until an operator adds a cardholder to a cash rule.
      cashRules: [{ id: 'cash_100_month', name: 'Standard cash allowance', limitCents: 10000, period: 'MONTH', createdAt: now }],
      envelopes: demo.envelopes,
      credits: demo.credits.map((c) => ({ ...c, recalledCents: 0 })),
      transactions,
      disputes: [],
      cases: [],
      asaLog: [],
      webhooks: [],
      notifications: [],
      emailOutbox: [],
      reports: [],
      lithic: { status: 'idle', error: null },
      settings: { asaSecret: null, webhookSecrets: {}, asaMode: 'local' },
    },
    credentials,
  }
}
