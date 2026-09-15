import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, setActingCardholder } from './api.js'

const StoreContext = createContext(null)
const PREFS_KEY = 'stipend.ui'

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
  } catch {
    return {}
  }
}

function writePrefs(next) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    /* preferences are optional */
  }
}

export function StoreProvider({ children }) {
  const [user, setUser] = useState(undefined)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [prefs, setPrefs] = useState(readPrefs)
  const loading = useRef(null)
  const version = useRef(0)

  const updatePrefs = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      writePrefs(next)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (loading.current) return loading.current
    loading.current = api('GET', '/api/app/state')
      .then((next) => {
        version.current = next.version
        setData(next)
        setError('')
        return next
      })
      .catch((err) => {
        if (err.status === 401) {
          setUser(null)
          setData(null)
        } else {
          setError(err.message)
        }
        return null
      })
      .finally(() => {
        loading.current = null
      })
    return loading.current
  }, [])

  useEffect(() => {
    api('GET', '/api/auth/session')
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
  }, [])

  const actingId = user?.role === 'admin' ? prefs.viewAs || null : null
  useEffect(() => {
    setActingCardholder(actingId)
  }, [actingId])

  useEffect(() => {
    if (!user || user.mustChangePassword) return undefined
    setActingCardholder(user.role === 'admin' ? prefs.viewAs || null : null)
    refresh()
    api('POST', '/api/me/sync').catch(() => null)
    const source = new EventSource('/api/app/stream')
    source.addEventListener('version', (event) => {
      if (Number(event.data) !== version.current) refresh()
    })
    return () => source.close()
  }, [user, prefs.viewAs, refresh])

  const value = useMemo(() => {
    async function act(method, path, body) {
      const result = await api(method, path, body)
      await refresh()
      return result
    }
    const notifications = (data?.notifications || []).map((n) => ({ ...n, when: n.at, unread: !n.read }))
    return {
      ready: user !== undefined,
      user,
      error,
      ...(data || {}),
      notifications,
      loaded: Boolean(data),
      publicOrigin: data?.appSettings?.publicUrl || window.location.origin,
      country: prefs.country || 'DE',
      setCountry: (country) => updatePrefs({ country }),
      viewAs: actingId,
      selectCardholder: (id) => {
        setActingCardholder(id)
        updatePrefs({ viewAs: id })
      },
      refresh,
      act,
      api,
      async login(email, password) {
        const res = await api('POST', '/api/auth/login', { email, password })
        setUser(res.user)
        return res.user
      },
      async logout() {
        await api('POST', '/api/auth/logout').catch(() => null)
        setUser(null)
        setData(null)
      },
      async changePassword(currentPassword, newPassword) {
        await api('POST', '/api/auth/password', { currentPassword, newPassword })
        setUser((u) => ({ ...u, mustChangePassword: false }))
      },
      markNotificationsRead: () => act('POST', '/api/me/notifications/read'),
      setCardState: (state) => act('POST', '/api/me/card/state', { state }),
      tryPurchase: (body) => act('POST', '/api/me/purchases', body),
      fileDispute: (body) => act('POST', '/api/me/disputes', body),
      sync: () => act('POST', '/api/me/sync'),
      setEmailAlerts: (emailAlerts) => act('PATCH', '/api/me/prefs', { emailAlerts }),
      setPrefs: (prefs) => act('PATCH', '/api/me/prefs', prefs),
      updateProfile: (fields) => act('PATCH', '/api/me/profile', fields),
      revokeOtherSessions: () => act('POST', '/api/auth/sessions/revoke-others'),
      envelopeById: (id) => (data?.envelopes || []).find((e) => e.id === id),
      connectionById: (id) => (data?.connections || []).find((c) => c.id === id),
    }
  }, [user, data, error, prefs, actingId, refresh, updatePrefs])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore outside provider')
  return ctx
}

/** Small helper for pages that call the API and show busy/error/result state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const run = useCallback(async (fn) => {
    setBusy(true)
    setError('')
    try {
      const value = await fn()
      setResult(value)
      return value
    } catch (err) {
      setError(err.message || String(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, result, run, setError, setResult }
}
