'use client'
import { useState, useRef, useEffect } from 'react'
import { Search } from 'lucide-react'
import api from '../../services/api'

const C = { text: '#0F2342', muted: '#6B7A9A', border: '#E4E6EB' }

/** Inline CDCI drug search for red/generic_spoken medicine rows — hits the real
 * GET /drugs/search endpoint (never the static local list) so a doctor's manual
 * pick here is a genuine catalog match, not a guess. */
export default function DrugSearchInline({ onSelect, placeholder = 'Search medicine (CDCI)…' }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    const term = q.trim()
    timer.current = setTimeout(async () => {
      if (term.length < 2) { setResults([]); setOpen(false); return }
      setLoading(true)
      try {
        const res = await api.get(`/drugs/search?q=${encodeURIComponent(term)}`)
        setResults(res?.results || [])
        setOpen(true)
      } catch {
        setResults([])
        setOpen(true)
      } finally {
        setLoading(false)
      }
    }, term.length < 2 ? 0 : 300)
    return () => clearTimeout(timer.current)
  }, [q])

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  function pick(r) {
    onSelect(r)
    setQ(''); setResults([]); setOpen(false)
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 8px', background: '#fff' }}>
        <Search size={12} color={C.muted} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={placeholder}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit', padding: '5px 0', color: C.text, background: 'transparent' }}
        />
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, zIndex: 50, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 6px 16px rgba(0,0,0,.12)', maxHeight: 220, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 8, fontSize: 11, color: C.muted }}>Searching…</div>}
          {!loading && results.length === 0 && <div style={{ padding: 8, fontSize: 11, color: C.muted }}>No matches</div>}
          {!loading && results.map((r, i) => (
            <button key={`${r.cdci_code || r.label}-${i}`} type="button" onClick={() => pick(r)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontWeight: 600, color: C.text }}>{r.label}</div>
              {r.generic_name && <div style={{ fontSize: 10, color: C.muted }}>{r.generic_name}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
