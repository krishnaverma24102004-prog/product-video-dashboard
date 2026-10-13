import { useEffect, useMemo, useRef, useState } from 'react'
import { proxied, fileToDataUrl } from './api.js'

const PLATFORM = { instagram: 'Instagram Reels', meta: 'Meta Ad Library', tiktok: 'TikTok (beta)' }
const BADGE = { instagram: 'Reel', meta: 'Meta Ad', tiktok: 'TikTok' }
const STAGES = [
  ['product', 'Fetching product'],
  ['brain', 'Analysing image'],
  ['instagram', 'Searching Instagram'],
  ['meta', 'Searching Meta'],
  ['tiktok', 'Searching TikTok', true],
  ['scoring', 'Scoring & saving'],
]

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const scoreTone = (s, below) => (below ? 'low' : s >= 75 ? 'high' : 'mid')

export function StatusBar({ health }) {
  if (!health) return <div className="status-bar muted">Connecting to backend…</div>
  const ig = health.instagram
  return (
    <div className="status-bar">
      <span className={`chip ${ig.configured ? 'ok' : 'bad'}`} title={ig.configured ? `Pages used today: ${ig.pagesUsedToday}/${ig.dailyCap}` : ''}>
        Instagram: {ig.configured ? `session ready (${ig.method})` : 'no session, run npm run ig:login'}
      </span>
      <span className={`chip ${health.vision.gemini ? 'ok' : 'warn'}`}>
        Vision: {health.vision.gemini ? `Gemini (${health.vision.model}) + CLIP` : 'CLIP only (no GEMINI_API_KEY)'}
      </span>
      <span className="chip">Match threshold {health.threshold}</span>
    </div>
  )
}

export function SearchForm({ onSubmit, busy }) {
  const [input, setInput] = useState('')
  const [image, setImage] = useState(null)
  const [preview, setPreview] = useState('')
  const [dragging, setDragging] = useState(false)
  const [showSeen, setShowSeen] = useState(false)
  const [tiktok, setTiktok] = useState(false)
  const [err, setErr] = useState('')
  const dragDepth = useRef(0)
  const isUrl = /^https?:\/\//i.test(input.trim())

  useEffect(() => {
    if (!image) return setPreview('')
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  function takeFile(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) return setErr('That file is not an image. Drop a JPG, PNG or WebP.')
    if (file.size > 8 * 1024 * 1024) return setErr('Image must be under 8 MB.')
    setErr('')
    setImage(file)
  }

  const dragProps = {
    onDragEnter: (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (e) => {
      if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    },
    onDrop: (e) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      takeFile(e.dataTransfer.files?.[0])
    },
    onPaste: (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'))
      if (file) {
        e.preventDefault()
        takeFile(file)
      }
    },
  }

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (input.trim().length < 2 && !image) return setErr('Type a product name, paste a product link, or drop a product image.')
    const imageBase64 = image ? await fileToDataUrl(image) : undefined
    onSubmit({ input: input.trim(), imageBase64, options: { showSeen, tiktok } })
  }

  return (
    <form className={`search ${dragging ? 'dragging' : ''}`} onSubmit={submit} {...dragProps}>
      <div className="search-row">
        <input
          className="search-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={image ? 'Optional: product name or link (the image alone works too)' : 'Product name, product URL, or drop / paste an image'}
          aria-label="Product name or URL"
        />
        <button className="btn primary" disabled={busy}>{busy ? 'Searching…' : 'Find videos'}</button>
      </div>
      <div className="search-opts">
        <span className="pill">{input.trim() ? (isUrl ? 'Product link' : 'Keyword') : image ? 'Image only' : 'Name, link or image'}</span>
        {image ? (
          <span className="chosen">
            <img src={preview} alt="" />
            <span className="chosen-name">{image.name || 'pasted image'}</span>
            <button type="button" className="link" onClick={() => setImage(null)}>remove</button>
          </span>
        ) : (
          <label className="file">
            <input type="file" accept="image/*" onChange={(e) => takeFile(e.target.files?.[0])} />
            + Product image (or drag &amp; drop / Ctrl+V)
          </label>
        )}
        <label className="toggle">
          <input type="checkbox" checked={showSeen} onChange={(e) => setShowSeen(e.target.checked)} /> Show previously seen
        </label>
        <label className="toggle" title="Optional extra source. Runs alongside Instagram and Meta and never blocks them.">
          <input type="checkbox" checked={tiktok} onChange={(e) => setTiktok(e.target.checked)} /> Include TikTok (beta)
        </label>
      </div>
      {dragging && <div className="drop-overlay">Drop the product image here</div>}
      {err && <p className="form-err">{err}</p>}
    </form>
  )
}

export function Progress({ events, status, reconnecting = false }) {
  const byStage = useMemo(() => {
    const m = {}
    for (const ev of events) m[ev.stage] = ev
    return m
  }, [events])
  const last = events[events.length - 1]
  const finished = status === 'done' || status === 'error' || status === 'needs_hint'
  return (
    <section className="card progress">
      <ol className="stages">
        {STAGES.filter(([key, , optional]) => !optional || byStage[key]).map(([key, label]) => {
          const ev = byStage[key]
          const state = !ev ? (finished ? 'skip' : 'idle') : ev.status === 'error' ? 'error' : ev.status === 'warn' ? 'warn'
            : ev.status === 'done' || finished ? 'done' : 'active'
          return (
            <li key={key} className={`stage ${state}`}>
              <span className="dot" />
              <span>{label}</span>
            </li>
          )
        })}
      </ol>
      {last && <p className={`progress-msg ${last.status}`}>{last.message}</p>}
      {reconnecting && <p className="progress-msg warn small" role="status">Connection lost — reconnecting…</p>}
      <details className="log">
        <summary>Pipeline log ({events.length})</summary>
        <ul>
          {events.map((e, i) => (
            <li key={i}><time>{new Date(e.t).toLocaleTimeString()}</time> <b>{e.stage}</b> {e.message}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}

/** Shown when the photo alone is ambiguous (e.g. a scoop of powder): pick a guess or type the name, same image is reused. */
export function IdentifyProduct({ product, canRetry, onPick }) {
  const [name, setName] = useState('')
  const guesses = product.guesses || []
  return (
    <section className="card identify">
      {product.imageDataUrl && <img className="product-img" src={product.imageDataUrl} alt="" />}
      <div className="product-body">
        <h2>What is this product?</h2>
        <p className="muted">
          The photo alone could be several different products, so searching now would risk matching the wrong thing.
          Tell us what it is and the same photo will be used to match the exact look.
        </p>
        {canRetry ? (
          <>
            {guesses.length > 0 && (
              <div className="guesses">
                {guesses.map((g) => <button key={g} className="btn" onClick={() => onPick(g)}>{g}</button>)}
              </div>
            )}
            <form className="search-row" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) onPick(name.trim()) }}>
              <input className="search-input" value={name} onChange={(e) => setName(e.target.value)}
                placeholder='Or type it, e.g. "MuscleBlaze whey protein chocolate"' aria-label="Product name" />
              <button className="btn primary">Search with this name</button>
            </form>
          </>
        ) : (
          <p className="small">
            {guesses.length > 0 && <>Possible matches: <b>{guesses.join(', ')}</b>. </>}
            Type the product name in the search bar above, re-add the photo, and search again.
          </p>
        )}
      </div>
    </section>
  )
}

function AttrRow({ label, values }) {
  const list = [].concat(values || []).filter(Boolean)
  if (!list.length) return null
  return (
    <div className="attr">
      <dt>{label}</dt>
      <dd>{list.map((v) => <span key={v} className="tag">{v}</span>)}</dd>
    </div>
  )
}

const BRAND_SOURCE = {
  page: 'from the product page',
  named: 'as you typed it',
  visible: 'logo readable in the photo',
  inferred: 'inferred from the design (not verified)',
}

/** Verified identity vs visual resemblance, stated plainly so the UI never over-claims. */
function IdentityLine({ identity }) {
  if (!identity) return null
  const tone = identity.verified ? 'ok' : identity.brandKnown ? 'warn' : 'muted'
  return (
    <p className={`identity ${tone}`}>
      <b>Identity:</b>{' '}
      {identity.brandKnown ? <>{identity.brand} {identity.model && <>· {identity.model} </>}({BRAND_SOURCE[identity.brandSource] ?? identity.brandSource})</>
        : <>brand unknown, so results are matched on visual resemblance only and are not a verified brand/model</>}
    </p>
  )
}

export function ProductPanel({ product }) {
  if (!product) return null
  const a = product.attributes || {}
  return (
    <section className="card product">
      {product.imageDataUrl ? <img className="product-img" src={product.imageDataUrl} alt="" />
        : <div className="product-img placeholder">No image<br /><small>text-only matching</small></div>}
      <div className="product-body">
        <h2>{product.title}</h2>
        {product.url && <a className="muted small" href={product.url} target="_blank" rel="noreferrer">{product.url}</a>}
        {product.description && <p className="desc">{product.description}</p>}
        <IdentityLine identity={product.identity} />
        <dl className="attrs">
          <AttrRow label="Type" values={a.productType} />
          <AttrRow label="Distinctive" values={a.distinctiveFeatures} />
          <AttrRow label="Colours" values={a.colors} />
          <AttrRow label="Prints" values={a.prints} />
          <AttrRow label="Logos" values={a.logos} />
          <AttrRow label="Text" values={a.textOnProduct} />
          <AttrRow label="Material" values={a.material} />
          <AttrRow label="Shape" values={a.shape} />
          <AttrRow label="Hashtags" values={(a.hashtags || []).map((h) => `#${h}`)} />
        </dl>
        <p className="muted small">
          Analysis: {a.source === 'gemini' ? 'Gemini vision' : a.source === 'gemini-text' ? 'Gemini (from product name, no photo)' : 'keyword heuristics'}
          {a.correctedName && a.correctedName.toLowerCase() !== product.title.toLowerCase() && <> · interpreted as <b>{a.correctedName}</b></>}
          {' · '}matching against {product.referenceMode === 'image' ? 'product photo' : 'text description, so add a photo for exact-product matching'}
        </p>
      </div>
    </section>
  )
}

function VideoCard({ v, onStar }) {
  const [playing, setPlaying] = useState(false)
  const [thumbSrc, setThumbSrc] = useState(v.thumb)
  const [videoFailed, setVideoFailed] = useState(false)
  return (
    <article className={`video ${v.below ? 'is-below' : ''}`}>
      <div className="media">
        {playing && v.mediaUrl && !videoFailed ? (
          <video src={v.mediaUrl} controls autoPlay playsInline onError={() => setVideoFailed(true)} />
        ) : (
          <button className="thumb" onClick={() => (v.mediaUrl ? setPlaying(true) : window.open(v.url, '_blank', 'noopener'))}
            aria-label="Play video">
            <img src={thumbSrc} alt="" loading="lazy"
              onError={() => thumbSrc === v.thumb && setThumbSrc(proxied(v.thumb))} />
            <span className="play">▶</span>
          </button>
        )}
        <span className={`badge platform ${v.platform}`}>{BADGE[v.platform] ?? v.platform}</span>
        <span className={`badge score ${scoreTone(v.score, v.below)}`} title={`CLIP ${v.clip ?? '–'} · Vision ${v.vlm ?? '–'}`}>{v.score}</span>
      </div>
      <div className="video-body">
        <p className="reason">{v.below && <b>Below threshold · </b>}{v.reason}</p>
        {v.caption && <p className="caption">{v.caption}</p>}
        <div className="meta-row">
          <span>{v.author && `@${v.author}`}</span>
          <span>{fmtDate(v.postedAt)}</span>
        </div>
        <div className="meta-row">
          <a href={v.url} target="_blank" rel="noreferrer">Open original ↗</a>
          {v.seenBefore && <span className="tag">seen before</span>}
          <button className={`star ${v.starred ? 'on' : ''}`} onClick={() => onStar(v)} aria-label="Shortlist">
            {v.starred ? '★' : '☆'}
          </button>
        </div>
        {videoFailed && <p className="small muted">Inline playback expired. Use "Open original".</p>}
      </div>
    </article>
  )
}

const VISION_WHY = {
  quota: 'the Gemini API quota is exhausted (429)',
  rate_limit: 'Gemini rate-limited the requests (429)',
  server: 'Gemini servers were overloaded or unreachable (5xx / network / timeout)',
  auth: 'Gemini rejected the API key or project (check GEMINI_API_KEY in backend/.env)',
  budget: 'the per-search Gemini call budget (GEMINI_MAX_CALLS_PER_SEARCH) was used up',
  deadline: 'the search time limit was reached',
  model_not_found: 'none of the configured Gemini models exist (check GEMINI_MODEL)',
  error: 'some vision requests failed',
  no_key: 'no GEMINI_API_KEY is configured',
}

/** Says plainly when scores are CLIP-only (and why), and when the search was cut short by its time limit. */
function SearchLimitsNotice({ stats }) {
  const v = stats.vision
  const visionOff = v && v.status !== 'ok'
  if (!visionOff && !stats.deadlineReached) return null
  return (
    <div className="notice warn">
      {visionOff && (
        <>
          <b>{v.status === 'disabled' ? 'Vision scoring is off: CLIP-only scores' : 'Vision scoring fell back to CLIP-only'}</b>
          <p className="small">
            Because {VISION_WHY[v.reason] || v.reason || 'the vision model was unavailable'}
            {v.status !== 'disabled' && ` after ${v.calls}/${v.budget} Gemini calls`}.{' '}
            {v.clipOnly} of {v.clipOnly + v.judged} videos were scored by CLIP image similarity (plus caption keywords) without a vision verdict, so treat those scores as rougher.
          </p>
        </>
      )}
      {stats.deadlineReached && (
        <p className="small">
          <b>Search time limit reached</b>{stats.deadlineMs ? ` (${Math.round(stats.deadlineMs / 1000)}s)` : ''}: no further queries were run, so a source may have fewer videos than the target.
        </p>
      )}
    </div>
  )
}

export function Results({ search, onStar }) {
  const [tab, setTab] = useState('instagram')
  const [sort, setSort] = useState('score')
  const [minScore, setMinScore] = useState(0)
  const [showBelow, setShowBelow] = useState(false)
  const stats = search.stats || {}
  const target = stats[tab]?.target ?? 20

  // TikTok is an optional source: its tab only appears when the search included it
  const platforms = stats.tiktok || search.results.some((v) => v.platform === 'tiktok') ? ['instagram', 'meta', 'tiktok'] : ['instagram', 'meta']
  const counts = useMemo(() => {
    const c = {}
    for (const p of ['instagram', 'meta', 'tiktok']) c[p] = search.results.filter((v) => v.platform === p && !v.below).length
    return c
  }, [search.results])

  const list = useMemo(() => {
    let l = search.results.filter((v) => v.platform === tab && v.score >= minScore && (showBelow || !v.below))
    l = [...l].sort((a, b) => (sort === 'newest' ? (b.postedAt || 0) - (a.postedAt || 0) : b.score - a.score))
    return l
  }, [search.results, tab, sort, minScore, showBelow])

  const s = stats[tab]
  const belowCount = search.results.filter((v) => v.platform === tab && v.below).length

  return (
    <section className="results">
      <SearchLimitsNotice stats={stats} />
      <div className="tabs" role="tablist">
        {platforms.map((p) => (
          <button key={p} role="tab" aria-selected={tab === p} className={`tab ${tab === p ? 'active' : ''}`} onClick={() => setTab(p)}>
            {PLATFORM[p]}
            {stats[p]?.optional
              ? <span className="count optional" title="Optional source: no minimum">{counts[p]}</span>
              : <span className={`count ${counts[p] >= (stats[p]?.target ?? 20) ? 'met' : 'short'}`}>{counts[p]}/{stats[p]?.target ?? 20}</span>}
          </button>
        ))}
      </div>

      {s && (s.error || s.shortfall > 0) && (
        <div className={`notice ${s.error && !s.optional ? 'error' : 'warn'}`}>
          <b>{s.error ? `${PLATFORM[tab]} ${s.optional ? 'unavailable (optional source, other results unaffected)' : 'failed'}` : s.optional ? `${s.usable} matching TikTok videos (optional source, no minimum)` : `Shortfall: ${s.usable}/${target} matching videos`}</b>
          <ul>{(s.notes || []).slice(-4).map((n, i) => <li key={i}>{n}</li>)}</ul>
          <p className="small">
            {s.error?.includes('ig:login')
              ? 'Fix: in backend/, run "npm run ig:login", log in, then search again.'
              : s.optional
              ? 'TikTok is a best-effort bonus source: it may show a captcha, ask for a login, or be blocked in some regions.'
              : 'Try: a shorter or more generic product name, uploading a clearer product photo, or "Show previously seen".'}
          </p>
        </div>
      )}

      <div className="controls">
        <label>Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="score">Match score</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
        <label>Min score {minScore}
          <input type="range" min="0" max="100" step="5" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showBelow} onChange={(e) => setShowBelow(e.target.checked)} /> Show below-threshold ({belowCount})
        </label>
        {s && (
          <span className="muted small">
            Queries: {s.queriesTried?.join(', ') || '–'}
            {Object.keys(s.dropped || {}).length > 0 && ` · filtered: ${Object.entries(s.dropped).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}`}
          </span>
        )}
      </div>

      {list.length ? (
        <div className="grid">{list.map((v) => <VideoCard key={v.uid} v={v} onStar={onStar} />)}</div>
      ) : (
        <div className="empty">
          <p><b>No videos to show here.</b></p>
          <p className="muted">
            {search.results.some((v) => v.platform === tab) ? 'Lower the minimum score or enable "Show below-threshold".' : 'This source returned nothing for the product. See the notice above for why.'}
          </p>
        </div>
      )}
    </section>
  )
}

export function History({ items, activeId, onOpen }) {
  if (!items.length) return <p className="muted small pad">No searches yet.</p>
  return (
    <ul className="history">
      {items.map((h) => (
        <li key={h.id}>
          <button className={`history-item ${h.id === activeId ? 'active' : ''}`} onClick={() => onOpen(h.id)}>
            <span className="h-title">{h.product?.title || h.input}</span>
            <span className="h-meta">
              <span className={`dotlet ${h.status}`} />
              {h.status === 'done' ? `${h.stats?.instagram?.usable ?? 0} IG · ${h.stats?.meta?.usable ?? 0} Meta${h.stats?.tiktok ? ` · ${h.stats.tiktok.usable ?? 0} TikTok` : ''}` : h.status === 'needs_hint' ? 'needs product name' : h.status}
              {' · '}{new Date(h.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
