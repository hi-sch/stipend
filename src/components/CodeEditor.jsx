import { useRef } from 'react'

export default function CodeEditor({
  value = '',
  onChange,
  language = 'json',
  readOnly = false,
  minHeight = 160,
  maxHeight = 280,
}) {
  const pre = useRef(null)
  const area = useRef(null)
  const html = language === 'xml' ? highlightXml(value) : highlightJson(value)

  function sync() {
    if (pre.current && area.current) {
      pre.current.scrollTop = area.current.scrollTop
      pre.current.scrollLeft = area.current.scrollLeft
    }
  }

  return (
    <div className="code-editor" style={{ minHeight, maxHeight, height: maxHeight }}>
      <pre ref={pre} className="code-editor-hl" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
      <textarea
        ref={area}
        className="code-editor-input"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onScroll={sync}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        aria-label={language === 'xml' ? 'XML editor' : 'JSON editor'}
      />
    </div>
  )
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightJson(src) {
  const re =
    /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/[^\n]*)/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index))
    if (m[1]) out += `<span class="tok-key">${esc(m[1])}</span>:`
    else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`
    else if (m[3]) out += `<span class="tok-num">${esc(m[3])}</span>`
    else if (m[4]) out += `<span class="tok-kw">${esc(m[4])}</span>`
    else if (m[5]) out += `<span class="tok-comment">${esc(m[5])}</span>`
    last = re.lastIndex
  }
  return out + esc(src.slice(last))
}

function highlightXml(src) {
  const escaped = esc(src)
  const re = /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[A-Za-z_][\w:.-]*|\?&gt;|\/?&gt;)|("[^"]*"|'[^']*')/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(escaped))) {
    out += escaped.slice(last, m.index)
    if (m[1]) out += `<span class="tok-comment">${m[1]}</span>`
    else if (m[2]) out += `<span class="tok-tag">${m[2]}</span>`
    else if (m[3]) out += `<span class="tok-str">${m[3]}</span>`
    last = re.lastIndex
  }
  return out + escaped.slice(last)
}
