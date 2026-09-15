import { useCallback, useEffect, useId, useRef, useState } from 'react'
import CodeEditor from './CodeEditor.jsx'
import { useI18n } from '../i18n/I18n.jsx'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps keyboard focus inside a dialog, closes on Escape and returns focus to the opener. */
export function useFocusTrap(onClose) {
  const ref = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement
    const node = ref.current
    const items = () => [...(node?.querySelectorAll(FOCUSABLE) || [])].filter((el) => el.offsetParent !== null || el === document.activeElement)
    const first = items().find((el) => el.tagName !== 'BUTTON' || !el.matches('[data-dialog-close]')) || items()[0]
    first?.focus()
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const list = items()
      if (!list.length) return
      const [head, tail] = [list[0], list[list.length - 1]]
      if (e.shiftKey && (document.activeElement === head || !node.contains(document.activeElement))) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && (document.activeElement === tail || !node.contains(document.activeElement))) {
        e.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [])
  return ref
}

export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: '', loading: true })
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    try {
      const data = await fn()
      setState({ data, error: '', loading: false })
      return data
    } catch (err) {
      setState({ data: null, error: err.message || String(err), loading: false })
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    load()
  }, [load])
  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) }
}

export function ErrorText({ error }) {
  if (!error) return null
  return (
    <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0' }}>
      {error}
    </p>
  )
}

export function OkText({ children }) {
  if (!children) return null
  return (
    <p role="status" style={{ color: 'var(--ok)', margin: '8px 0' }}>
      {children}
    </p>
  )
}

const GOOD = new Set(['OPEN', 'ACTIVE', 'SETTLED', 'APPROVED', 'ACCEPTED', 'ACCP', 'CNCL', 'live', 'CASE_WON', 'CLOSED_WON', 'enrolled', 'yes'])
const BAD = new Set(['DECLINED', 'CLOSED', 'REJECTED', 'RJCT', 'RJCR', 'paused', 'DEACTIVATED', 'CASE_CLOSED', 'error', 'RECALLED', 'no'])

export function StatusBadge({ status }) {
  if (!status) return <span className="badge">—</span>
  const tone = GOOD.has(status) ? 'ok' : BAD.has(status) ? 'bad' : 'warn'
  return <span className={`badge ${tone}`}>{String(status).replaceAll('_', ' ')}</span>
}

export function JsonView({ value, minHeight = 160, maxHeight = 320 }) {
  return <CodeEditor readOnly language="json" value={JSON.stringify(value, null, 2) ?? ''} minHeight={minHeight} maxHeight={maxHeight} />
}

export function Section({ title, hint, actions, children, style }) {
  return (
    <section className="card" style={style}>
      <div className="card-head">
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {hint && <p className="muted" style={{ margin: '6px 0 0' }}>{hint}</p>}
        </div>
        {actions && <div className="toolbar">{actions}</div>}
      </div>
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
  )
}

/** In-app confirmation dialog; replaces the browser's confirm(). */
export function ConfirmDialog({ title, body, confirmLabel, danger = true, onConfirm, onCancel }) {
  const { t } = useI18n()
  const ref = useFocusTrap(onCancel)
  const titleId = useId()
  return (
    <div className="modal-back" role="presentation" onClick={onCancel}>
      <div ref={ref} className="card modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        {body && <p style={{ color: 'var(--muted)' }}>{body}</p>}
        <div className="card-actions">
          <button className="btn ghost" type="button" data-dialog-close onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : ''}`} type="button" onClick={onConfirm}>
            {confirmLabel || t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** "Question? Explanation." becomes a dialog title and body. */
function splitConfirmText(text) {
  const match = /^(.+?[?？])\s+(.+)$/s.exec(String(text))
  return match ? [match[1], match[2]] : [text, null]
}

/** Button that runs an async action and shows its own error. With confirmText it asks first in a dialog. */
export function ActionButton({ onClick, children, className = 'btn ghost', disabled, confirmText, confirmLabel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  async function run() {
    setAsking(false)
    setBusy(true)
    setError('')
    try {
      await onClick()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }
  const [title, body] = confirmText ? splitConfirmText(confirmText) : []
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" className={className} disabled={disabled || busy} onClick={() => (confirmText ? setAsking(true) : run())}>
        {busy ? '…' : children}
      </button>
      {error && <small style={{ color: 'var(--danger)', maxWidth: 260 }}>{error}</small>}
      {asking && (
        <ConfirmDialog
          title={title}
          body={body}
          confirmLabel={confirmLabel || children}
          danger={/\bdanger\b/.test(className)}
          onConfirm={run}
          onCancel={() => setAsking(false)}
        />
      )}
    </span>
  )
}

export function Modal({ title, onClose, children, wide }) {
  const { tx } = useI18n()
  const ref = useFocusTrap(onClose)
  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div ref={ref} className={`card modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="btn ghost" onClick={onClose} data-dialog-close aria-label={tx("Close")}>
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  )
}

export function KeyValues({ rows }) {
  return (
    <dl className="kv">
      {rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? '—'}</dd>
          </div>
        ))}
    </dl>
  )
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="seg" role="tablist" style={{ width: 'fit-content' }}>
      {tabs.map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className={value === key ? 'on' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function SecretOnce({ label, value, onDone }) {
  const { tx } = useI18n()
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <div className="secret-once" role="status">
      <strong>{label}</strong>
      <code>{value}</code>
      <div className="toolbar">
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            navigator.clipboard?.writeText(value)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {onDone && (
          <button type="button" className="btn ghost" onClick={onDone}>{tx("Done")}</button>
        )}
      </div>
      <small className="muted">{tx("Shown once. Store it in the paying system now.")}</small>
    </div>
  )
}

export function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString()
}
