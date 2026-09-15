import { createContext, useContext, useMemo, useState, useEffect } from 'react'
import { setFormatLocale } from '../lib/format.js'
import { LOCALES, messages } from './messages.js'

const KEY = 'stipend.lang'
// Source-text catalogs for tx(), one file per language, loaded only when that language is active.
const CATALOGS = import.meta.glob('./catalog/*.js')
const I18nContext = createContext(null)

function readLang() {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored && LOCALES[stored]) return stored
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').slice(0, 2)
  return LOCALES[nav] ? nav : 'en'
}

function lookup(dict, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), dict)
}

function interpolate(str, vars) {
  if (!vars) return str
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? `{${k}}` : String(vars[k])))
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readLang)
  const [catalog, setCatalog] = useState({})

  useEffect(() => {
    let cancelled = false
    const load = CATALOGS[`./catalog/${lang}.js`]
    if (!load) {
      setCatalog({})
      return undefined
    }
    load()
      .then((mod) => !cancelled && setCatalog(mod.default || {}))
      .catch(() => !cancelled && setCatalog({}))
    return () => {
      cancelled = true
    }
  }, [lang])

  useEffect(() => {
    const tag = LOCALES[lang]?.tag || 'en-GB'
    setFormatLocale(tag)
    document.documentElement.lang = lang
  }, [lang])

  const api = useMemo(() => {
    function t(path, vars) {
      const raw = lookup(messages[lang], path) ?? lookup(messages.en, path) ?? path
      return interpolate(raw, vars)
    }
    // tx('English source', vars): English is the key; missing translations fall back to it.
    function tx(text, vars) {
      return interpolate(catalog[text] ?? text, vars)
    }
    function setLang(next) {
      if (!LOCALES[next]) return
      localStorage.setItem(KEY, next)
      setLangState(next)
    }
    return { lang, locale: LOCALES[lang], t, tx, setLang, languages: Object.values(LOCALES) }
  }, [lang, catalog])

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n outside provider')
  return ctx
}
