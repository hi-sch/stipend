let localeTag = 'en-GB'

export function setFormatLocale(tag) {
  localeTag = tag || 'en-GB'
}

export function getFormatLocale() {
  return localeTag
}

export function eur(cents) {
  return new Intl.NumberFormat(localeTag, { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100)
}

export function eurPlain(cents) {
  const n = (cents || 0) / 100
  return n.toLocaleString(localeTag, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString(localeTag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString(localeTag, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatLongDate(date = new Date()) {
  return date.toLocaleDateString(localeTag, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export function relativeDay(iso, t) {
  const d = new Date(iso)
  const now = new Date()
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const diff = (start(now) - start(d)) / 86400000
  if (diff === 0) return t ? t('common.today') : 'Today'
  if (diff === 1) return t ? t('common.yesterday') : 'Yesterday'
  return formatDate(iso)
}

export function maskPan(pan) {
  return pan.replace(/^(\d{4})(\d{8})(\d{4})$/, '$1  ••••  ••••  $3')
}

export function hmacPreview(secret) {
  if (!secret) return ''
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}
