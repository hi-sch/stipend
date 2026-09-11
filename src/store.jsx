import { createContext, useContext, useMemo, useState } from 'react'
import { buildSeed } from './data/seed.js'
import { AGENCIES, defaultCountriesFor } from './data/agencies.js'
import { authorizeSpend } from './lib/auth.js'
import { uid } from './lib/format.js'

const KEY = 'stipend.v1'
const StoreContext = createContext(null)

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (!parsed.cardholders?.length && parsed.cardholder) {
        parsed.cardholders = [parsed.cardholder]
      }
      parsed.connections = (parsed.connections || []).map((c) =>
        c.countries ? c : { ...c, countries: defaultCountriesFor(c.country) },
      )
      parsed.envelopes = (parsed.envelopes || []).map((e) => {
        if (e.countries) return e
        const conn = parsed.connections.find((c) => c.id === e.connectionId)
        return { ...e, countries: conn?.countries ?? [] }
      })
      return parsed
    }
  } catch {
    /* ignore */
  }
  return buildSeed()
}

function persist(state) {
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function StoreProvider({ children }) {
  const [state, setState] = useState(load)

  const api = useMemo(() => {
    const patch = (fn) => {
      setState((prev) => {
        const next = fn(prev)
        persist(next)
        return next
      })
    }

    return {
      ...state,
      setCountry(country) {
        patch((s) => ({ ...s, country }))
      },
      resetDemo() {
        const fresh = buildSeed()
        persist(fresh)
        setState(fresh)
      },
      connectionById(id) {
        return state.connections.find((c) => c.id === id)
      },
      envelopeById(id) {
        return state.envelopes.find((e) => e.id === id)
      },
      createConnection(input) {
        const id = input.id || uid('conn')
        const conn = {
          id,
          name: input.name,
          country: input.country,
          agency: input.agency,
          system: input.system || 'pain.001',
          protocol: input.protocol,
          purpose: input.purpose || 'SSBE',
          mccs: input.mccs,
          countries: input.countries ?? defaultCountriesFor(input.country),
          status: 'sandbox',
          hookPath: `/v1/credits/${id}`,
          hmacSecret: `sk_live_${id.replace(/-/g, '').slice(0, 6)}_${Math.random().toString(16).slice(2, 10)}`,
          createdAt: new Date().toISOString(),
        }
        patch((s) => ({ ...s, connections: [conn, ...s.connections] }))
        return conn
      },
      updateConnection(id, updates) {
        patch((s) => ({
          ...s,
          connections: s.connections.map((c) => (c.id === id ? { ...c, ...updates } : c)),
          envelopes: s.envelopes.map((e) =>
            e.connectionId === id
              ? {
                  ...e,
                  connectionName: updates.name ?? e.connectionName,
                  mccs: updates.mccs ?? e.mccs,
                  countries: updates.countries ?? e.countries,
                }
              : e,
          ),
        }))
      },
      creditFromHook({ connectionId, amountCents, endToEndId, remittance, protocol }) {
        let posted = null
        patch((s) => {
          const conn = s.connections.find((c) => c.id === connectionId)
          if (!conn) return s
          const credit = {
            id: uid('crd'),
            created: new Date().toISOString(),
            connectionId,
            amountCents,
            currency: 'EUR',
            endToEndId: endToEndId || `E2E-${Date.now()}`,
            protocol: protocol || conn.protocol,
            remittance: remittance || `Credit via ${conn.name}`,
            status: 'SETTLED',
            method: 'book_transfer',
            lithicCategory: 'BALANCE_OR_FUNDING',
          }
          posted = credit
          const existing = s.envelopes.find((e) => e.connectionId === connectionId)
          let envelopes
          if (existing) {
            envelopes = s.envelopes.map((e) =>
              e.id === existing.id
                ? { ...e, balanceCents: e.balanceCents + amountCents, receivedAt: credit.created }
                : e,
            )
          } else {
            envelopes = [
              {
                id: uid('env'),
                connectionId,
                connectionName: conn.name,
                balanceCents: amountCents,
                spentCents: 0,
                mccs: conn.mccs,
                countries: conn.countries ?? [],
                receivedAt: credit.created,
                endToEndId: credit.endToEndId,
                remittance: credit.remittance,
                color: colorFor(s.envelopes.length),
              },
              ...s.envelopes,
            ]
          }
          return { ...s, credits: [credit, ...s.credits], envelopes }
        })
        return posted
      },
      tryPurchase({ amountCents, mcc, merchant, city, country }) {
        let outcome = null
        patch((s) => {
          const merchantCountry = country || 'DEU'
          const decision = authorizeSpend(s.envelopes, { amountCents, mcc, country: merchantCountry })
          const created = new Date().toISOString()
          const row = {
            id: uid('txn'),
            created,
            amountCents,
            currency: 'EUR',
            status: decision.approved ? 'SETTLED' : 'DECLINED',
            result: decision.approved ? 'APPROVED' : 'DECLINED',
            detailedResults: decision.detailedResults,
            envelopeId: decision.envelopeId ?? null,
            merchant: {
              descriptor: merchant || `MCC ${mcc} merchant`,
              city: city || s.cardholder.city,
              country: merchantCountry,
              mcc,
            },
            lithic: { category: 'CARD' },
            note: decision.approved ? null : decision.reason,
          }
          outcome = { ...decision, transaction: row }
          let envelopes = s.envelopes
          if (decision.approved) {
            envelopes = s.envelopes.map((e) =>
              e.id === decision.envelopeId
                ? {
                    ...e,
                    balanceCents: e.balanceCents - amountCents,
                    spentCents: e.spentCents + amountCents,
                  }
                : e,
            )
          }
          return { ...s, transactions: [row, ...s.transactions], envelopes }
        })
        return outcome
      },
      setCardState(next) {
        patch((s) => ({
          ...s,
          cardholder: { ...s.cardholder, card: { ...s.cardholder.card, state: next } },
        }))
      },
      agenciesForCountry(code) {
        return AGENCIES.filter((a) => a.country === code)
      },
      createCardholder(input) {
        const id = uid('ch')
        const lastFour = String(1000 + Math.floor(Math.random() * 9000))
        const person = {
          id,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email: input.email.trim(),
          phone: input.phone?.trim() || '',
          city: input.city.trim(),
          country: input.country,
          ibanRef: '',
          lithicAccount: crypto.randomUUID?.() || uid('acct'),
          card: {
            token: uid('card'),
            type: 'VIRTUAL',
            state: 'OPEN',
            pan: `424242424242${lastFour}`,
            lastFour,
            expMonth: '10',
            expYear: '2030',
            cvv: String(100 + Math.floor(Math.random() * 900)),
            network: 'Mastercard',
            memo: `Stipend · ${input.firstName.trim()} ${input.lastName.trim()}`,
          },
        }
        patch((s) => ({ ...s, cardholders: [person, ...(s.cardholders || [s.cardholder])] }))
        return person
      },
      selectCardholder(id) {
        patch((s) => {
          const next = (s.cardholders || []).find((c) => c.id === id)
          return next ? { ...s, cardholder: next } : s
        })
      },
    }
  }, [state])

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore outside provider')
  return ctx
}

const PALETTE = ['#7C6CF0', '#C9894A', '#2F9E8A', '#3D7EDB', '#D46B8C', '#E0A21A']
function colorFor(i) {
  return PALETTE[i % PALETTE.length]
}
