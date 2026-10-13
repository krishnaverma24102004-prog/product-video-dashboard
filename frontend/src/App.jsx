import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { History, IdentifyProduct, Progress, ProductPanel, Results, SearchForm, StatusBar } from './components.jsx'
import './App.css'

const FINAL = ['done', 'error', 'needs_hint']
const GIVE_UP_MS = 2 * 60 * 1000
/** Reconnect delay for the n-th consecutive failure: 1s, 2s, 4s, 8s, then 10s. */
const backoffDelay = (attempt) => Math.min(10000, 1000 * 2 ** attempt)

export default function App() {
  const [health, setHealth] = useState(null)
  const [history, setHistory] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [search, setSearch] = useState(null)
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const [conn, setConn] = useState(null) // null | 'reconnecting' | 'lost'
  const followRef = useRef({ gen: 0, es: null, timer: null, seen: new Set() })
  const lastPayload = useRef(null)

  const refreshHistory = useCallback(() => api.history().then(setHistory).catch(() => {}), [])

  useEffect(() => {
    api.health().then(setHealth).catch(() => setError('Cannot reach the backend on :4000. Is it running?'))
    refreshHistory()
  }, [refreshHistory])


  const load = useCallback(async (id) => {
    const s = await api.get(id)
    setSearch(s)
    return s
  }, [])

  // Live progress over SSE, with recovery: on a dropped stream we check the REST endpoint and either load the
  // final result or reconnect with backoff (the server replays buffered events, which we dedupe).
  const stopFollowing = useCallback(() => {
    const f = followRef.current
    f.gen += 1
    f.es?.close()
    f.es = null
    clearTimeout(f.timer)
    f.timer = null
  }, [])

  useEffect(() => stopFollowing, [stopFollowing]) // unmount: drop the stream and any pending retry

  const follow = useCallback((id, { keepEvents = false } = {}) => {
    stopFollowing()
    const f = followRef.current
    const gen = f.gen
    const live = () => followRef.current.gen === gen
    if (!keepEvents) {
      setEvents([])
      f.seen = new Set()
    }
    setConn(null)
    let attempt = 0
    let lostSince = 0

    const finish = () => {
      stopFollowing()
      setConn(null)
      refreshHistory()
      api.health().then(setHealth).catch(() => {})
    }

    const retryLater = (fn) => {
      if (!lostSince) lostSince = Date.now()
      if (Date.now() - lostSince > GIVE_UP_MS) {
        stopFollowing()
        setConn('lost')
        return
      }
      setConn('reconnecting')
      f.timer = setTimeout(() => live() && fn(), backoffDelay(attempt++))
    }

    // Stream dropped: did the search finish meanwhile (or die with a server restart)? Otherwise reconnect.
    const check = () => {
      api.get(id).then(
        (s) => {
          if (!live()) return
          setSearch(s)
          if (FINAL.includes(s.status)) finish()
          else retryLater(connect)
        },
        (e) => {
          if (!live()) return
          if (/not found/i.test(e.message)) {
            stopFollowing()
            setConn(null)
            setError(e.message)
          } else retryLater(check)
        },
      )
    }

    function connect() {
      const es = api.events(id)
      f.es = es
      es.onopen = () => {
        if (!live()) return
        attempt = 0
        lostSince = 0
        setConn(null)
      }
      es.onmessage = (m) => {
        if (!live()) return
        let ev
        try {
          ev = JSON.parse(m.data)
        } catch {
          return
        }
        // the server replays its whole buffer on every (re)connect and sends no ids, so key on content
        const key = `${ev.t}|${ev.stage}|${ev.status}|${ev.message}`
        if (f.seen.has(key)) return
        f.seen.add(key)
        setEvents((prev) => [...prev, ev])
        if (ev.stage === 'brain' && ev.status === 'done' && ev.data) setSearch((s) => (s ? { ...s, product: ev.data } : s))
        if (ev.stage === 'done') {
          finish()
          load(id).catch((e) => setError(e.message))
        }
      }
      es.onerror = () => {
        if (!live()) return
        es.close()
        f.es = null
        setConn('reconnecting')
        check()
      }
    }

    connect()
  }, [load, refreshHistory, stopFollowing])

  async function submit(payload) {
    setError('')
    lastPayload.current = payload
    try {
      const { id } = await api.search(payload)
      setActiveId(id)
      setSearch({ id, input: payload.input || 'Image search', status: 'running', results: [], product: null, stats: null })
      follow(id)
      refreshHistory()
    } catch (e) {
      setError(e.message)
    }
  }

  async function open(id) {
    setNavOpen(false)
    setActiveId(id)
    setError('')
    try {
      const s = await load(id)
      if (s.status === 'running' || s.status === 'queued') follow(id)
      else {
        stopFollowing()
        setConn(null)
        setEvents([])
      }
    } catch (e) {
      setError(e.message)
    }
  }

  async function star(v) {
    const on = !v.starred
    setSearch((s) => ({ ...s, results: s.results.map((r) => (r.uid === v.uid ? { ...r, starred: on } : r)) }))
    api.star(v.uid, on).catch(() => {})
  }

  const busy = search && (search.status === 'running' || search.status === 'queued') && !events.some((e) => e.stage === 'done')
  const finished = search && !busy

  return (
    <div className="app">
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="side-head">
          <h1>Video Discovery</h1>
          <button className="link only-tablet" onClick={() => setNavOpen(false)}>Close</button>
        </div>
        <h3>Search history</h3>
        <History items={history} activeId={activeId} onOpen={open} />
        <a className="btn ghost export" href="/api/shortlist.csv">Export shortlist (CSV)</a>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="btn ghost only-tablet" onClick={() => setNavOpen(true)}>☰ History</button>
          <StatusBar health={health} />
        </header>

        <SearchForm onSubmit={submit} busy={busy} />
        {error && <div className="notice error"><b>Something went wrong.</b> {error}</div>}

        {!search && !error && (
          <div className="empty hero">
            <h2>Find 20 Reels + 20 Meta ads that show your exact product</h2>
            <p className="muted">Type a product name, paste a Shopify/Amazon/brand link, or add a photo. The vision brain reads the product,
              builds per-platform queries, and scores every video against it.</p>
          </div>
        )}

        {search && (busy || events.length > 0) && <Progress events={events} status={busy ? 'running' : search.status} reconnecting={busy && conn === 'reconnecting'} />}
        {search && busy && conn === 'lost' && (
          <div className="notice warn">
            <b>Lost connection to the server.</b> Progress is no longer updating.{' '}
            <button className="link" onClick={() => follow(search.id, { keepEvents: true })}>Retry</button>
            {' · '}
            <button className="link" onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
        {search?.status === 'needs_hint' && (
          <IdentifyProduct
            product={search.product}
            canRetry={Boolean(lastPayload.current?.imageBase64)}
            onPick={(name) => submit({ ...lastPayload.current, input: name })}
          />
        )}
        {search?.status === 'error' && (
          <div className="notice error">
            <b>Search failed.</b> {search.error}
            <p className="small">
              {search.type === 'url'
                ? 'Check that the product link opens publicly in a browser, or try the product name instead.'
                : 'Try again in a minute, or use a more specific product name (brand + model).'}
            </p>
          </div>
        )}
        {search?.product && !search.product.needsHint && <ProductPanel product={search.product} />}
        {finished && search.status === 'done' && <Results key={search.id} search={search} onStar={star} />}
      </main>
    </div>
  )
}
