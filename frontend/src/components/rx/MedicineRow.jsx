'use client'
import { useState } from 'react'
import { Trash2, Star } from 'lucide-react'
import { toggleFavourite, isFavourite } from '../../../lib/rxStorage'

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

export default function MedicineRow({ medicine, doctorId='dr001', onChange, onRemove }) {
  const [fav, setFav] = useState(()=>isFavourite(doctorId, medicine.id))
  const upd = (f,v) => onChange({ ...medicine, [f]:v })

  function handleFav() { const added = toggleFavourite(doctorId, medicine); setFav(added) }

  return (
    <div style={{ padding:'12px 14px', borderBottom:`1px solid ${C.border}`, background:'#fff' }}>

      {/* Top row: name + brand + actions */}
      <div style={{ display:'flex', alignItems:'flex-start', gap:6, marginBottom:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <span style={{ fontSize:14, fontWeight:700, color:C.text }}>
            {medicine.brandName}{medicine.strength ? ` ${medicine.strength}` : ''}
          </span>
          {medicine.strengths?.length > 1 && (
            <select value={medicine.strength} onChange={e=>upd('strength',e.target.value)}
              style={{ marginLeft:6, fontSize:12, border:`1px solid ${C.border}`, borderRadius:4, padding:'1px 4px', cursor:'pointer', fontFamily:'inherit', color:C.text, background:C.bg }}>
              {medicine.strengths.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {medicine.genericName && (
            <span style={{ fontSize:12, color:C.muted, marginLeft:6 }}>({medicine.genericName} /)</span>
          )}
          {medicine.isCustom && (
            <span style={{ fontSize:10, background:'#EFF6FF', color:C.blue, padding:'1px 6px', borderRadius:4, marginLeft:6, fontWeight:600 }}>Custom</span>
          )}
          {medicine.validation_band === 'green' && (
            <span style={{ fontSize:10, background:'#DCFCE7', color:'#166534', border:'1px solid #BBF7D0', padding:'2px 8px', borderRadius:6, marginLeft:6, fontWeight:600, display:'inline-flex', alignItems:'center', gap:3 }}>
              ✓ Verified
            </span>
          )}
          {medicine.validation_band === 'yellow' && (
            <span style={{ fontSize:11, background:'#FEF3C7', color:'#92400E', border:'1px solid #FDE68A', padding:'2px 8px', borderRadius:6, marginLeft:6, fontWeight:600, display:'inline-flex', alignItems:'center', gap:5 }}>
              <span>Confirm: <strong>{medicine.matched_name}</strong></span>
              <button
                type="button"
                onClick={() => onChange({
                  ...medicine,
                  brandName: medicine.matched_name || medicine.brandName,
                  validation_band: 'green',
                  validation_status: 'verified',
                  doctor_confirmed: true,
                })}
                style={{
                  background: '#D97706', color: '#fff', border: 'none', borderRadius: 4,
                  padding: '1px 6px', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit'
                }}>
                Accept ✓
              </button>
            </span>
          )}
          {medicine.validation_band === 'red' && (
            medicine.doctor_confirmed ? (
              <span style={{ fontSize:10, background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'2px 8px', borderRadius:6, marginLeft:6, fontWeight:600 }}>
                ⚠ Unverified — confirmed as typed by doctor
              </span>
            ) : (
              <span style={{ fontSize:11, background:'#FEE2E2', color:'#991B1B', border:'1px solid #FECACA', padding:'2px 8px', borderRadius:6, marginLeft:6, fontWeight:600, display:'inline-flex', alignItems:'center', gap:5 }}>
                <span>⚠ Unverified</span>
                <button
                  type="button"
                  onClick={() => onChange({ ...medicine, doctor_confirmed: true })}
                  style={{
                    background: '#991B1B', color: '#fff', border: 'none', borderRadius: 4,
                    padding: '1px 6px', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit'
                  }}>
                  Confirm as typed ✓
                </button>
              </span>
            )
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
