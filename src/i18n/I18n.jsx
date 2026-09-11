import { createContext, useContext, useMemo, useState, useEffect } from 'react'
import { setFormatLocale } from '../lib/format.js'
import { LOCALES, messages } from './messages.js'

const KEY = 'stipend.lang'
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
    function setLang(next) {
      if (!LOCALES[next]) return
      localStorage.setItem(KEY, next)
      setLangState(next)
    }
    return { lang, locale: LOCALES[lang], t, setLang, languages: Object.values(LOCALES) }
  }, [lang])

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n outside provider')
  return ctx
}
