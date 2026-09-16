export class ApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

/**
 * A sensitive write was parked for a second operator rather than carried out.
 *
 * The server answers 202, which is a success status, so this used to resolve like any other
 * call: the page refreshed, nothing had changed, and the operator was told nothing. Raising
 * it means every gated action reports itself through the error path the buttons already
 * have, without each page having to know about approvals.
 */
export class ApprovalRequiredError extends ApiError {
  constructor(data) {
    super(data.message || 'This change needs a second operator to approve it.', 202, data)
    this.approvalId = data.approvalId
    this.action = data.action
  }
}

let actingCardholder = null

/** Admins viewing the cardholder app act on this cardholder for /api/me calls. */
export function setActingCardholder(id) {
  actingCardholder = id || null
}

export async function api(method, path, body) {
  let url = path
  if (actingCardholder && (path.startsWith('/api/me/') || path === '/api/app/state')) {
    url += `${path.includes('?') ? '&' : '?'}cardholderId=${encodeURIComponent(actingCardholder)}`
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (res.status === 202 && data && data.approvalRequired) {
    throw new ApprovalRequiredError(data)
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data)
  }
  return data
}

export const get = (path) => api('GET', path)
export const post = (path, body = {}) => api('POST', path, body)
export const patch = (path, body = {}) => api('PATCH', path, body)
export const del = (path) => api('DELETE', path)

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}
