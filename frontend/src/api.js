// Optional; must match backend API_TOKEN. Vite embeds it in the bundle, so it only keeps out
// callers that never loaded this dashboard. EventSource/<img> can't send it (reads don't need it).
const TOKEN = import.meta.env.VITE_API_TOKEN

async function req(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-api-token': TOKEN } : {}), ...(opts.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = [body.error, ...(body.details || [])].filter(Boolean).join(': ') || `Request failed (${res.status})`
    throw new Error(msg)
  }
  return body
}

export const api = {
  health: () => req('/api/health'),
  search: (payload) => req('/api/search', { method: 'POST', body: JSON.stringify(payload) }),
  get: (id) => req(`/api/search/${id}`),
  history: () => req('/api/history'),
  star: (uid, on) => req(`/api/videos/${encodeURIComponent(uid)}/star`, { method: on ? 'POST' : 'DELETE' }),
  events: (id) => new EventSource(`/api/search/${id}/events`),
}

export const proxied = (url) => (url ? `/api/img?u=${encodeURIComponent(url)}` : '')

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read image'))
    r.readAsDataURL(file)
  })
}
