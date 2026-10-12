'use client'
import { useState } from 'react'
import { Trash2, Star } from 'lucide-react'
import { toggleFavourite, isFavourite } from '../../../lib/rxStorage'
import DrugSearchInline from './DrugSearchInline'

const C = {
  text:   '#0F2342',
  muted:  '#6B7A9A',
  coral:  '#E84C3D',
  blue:   '#1A5CB5',
  border: '#E4E6EB',
  bg:     '#F8F9FA',
}

const DOSAGE_OPTIONS   = ['1-0-0','0-0-1','1-0-1','1-1-1','0-1-0','1-1-0','2-0-0','0-0-2','custom']
const TIMING_OPTIONS   = ['Before food','After food','Empty stomach','With food','Bedtime','Morning','SOS']
const DURATION_OPTIONS = ['1 day','3 days','5 days','7 days','10 days','15 days','1 month','Ongoing']

// Reasons where the chip must show brand only — no generic name alongside.
const BRAND_ONLY_REASONS = new Set(['strength_not_stated', 'multiple_forms'])

function FieldSelect({ label, value, options, onChange }) {
  const isCustom = value && !options.includes(value)
  return (
    <div>
      <div style={{ fontSize:10, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>{label}</div>
      <select
        value={isCustom ? 'custom' : (value||'')}
        onChange={e => {
          if (e.target.value === 'custom') return
          onChange(e.target.value)
        }}
        style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:6, padding:'6px 8px', fontSize:13, color:C.text, background:'#fff', outline:'none', cursor:'pointer', fontFamily:'inherit' }}>
        <option value="" disabled>Not stated</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
        {isCustom && <option value="custom">{value}</option>}
      </select>
    </div>
  )
}

// Clickable chips for `options` (strength/form choices) or `candidates` (similar
// brand names) — same shape once normalised: label text + optional generic name.
function OptionChips({ items, showGeneric, onPick }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {items.map((item, i) => {
        const label = item.label || item.name || ''
        const generic = item.generic_name
        return (
          <button
            key={`${item.cdci_code || label}-${i}`}
            type="button"
            onClick={() => onPick(item)}
            style={{
              background: '#fff', color: '#92400E', border: '1px solid #FDE68A',
              borderRadius: 999, padding: '4px 10px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
            }}>
            {label}{showGeneric && generic ? ` · ${generic}` : ''}
          </button>
        )
      })}
    </div>
  )
}

export default function MedicineRow({ medicine, doctorId='dr001', onChange, onRemove }) {
  const [fav, setFav] = useState(()=>isFavourite(doctorId, medicine.id))
  const upd = (f,v) => onChange({ ...medicine, [f]:v })

  function handleFav() { const added = toggleFavourite(doctorId, medicine); setFav(added) }

  function pickOption(item) {
    // Band stays yellow on purpose — picking a chip resolves the doctor's choice,
    // it doesn't erase the fact that the system was unsure (Fix Guide 3c).
    onChange({
      ...medicine,
      brandName: item.label || item.name || medicine.brandName,
      genericName: item.generic_name || medicine.genericName,
      cdci_code: item.cdci_code || medicine.cdci_code,
      doctor_confirmed: true,
    })
  }

  function pickFromSearch(result) {
    // A doctor's own catalog pick is a confident, verified choice.
    onChange({
      ...medicine,
      brandName: result.label,
      genericName: result.generic_name || '',
      cdci_code: result.cdci_code || null,
      validation_band: 'green',
      validation_status: 'verified',
      validation_reason: 'doctor_search',
      doctor_confirmed: true,
      source: 'search',
    })
  }

  const band = medicine.validation_band
  const reason = medicine.validation_reason
  const chipSource = medicine.options?.length ? medicine.options : medicine.candidates
  const showGenericInChips = !BRAND_ONLY_REASONS.has(reason)

  return (
    <div style={{ padding:'12px 14px', borderBottom:`1px solid ${C.border}`, background:'#fff' }}>

      {/* Top row: name + brand + actions */}
      <div style={{ display:'flex', alignItems:'flex-start', gap:6, marginBottom:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {/* Name + strength — always editable, including green/verified rows */}
            <input
              value={medicine.brandName || ''}
              onChange={e => upd('brandName', e.target.value)}
              placeholder="Medicine name"
              style={{
                fontSize: 14, fontWeight: 700, color: C.text, border: 'none', outline: 'none',
                background: 'transparent', fontFamily: 'inherit', minWidth: 120, flex: '0 1 auto',
                borderBottom: '1px dashed transparent',
              }}
              onFocus={e => e.target.style.borderBottom = `1px dashed ${C.border}`}
              onBlur={e => e.target.style.borderBottom = '1px dashed transparent'}
            />
            {medicine.strengths?.length > 1 && (
              <select value={medicine.strength} onChange={e=>upd('strength',e.target.value)}
                style={{ fontSize:12, border:`1px solid ${C.border}`, borderRadius:4, padding:'1px 4px', cursor:'pointer', fontFamily:'inherit', color:C.text, background:C.bg }}>
                {medicine.strengths.map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {medicine.genericName && (
              <span style={{ fontSize:12, color:C.muted }}>({medicine.genericName})</span>
            )}
            {medicine.isCustom && (
              <span style={{ fontSize:10, background:'#EFF6FF', color:C.blue, padding:'1px 6px', borderRadius:4, fontWeight:600 }}>Custom</span>
            )}

            {/* Band badge */}
            {band === 'green' && (
              <span style={{ fontSize:10, background:'#DCFCE7', color:'#166534', border:'1px solid #BBF7D0', padding:'2px 8px', borderRadius:6, fontWeight:600, display:'inline-flex', alignItems:'center', gap:3 }}>
                ✓ Verified
              </span>
            )}
            {band === 'yellow' && (
              <span style={{ fontSize:10, background:'#FEF3C7', color:'#92400E', border:'1px solid #FDE68A', padding:'2px 8px', borderRadius:6, fontWeight:600 }}>
                {medicine.doctor_confirmed ? '⚠ Confirmed by doctor' : '⚠ Needs confirmation'}
              </span>
            )}
            {band === 'red' && (
              <span style={{ fontSize:10, background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'2px 8px', borderRadius:6, fontWeight:600 }}>
                {medicine.doctor_confirmed ? '⚠ Confirmed as typed' : '⚠ Unverified'}
              </span>
            )}
          </div>

          {/* ── Yellow: generic_spoken — keep as generic, or search for a brand ── */}
          {band === 'yellow' && reason === 'generic_spoken' && !medicine.doctor_confirmed && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                Doctor ne generic bola: <strong>{medicine.spoken_name || medicine.brandName}</strong>. Generic rakhein, ya brand search karein.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => onChange({ ...medicine, doctor_confirmed: true })}
                  style={{ background: '#D97706', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
                  Generic hi rakhein ✓
                </button>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <DrugSearchInline onSelect={pickFromSearch} placeholder="Ya brand search karein…" />
                </div>
              </div>
            </div>
          )}

          {/* ── Yellow: strength/form/related-brand/candidate choices as chips ── */}
          {band === 'yellow' && reason !== 'generic_spoken' && !medicine.doctor_confirmed && (
            <div style={{ marginTop: 6 }}>
              {medicine.spoken_name && (
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>
                  Doctor ne bola: <strong>{medicine.spoken_name}</strong>
                </div>
              )}
              <OptionChips items={chipSource} showGeneric={showGenericInChips} onPick={pickOption} />
              {!chipSource?.length && (
                <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic' }}>No suggestions — type the correct name above and confirm.</div>
              )}
            </div>
          )}

          {/* ── Red: spoken text + real CDCI search ── */}
          {band === 'red' && !medicine.doctor_confirmed && (
            <div style={{ marginTop: 8 }}>
              {medicine.spoken_name && (
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                  Doctor ne bola: <strong>{medicine.spoken_name}</strong> — koi confident match nahi mila.
                </div>
              )}
              <DrugSearchInline onSelect={pickFromSearch} />
            </div>
          )}
        </div>
        <button onClick={handleFav} title={fav?'Remove fav':'Add fav'}
          style={{ background:'none', border:'none', cursor:'pointer', padding:'2px 4px', flexShrink:0 }}>
          <Star size={14} fill={fav?C.coral:'none'} color={fav?C.coral:C.muted}/>
        </button>
        <button onClick={onRemove}
          style={{ background:'none', border:'none', cursor:'pointer', padding:'2px 4px', flexShrink:0 }}>
          <Trash2 size={13} color={C.muted}/>
        </button>
      </div>

      {/* Dosage / Timing / Duration — 3-column grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
        <FieldSelect label="Dosage"   value={medicine.dosage}   options={DOSAGE_OPTIONS}   onChange={v=>upd('dosage',v)}/>
        <FieldSelect label="Timing"   value={medicine.timing}   options={TIMING_OPTIONS}   onChange={v=>upd('timing',v)}/>
        <FieldSelect label="Duration" value={medicine.duration} options={DURATION_OPTIONS} onChange={v=>upd('duration',v)}/>
      </div>

      {/* Notes in blue (e.g. "Doctor's usual for Viral Fever") */}
      {medicine.notes && (
        <div style={{ marginTop:8, fontSize:11, color:C.blue, fontStyle:'italic' }}>
          ℹ {medicine.notes}
        </div>
      )}
    </div>
  )
}
