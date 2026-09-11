import { AGENCIES, defaultCountriesFor } from './agencies.js'
import { uid } from '../lib/format.js'

const now = Date.now()
const hours = (h) => new Date(now - h * 3600000).toISOString()
const days = (d) => new Date(now - d * 86400000).toISOString()

function connectionFromAgency(agency, extra) {
  return {
    id: agency.id,
    name: agency.name,
    country: agency.country,
    agency: agency.agency,
    system: agency.system,
    protocol: extra.protocol ?? 'pain001',
    purpose: agency.purpose,
    mccs: agency.mccs,
    countries: extra.countries ?? defaultCountriesFor(agency.country),
    status: extra.status ?? 'live',
    hookPath: `/v1/credits/${agency.id}`,
    hmacSecret: extra.hmacSecret,
    createdAt: extra.createdAt ?? days(40),
  }
}

export function buildSeed() {
  const connections = [
    connectionFromAgency(AGENCIES.find((a) => a.id === 'de-jobcenter'), {
      protocol: 'ebics',
      hmacSecret: 'sk_live_jc_9f3a2c81d04e',
      createdAt: days(86),
    }),
    connectionFromAgency(AGENCIES.find((a) => a.id === 'de-wohngeld'), {
      protocol: 'pain001',
      hmacSecret: 'sk_live_wg_b71e44aa9012',
      createdAt: days(70),
    }),
    connectionFromAgency(AGENCIES.find((a) => a.id === 'de-gkv'), {
      protocol: 'json',
      hmacSecret: 'sk_live_gkv_c22d18bf7731',
      createdAt: days(52),
    }),
    connectionFromAgency(AGENCIES.find((a) => a.id === 'fr-caf'), {
      protocol: 'pain001',
      hmacSecret: 'sk_live_caf_11aa90ce4420',
      status: 'sandbox',
      createdAt: days(12),
    }),
    connectionFromAgency(AGENCIES.find((a) => a.id === 'nl-uwv'), {
      protocol: 'ebics',
      hmacSecret: 'sk_live_uwv_88d0bb19fa03',
      status: 'paused',
      createdAt: days(20),
    }),
    connectionFromAgency(AGENCIES.find((a) => a.id === 'eu-cap'), {
      protocol: 'pain001',
      hmacSecret: 'sk_live_cap_55e1c09d2267',
      status: 'sandbox',
      createdAt: days(5),
    }),
  ]

  const envelopes = [
    {
      id: 'env_jobcenter',
      connectionId: 'de-jobcenter',
      connectionName: 'Jobcenter Bürgergeld',
      balanceCents: 41240,
      spentCents: 18760,
      mccs: connections[0].mccs,
      countries: connections[0].countries,
      receivedAt: days(3),
      endToEndId: 'BA-JC-2026-09-08-4412',
      remittance: 'Bürgergeld September — living costs',
      color: '#7C6CF0',
    },
    {
      id: 'env_wohngeld',
      connectionId: 'de-wohngeld',
      connectionName: 'Wohngeldstelle',
      balanceCents: 62000,
      spentCents: 0,
      mccs: connections[1].mccs,
      countries: connections[1].countries,
      receivedAt: days(6),
      endToEndId: 'WG-BE-2026-09-05-118',
      remittance: 'Wohngeld Miete September',
      color: '#C9894A',
    },
    {
      id: 'env_gkv',
      connectionId: 'de-gkv',
      connectionName: 'GKV Zuzahlung',
      balanceCents: 8400,
      spentCents: 3600,
      mccs: connections[2].mccs,
      countries: connections[2].countries,
      receivedAt: days(10),
      endToEndId: 'TK-ZUZahlung-9921',
      remittance: 'Zuzahlungsbefreiung Rest',
      color: '#2F9E8A',
    },
  ]

  const cardholder = {
    id: 'ch_lena',
    firstName: 'Lena',
    lastName: 'Vogt',
    email: 'lena.vogt@example.de',
    phone: '+49 30 555 0142',
    city: 'Berlin',
    country: 'DE',
    ibanRef: 'DE89 3704 0044 0532 0130 00',
    lithicAccount: '6617a88e-d8b1-42e7-a4da-9ce4cb8923c5',
    card: {
      token: 'card_7b9e7666',
      type: 'VIRTUAL',
      state: 'OPEN',
      pan: '4242424242424713',
      lastFour: '4713',
      expMonth: '10',
      expYear: '2030',
      cvv: '318',
      network: 'Mastercard',
      memo: 'Stipend · Lena Vogt',
    },
  }

  const transactions = [
    tx({ hoursAgo: 2, merchant: 'REWE City Prenzlauer Berg', city: 'Berlin', mcc: '5411', amount: 2860, env: 'env_jobcenter', status: 'SETTLED' }),
    tx({ hoursAgo: 5, merchant: 'BVG Ticket App', city: 'Berlin', mcc: '4111', amount: 990, env: null, status: 'DECLINED', result: 'DECLINED', detailed: ['PROGRAM_USAGE_RESTRICTION'] }),
    tx({ hoursAgo: 8, merchant: 'EDEKA am Helmholtzplatz', city: 'Berlin', mcc: '5411', amount: 4120, env: 'env_jobcenter', status: 'SETTLED' }),
    tx({ hoursAgo: 26, merchant: 'dm-drogerie markt', city: 'Berlin', mcc: '5912', amount: 1840, env: 'env_gkv', status: 'SETTLED' }),
    tx({ hoursAgo: 50, merchant: 'Wettpunkt Sportwetten', city: 'Berlin', mcc: '7995', amount: 4000, env: null, status: 'DECLINED', result: 'DECLINED', detailed: ['PROGRAM_USAGE_RESTRICTION', 'AUTH_RULE'] }),
    tx({ hoursAgo: 54, merchant: 'Hausverwaltung Nordost', city: 'Berlin', mcc: '6513', amount: 62000, env: 'env_wohngeld', status: 'PENDING' }),
    tx({ hoursAgo: 11, merchant: 'Lidl Danziger Str.', city: 'Berlin', mcc: '5411', amount: 2190, env: 'env_jobcenter', status: 'SETTLED' }),
    tx({ hoursAgo: 80, merchant: 'Apotheke am Kollwitzplatz', city: 'Berlin', mcc: '5912', amount: 1760, env: 'env_gkv', status: 'SETTLED' }),
    tx({ hoursAgo: 100, merchant: 'Steam Games', city: 'Luxembourg', mcc: '5816', amount: 2499, env: null, status: 'DECLINED', result: 'DECLINED', detailed: ['PROGRAM_USAGE_RESTRICTION'] }),
    tx({ hoursAgo: 120, merchant: 'Bio Company', city: 'Berlin', mcc: '5411', amount: 3340, env: 'env_jobcenter', status: 'SETTLED' }),
    tx({ hoursAgo: 140, merchant: 'H&M Alexanderplatz', city: 'Berlin', mcc: '5651', amount: 2990, env: 'env_jobcenter', status: 'SETTLED' }),
    tx({ hoursAgo: 160, merchant: 'IKEA Lichtenberg', city: 'Berlin', mcc: '5712', amount: 4590, env: 'env_jobcenter', status: 'SETTLED' }),
  ]

  const credits = [
    credit({ daysAgo: 3, connectionId: 'de-jobcenter', amount: 60000, e2e: 'BA-JC-2026-09-08-4412', protocol: 'ebics', remittance: 'Bürgergeld September — living costs' }),
    credit({ daysAgo: 6, connectionId: 'de-wohngeld', amount: 62000, e2e: 'WG-BE-2026-09-05-118', protocol: 'pain001', remittance: 'Wohngeld Miete September' }),
    credit({ daysAgo: 10, connectionId: 'de-gkv', amount: 12000, e2e: 'TK-ZUZahlung-9921', protocol: 'json', remittance: 'Zuzahlungsbefreiung Rest' }),
    credit({ daysAgo: 34, connectionId: 'de-jobcenter', amount: 60000, e2e: 'BA-JC-2026-08-08-1188', protocol: 'ebics', remittance: 'Bürgergeld August' }),
  ]

  return {
    country: 'DE',
    cardholder,
    cardholders: [cardholder],
    connections,
    envelopes,
    transactions,
    credits,
    operator: { name: 'Mira Kessler', role: 'Program ops', org: 'Senatsverwaltung Berlin' },
  }
}

function tx({ hoursAgo, merchant, city, mcc, amount, env, status, result, detailed, note }) {
  const approved = status !== 'DECLINED'
  return {
    id: uid('txn'),
    created: hours(hoursAgo),
    amountCents: amount,
    currency: 'EUR',
    status,
    result: result ?? (approved ? 'APPROVED' : 'DECLINED'),
    detailedResults: detailed ?? (approved ? ['APPROVED'] : ['AUTH_RULE']),
    envelopeId: env,
    merchant: {
      descriptor: merchant,
      city,
      country: 'DEU',
      mcc,
    },
    lithic: {
      category: 'CARD',
    },
    note,
  }
}

function credit({ daysAgo, connectionId, amount, e2e, protocol, remittance }) {
  return {
    id: uid('crd'),
    created: days(daysAgo),
    connectionId,
    amountCents: amount,
    currency: 'EUR',
    endToEndId: e2e,
    protocol,
    remittance,
    status: 'SETTLED',
    method: 'book_transfer',
    lithicCategory: 'BALANCE_OR_FUNDING',
  }
}
