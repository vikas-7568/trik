'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Plus, X, Clock, User, AlertTriangle, CheckCircle, Printer, MessageCircle, Mic, ChevronDown, Bookmark, ArrowLeft } from 'lucide-react'
import { initDemoDataIfNeeded, getClinicConfig, getPatient, searchPatients, savePatient, savePrescription, finalizePrescription, saveCustomMedicine, getPatientPrescriptions, getQueueEntry, advanceQueue, getPendingReviews, resolveReview, getSlotsState, getNextWaiting, updateAppointmentStatus, markAsAwaitingReports } from '../../../../lib/rxStorage'
import { addReviewEntry } from '../../../../lib/reviews'
import { getCabinSettings, persistActiveSlot } from '../../../../lib/cabinSettings'
import { buildWhatsAppMessage } from '../../../../lib/whatsappMessage'
import { COMMON_DIAGNOSES, QUICK_SYMPTOMS, COMMON_TESTS, QUICK_INSTRUCTIONS_EN, QUICK_INSTRUCTIONS_HI } from '../../../../lib/mockData'
import { Button } from '../../../components/ui/Button'
import MedicineSearch from '../../../components/rx/MedicineSearch'
import MedicineRow from '../../../components/rx/MedicineRow'
import AiSuggestionsPanel from '../../../components/rx/AiSuggestionsPanel'
import VitalsSection from '../../../components/rx/VitalsSection'
import VoiceButton from '../../../components/rx/VoiceButton'
import api from '../../../services/api'

const C = {
  page:   '#F4F5F7',
  card:   '#FFFFFF',
  border: '#E4E6EB',
  text:   '#0F2342',
  muted:  '#6B7A9A',
  coral:  '#E84C3D',
  blue:   '#1A5CB5',
  green:  '#16A34A',
  amber:  '#D97706',
  surface:'#F8F9FA',
}

function initials(name='') { return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)||'?' }
function elapsed(start) {
  const s = Math.floor((Date.now()-start)/1000)
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`
}
function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})
}

// ── Diagnosis input — pill display + dropdown ────────────────────────────────
function DiagnosisInput({ values, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => { if (open) setTimeout(()=>inputRef.current?.focus(), 50) }, [open])

  const filtered = COMMON_DIAGNOSES
    .filter(d => d.toLowerCase().includes(q.toLowerCase()) && !values.includes(d))
    .slice(0, 8)

  function add(d) { if (!values.includes(d)) onChange([...values, d]); setQ('') }
  function addRaw() { if (q.trim() && !values.includes(q.trim())) { onChange([...values, q.trim()]); setQ('') } }
  function remove(d) { onChange(values.filter(v => v !== d)) }

  return (
    <div ref={ref} style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center', position:'relative' }}>
      {values.map(d => (
        <span key={d} style={{ display:'inline-flex', alignItems:'center', gap:4, background:C.coral, color:'#fff', borderRadius:8, padding:'4px 12px 4px 12px', fontSize:13, fontWeight:600 }}>
          {d}
          <button type="button" aria-label={`Remove diagnosis ${d}`} onClick={()=>remove(d)} style={{ background:'none', border:'none', cursor:'pointer', padding:0, display:'flex', color:'rgba(255,255,255,.8)', marginLeft:2 }}><X size={11}/></button>
        </span>
      ))}
      <button onClick={()=>setOpen(o=>!o)}
        style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 12px', border:`1.5px dashed ${C.muted}`, borderRadius:8, background:'#fff', cursor:'pointer', fontSize:12, color:C.muted, fontFamily:'inherit' }}>
        <Plus size={11}/>Add
      </button>
      {open && (
        <div style={{ position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:300, background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,.12)', width:280, overflow:'hidden' }}>
          <div style={{ padding:'8px 10px', borderBottom:`1px solid ${C.border}` }}>
            <input ref={inputRef} value={q} onChange={e=>setQ(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter'){e.preventDefault();addRaw()} if(e.key==='Escape')setOpen(false) }}
              placeholder="Search or type diagnosis…"
              style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:6, padding:'6px 8px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}/>
          </div>
          <div style={{ maxHeight:200, overflowY:'auto' }}>
            {filtered.length > 0 ? filtered.map(d=>(
              <button key={d} onClick={()=>{ add(d); setOpen(false) }}
                style={{ display:'block', width:'100%', padding:'8px 12px', border:'none', background:'none', textAlign:'left', cursor:'pointer', fontSize:13, color:C.text, borderBottom:`1px solid ${C.border}` }}
                onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                onMouseLeave={e=>e.currentTarget.style.background='none'}>
                {d}
              </button>
            )) : (
              <div style={{ padding:'10px 12px', fontSize:12, color:C.muted }}>
                {q ? `Press Enter to add "${q}"` : 'Type to search…'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Custom Medicine Modal ────────────────────────────────────────────────────
function CustomMedicineModal({ doctorId, onSave, onClose }) {
  const [form, setForm] = useState({ brandName:'', genericName:'', strength:'', form:'Tablet', category:'Other', defaultDosage:'1-0-1', defaultTiming:'After food', defaultDuration:'5 days' })
  const upd = (k,v) => setForm(f=>({...f,[k]:v}))
  function handleSave() {
    if (!form.brandName.trim()) return
    const med = saveCustomMedicine(doctorId, form)
    onSave({ id:med.id, brandName:med.brandName, genericName:med.genericName, strength:med.strength||'', strengths:med.strength?[med.strength]:[], form:med.form, dosage:med.defaultDosage, timing:med.defaultTiming, duration:med.defaultDuration, notes:'', isCustom:true })
    onClose()
  }
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,66,.45)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth:440, boxShadow:'0 12px 40px rgba(15,35,66,.18)' }}>
        <div style={{ fontWeight:700, fontSize:16, color:C.text, marginBottom:16 }}>Add Custom Medicine</div>
        {[['Brand Name *','brandName'],['Generic Name','genericName'],['Strength','strength']].map(([lbl,key])=>(
          <div key={key} style={{ marginBottom:10 }}>
            <label style={{ fontSize:12, color:C.muted, display:'block', marginBottom:3 }}>{lbl}</label>
            <input value={form[key]} onChange={e=>upd(key,e.target.value)} style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:14, outline:'none', boxSizing:'border-box', fontFamily:'inherit' }}/>
          </div>
        ))}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
          {[['Form','form',['Tablet','Capsule','Syrup','Injection','Drops','Cream','Inhaler','Powder']],['Category','category',['Antibiotic','Analgesic','Antihypertensive','Antidiabetic','Antacid','Antihistamine','Vitamin','Antifungal','Other']]].map(([lbl,k,opts])=>(
            <div key={k}>
              <label style={{ fontSize:12, color:C.muted, display:'block', marginBottom:3 }}>{lbl}</label>
              <select value={form[k]} onChange={e=>upd(k,e.target.value)} style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:13, fontFamily:'inherit' }}>
                {opts.map(o=><option key={o}>{o}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:16 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Add Medicine</Button>
        </div>
      </div>
    </div>
  )
}

// ── Patient Search ───────────────────────────────────────────────────────────
function PatientSelector({ onSelect }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  function handleSearch(val) {
    setQ(val)
    if (val.length >= 2) { setResults(searchPatients(val)); setOpen(true) }
    else { setResults([]); setOpen(false) }
  }
  function pick(pt) { onSelect(pt); setQ(''); setOpen(false) }

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, border:`1.5px solid ${C.coral}`, borderRadius:8, padding:'0 12px', background:'#fff' }}>
        <Search size={15} color={C.coral}/>
        <input value={q} onChange={e=>handleSearch(e.target.value)} placeholder="Search patient by name or phone…"
          style={{ flex:1, border:'none', outline:'none', background:'transparent', fontSize:14, color:C.text, padding:'11px 0', fontFamily:'inherit' }}/>
      </div>
      {open && results.length > 0 && (
        <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, right:0, zIndex:200, background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,.12)', maxHeight:260, overflowY:'auto' }}>
          {results.map(pt=>(
            <button key={pt.id} onClick={()=>pick(pt)}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%', padding:'10px 12px', border:'none', background:'none', cursor:'pointer', textAlign:'left', borderBottom:`1px solid ${C.border}` }}
              onMouseEnter={e=>e.currentTarget.style.background=C.surface}
              onMouseLeave={e=>e.currentTarget.style.background='none'}>
              <div style={{ width:32, height:32, borderRadius:'50%', background:C.text, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <span style={{ color:'#fff', fontSize:11, fontWeight:700 }}>{initials(pt.name)}</span>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{pt.name}</div>
                <div style={{ fontSize:11, color:C.muted }}>{pt.age&&`${pt.age} yrs`} {pt.gender&&`· ${pt.gender}`} {pt.phone&&`· ${pt.phone}`}</div>
              </div>
              {pt.allergies?.length>0 && <span style={{ fontSize:10, background:'#FEE2E2', color:'#991B1B', padding:'2px 6px', borderRadius:4 }}>⚠ Allergy</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Empty-state: Search existing OR add a walk-in patient ────────────────────
function EmptyPatientPanel({ onSelect }) {
  const [tab, setTab] = useState('search') // 'search' | 'walkin'
  const [form, setForm] = useState({ name:'', age:'', gender:'Male', phone:'' })
  const [err, setErr] = useState('')

  function handleAdd(e) {
    e.preventDefault()
    if (!form.name.trim()) { setErr('Name is required'); return }
    const pt = savePatient({
      id: `p_walkin_${Date.now()}`,
      name: form.name.trim(),
      age: form.age ? Number(form.age) : null,
      gender: form.gender,
      phone: form.phone.trim(),
      email: '',
      abhaNumber: '',
      bloodGroup: '',
      allergies: [],
      chronicConditions: [],
      address: '',
      doctorNote: '',
      visitCount: 0,
    })
    onSelect(pt)
  }

  const tabStyle = (active) => ({
    flex: 1,
    padding: '8px 0',
    border: 'none',
    borderBottom: active ? `2px solid #0F2342` : '2px solid transparent',
    background: 'transparent',
    color: active ? '#0F2342' : '#9CA3AF',
    fontWeight: active ? 700 : 500,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all .15s',
  })

  return (
    <div style={{ maxWidth:520, margin:'48px auto', padding:'0 20px' }}>
      <div style={{ background:'#fff', borderRadius:14, border:'1px solid #D3D1C7', boxShadow:'0 4px 24px rgba(15,35,66,.07)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'20px 24px 0', borderBottom:'1px solid #F3F4F6' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:'#EFF6FF', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <User size={18} color='#0F2342'/>
            </div>
            <div>
              <div style={{ fontSize:15, fontWeight:700, color:'#0F2342' }}>Load Patient</div>
              <div style={{ fontSize:12, color:'#9CA3AF' }}>Search existing or register a walk-in</div>
            </div>
          </div>
          {/* Tabs */}
          <div style={{ display:'flex', gap:0 }}>
            <button style={tabStyle(tab==='search')} onClick={()=>setTab('search')}>🔍 Search patient</button>
            <button style={tabStyle(tab==='walkin')} onClick={()=>setTab('walkin')}>➕ New walk-in</button>
          </div>
        </div>

        <div style={{ padding:'20px 24px' }}>
          {tab === 'search' ? (
            <>
              <PatientSelector onSelect={onSelect}/>
              <div style={{ marginTop:14, display:'flex', flexWrap:'wrap', gap:8 }}>
                {/* Quick-pick demo patients */}
                {['Ramesh Verma','Sunita Devi','Aarav Singh','Meena Patel','Deepak Joshi'].map(name => (
                  <button key={name} onClick={()=>{
                    const results = searchPatients(name.split(' ')[0])
                    if (results[0]) onSelect(results[0])
                  }} style={{
                    padding:'5px 12px', borderRadius:8, border:'1px solid #D3D1C7',
                    fontSize:12, color:'#374151', background:'#F9FAFB',
                    cursor:'pointer', fontFamily:'inherit',
                  }}>{name}</button>
                ))}
              </div>
              <div style={{ marginTop:10, fontSize:11, color:'#9CA3AF' }}>
                Or click a quick-pick demo patient above.
              </div>
            </>
          ) : (
            <form onSubmit={handleAdd} style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {/* Name */}
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Patient Name *</label>
                <input value={form.name} onChange={e=>{ setForm(f=>({...f,name:e.target.value})); setErr('') }}
                  placeholder='e.g. Anjali Sharma'
                  style={{ width:'100%', border:'1.5px solid #D3D1C7', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box', color:'#0F2342' }}/>
                {err && <div style={{ fontSize:11, color:'#DC2626', marginTop:3 }}>{err}</div>}
              </div>

              {/* Age + Gender row */}
              <div style={{ display:'flex', gap:10 }}>
                <div style={{ flex:1 }}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Age (yrs)</label>
                  <input type='number' min='0' max='130' value={form.age} onChange={e=>setForm(f=>({...f,age:e.target.value}))}
                    placeholder='e.g. 35'
                    style={{ width:'100%', border:'1.5px solid #D3D1C7', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box', color:'#0F2342' }}/>
                </div>
                <div style={{ flex:1 }}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Gender</label>
                  <select value={form.gender} onChange={e=>setForm(f=>({...f,gender:e.target.value}))}
                    style={{ width:'100%', border:'1.5px solid #D3D1C7', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box', color:'#0F2342', background:'#fff' }}>
                    <option>Male</option>
                    <option>Female</option>
                    <option>Other</option>
                  </select>
                </div>
              </div>

              {/* Phone */}
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Phone number</label>
                <input type='tel' value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))}
                  placeholder='10-digit mobile'
                  style={{ width:'100%', border:'1.5px solid #D3D1C7', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box', color:'#0F2342' }}/>
              </div>

              <button type='submit' style={{
                marginTop:4, background:'#0F2342', color:'#fff', border:'none',
                borderRadius:12, padding:'10px 0', fontWeight:700, fontSize:14,
                cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center',
                justifyContent:'center', gap:6,
              }}>
                <Plus size={15}/> Start Consultation
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
export default function NewRx({ doctorId='dr001' }) {
  const router = useRouter()
  useEffect(() => { initDemoDataIfNeeded() }, [])

  const startTime = useRef(Date.now())
  const [, setTick] = useState(0)
  useEffect(() => { const t = setInterval(()=>setTick(v=>v+1),1000); return ()=>clearInterval(t) }, [])

  const [clinic, setClinic] = useState(null)
  useEffect(() => { setClinic(getClinicConfig()) }, [])

  // ── Parallel consult / multi-slot ────────────────────────────────────────────
  const { slots: maxSlots } = getCabinSettings()
  const parallelMode = maxSlots > 1

  const [activeSlot, setActiveSlotState] = useState('A')
  const [slotsState, setSlotsState]      = useState([])

  // Per-slot form state — saved/restored on slot switch
  const slotForms = useRef({ A: null, B: null, C: null })

  useEffect(() => {
    if (parallelMode) setSlotsState(getSlotsState(doctorId))
  }, [parallelMode, doctorId])

  const [patient, setPatient] = useState(null)
  const [pastVisits, setPastVisits] = useState([])
  const [queueEntry, setQueueEntry] = useState(null)
  const [, setStaffVitalsTime] = useState(null)

  // Build a patient object from queue/appointment data, falling back when no localStorage record
  function resolvePatient(q) {
    if (!q?.current?.patientId) return null
    const stored = getPatient(q.current.patientId)
    if (stored) return stored
    // Walk-in or API patient — construct minimal record from queue data
    return {
      id:               q.current.patientId,
      name:             q.current.patientName || 'Patient',
      phone:            q.current.patientPhone || '',
      age:              q.current.age || null,
      chronicConditions: [],
      allergies:        [],
      visitCount:       0,
      doctorNote:       null,
    }
  }

  // Initial load on mount
  useEffect(() => {
    const q = getQueueEntry(doctorId)
    setQueueEntry(q)
    const pt = resolvePatient(q)
    if (!pt) return
    setPatient(pt)
    if (q.staffVitals) { setVitals(q.staffVitals); setStaffVitalsTime(q.staffVitalsTime||null) }
  }, [doctorId])

  // Poll every 2.5s when cabin is idle — detects patient sent from queue screen
  useEffect(() => {
    if (patient) return // don't poll during active consultation
    const t = setInterval(() => {
      const q = getQueueEntry(doctorId)
      const pt = resolvePatient(q)
      if (!pt) return
      setQueueEntry(q)
      setPatient(pt)
      if (q.staffVitals) { setVitals(q.staffVitals); setStaffVitalsTime(q.staffVitalsTime||null) }
    }, 2500)
    return () => clearInterval(t)
  }, [patient, doctorId])

  useEffect(() => {
    if (!patient?.id) { setPastVisits([]); return }
    setPastVisits(getPatientPrescriptions(patient.id).slice(0,5))
  }, [patient?.id])

  // ── form state ──────────────────────────────────────────────────────────────
  const [vitals, setVitals] = useState({})
  const [symptoms, setSymptoms] = useState([])
  const [symptomText, setSymptomText] = useState('')
  const [diagnosis, setDiagnosis] = useState([])
  const [medicines, setMedicines] = useState([])
  const [tests, setTests] = useState([])
  const [instructionTags, setInstructionTags] = useState([])
  const [instructionFreeText, setInstructionFreeText] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [doctorNote, setDoctorNote] = useState('')
  const [aiExtractionWarnings, setAiExtractionWarnings] = useState([]) // dropped/unsupported items from voice extraction
  const [aiTranscript, setAiTranscript] = useState('') // last voice dictation transcript, shown for doctor cross-check

  // ── ui state ─────────────────────────────────────────────────────────────────
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [allergyAlert, setAllergyAlert] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [approvalResult, setApprovalResult] = useState(null) // { rx_token, approved_at } after End Consultation
  const [approvalError, setApprovalError] = useState(null) // backend rejected the approve call (e.g. non-doctor role)
  const [markingForReview, setMarkingForReview] = useState(false)
  const [reviewToast, setReviewToast] = useState(false)
  const [showTestDrop, setShowTestDrop] = useState(false)
  const [showMoreInstr, setShowMoreInstr] = useState(false)
  const testDropRef = useRef(null)

  // ── review queue ──────────────────────────────────────────────────────────
  const [pendingReviews, setPendingReviews] = useState([])
  const [showReviews, setShowReviews] = useState(false)
  const [reviewContext, setReviewContext] = useState(null)

  useEffect(() => { setPendingReviews(getPendingReviews()) }, [patient?.id])

  // close test dropdown on outside click
  useEffect(() => {
    const h = e => { if (testDropRef.current && !testDropRef.current.contains(e.target)) setShowTestDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // allergy check
  useEffect(() => {
    if (!patient?.allergies?.length||!medicines.length) { setAllergyAlert([]); return }
    const alerts = []
    medicines.forEach(m => {
      patient.allergies.forEach(a => {
        const a2=a.toLowerCase()
        if (m.brandName?.toLowerCase().includes(a2)||m.genericName?.toLowerCase().includes(a2))
          alerts.push(`${m.brandName} — possible allergy to ${a}`)
      })
    })
    setAllergyAlert(alerts)
  }, [medicines, patient])

  function openReview(review) {
    const pt = getPatient(review.patientId)
    if (!pt) return
    setShowReviews(false); setPatient(pt); resetForm(); setReviewContext(review)
  }

  function resetForm() {
    setVitals({}); setSymptoms([]); setSymptomText(''); setDiagnosis([])
    setMedicines([]); setTests([]); setInstructionTags([]); setInstructionFreeText(''); setFollowUp(''); setDoctorNote('')
    startTime.current = Date.now()
  }

  function selectPatient(pt) { setPatient(pt); resetForm() }

  // ── slot switching (parallel mode) ────────────────────────────────────────────

  // Save current form to slot memory
  function captureSlotForm(slot) {
    slotForms.current[slot] = {
      patient, vitals, symptoms, symptomText, diagnosis, medicines,
      tests, instructionTags, instructionFreeText, followUp, doctorNote,
    }
  }

  // Restore form from slot memory; returns true if form was found
  function restoreSlotForm(slot) {
    const f = slotForms.current[slot]
    if (!f) return false
    setPatient(f.patient)
    setVitals(f.vitals || {})
    setSymptoms(f.symptoms || [])
    setSymptomText(f.symptomText || '')
    setDiagnosis(f.diagnosis || [])
    setMedicines(f.medicines || [])
    setTests(f.tests || [])
    setInstructionTags(f.instructionTags || [])
    setInstructionFreeText(f.instructionFreeText || '')
    setFollowUp(f.followUp || '')
    setDoctorNote(f.doctorNote || '')
    return true
  }

  function setActiveSlot(slot) {
    setActiveSlotState(slot)
    persistActiveSlot(slot)
  }

  async function switchSlot(slot) {
    if (slot === activeSlot) return
    captureSlotForm(activeSlot)   // save current form
    if (patient) await saveDraft()
    setActiveSlot(slot)
    const updated = getSlotsState(doctorId)
    setSlotsState(updated)
    // Try saved form first
    if (restoreSlotForm(slot)) { startTime.current = Date.now(); return }
    // Fall back to loading from storage
    const slotData = updated.find(s => s.slot === slot)
    if (slotData?.patientId) {
      const pt = getPatient(slotData.patientId)
      if (pt) { setPatient(pt); setVitals(slotData.vitals || {}); startTime.current = Date.now(); return }
    }
    setPatient(null); resetForm()
    startTime.current = Date.now()
  }

  async function callNextForSlot(slot) {
    const next = getNextWaiting(doctorId)
    if (!next) { alert('No patients waiting in queue.'); return }
    captureSlotForm(activeSlot)   // save current slot before switching
    updateAppointmentStatus(next.id, 'in_cabin', { slot })
    const pt = getPatient(next.patientId)
    const updated = getSlotsState(doctorId)
    setSlotsState(updated)
    slotForms.current[slot] = null  // fresh form for new patient
    setActiveSlot(slot)
    if (pt) { setPatient(pt); resetForm() }
    else resetForm()
  }

  // ── symptoms ────────────────────────────────────────────────────────────────
  function toggleSymptom(s) { setSymptoms(prev=>prev.includes(s)?prev.filter(x=>x!==s):[...prev,s]) }
  function addSymptomText() { if(symptomText.trim()&&!symptoms.includes(symptomText.trim())){setSymptoms(prev=>[...prev,symptomText.trim()]);setSymptomText('')} }

  // ── medicines ───────────────────────────────────────────────────────────────
  function addMedicine(m) { if(medicines.find(x=>x.id===m.id))return; setMedicines(prev=>[...prev,m]) }
  function updateMedicine(i,m) { setMedicines(prev=>prev.map((x,j)=>j===i?m:x)) }
  function removeMedicine(i) { setMedicines(prev=>prev.filter((_,j)=>j!==i)) }

  // ── tests ───────────────────────────────────────────────────────────────────
  function toggleTest(t) { setTests(prev=>prev.includes(t)?prev.filter(x=>x!==t):[...prev,t]) }

  // ── instructions ────────────────────────────────────────────────────────────
  // ── AI Voice Dictation Handler ──────────────────────────────────────────
  function handleAiPrescriptionParsed(parsedRx) {
    if (!parsedRx) return
    setAiExtractionWarnings(parsedRx.extraction_warnings?.length ? parsedRx.extraction_warnings : [])
    setAiTranscript(parsedRx.transcript || parsedRx.raw_transcript || '')
    if (parsedRx.symptoms?.length) {
      setSymptoms(prev => [...new Set([...prev, ...parsedRx.symptoms])])
    }
    if (parsedRx.diagnosis) {
      const diagArr = Array.isArray(parsedRx.diagnosis) ? parsedRx.diagnosis : [parsedRx.diagnosis]
      setDiagnosis(prev => [...new Set([...prev, ...diagArr.filter(Boolean)])])
    }
    if (parsedRx.medicines?.length) {
      const formattedMeds = parsedRx.medicines.map((m, idx) => ({
        id: `ai-med-${Date.now()}-${idx}`,
        brandName: m.name || m.spoken_name || m.raw_name || '',
        genericName: m.generic_name || '',
        strength: m.dose || '',
        strengths: m.dose ? [m.dose] : [],
        form: m.form || 'Tablet',
        dosage: m.frequency || `${m.morning?1:0}-${m.afternoon?1:0}-${m.night?1:0}`,
        timing: m.timing || (m.after_food === true ? 'After food' : m.after_food === false ? 'Before food' : ''),
        duration: m.duration || '',
        notes: m.notes || '',
        validation_band: m.validation_band || 'red',
        validation_status: m.validation_status || 'unverified',
        matched_name: m.matched_name,
        validation_score: m.validation_score,
      }))
      setMedicines(prev => [...prev, ...formattedMeds])
    }
    if (parsedRx.investigations?.length) {
      const matchedTests = parsedRx.investigations.map(inv => {
        const found = COMMON_TESTS.find(t => 
          t.toLowerCase() === inv.toLowerCase() || 
          t.toLowerCase().startsWith(inv.toLowerCase()) || 
          inv.toLowerCase().includes(t.toLowerCase().split(' ')[0])
        )
        return found || inv
      })
      setTests(prev => [...new Set([...prev, ...matchedTests])])
    }
    if (parsedRx.instruction_tags?.length || parsedRx.instructionTags?.length || parsedRx.advice?.length || Array.isArray(parsedRx.instructions)) {
      const tags = [...(parsedRx.instruction_tags || parsedRx.instructionTags || (Array.isArray(parsedRx.instructions) ? parsedRx.instructions : [])), ...(parsedRx.advice || [])]
      if (tags.length) {
        setInstructionTags(prev => [...new Set([...prev, ...tags])])
      }
    }
    if (parsedRx.follow_up?.length) {
      setFollowUp(Array.isArray(parsedRx.follow_up) ? parsedRx.follow_up[0] : parsedRx.follow_up)
    }
    if (parsedRx.notes) {
      setInstructionFreeText(prev => prev ? `${prev}. ${parsedRx.notes}` : parsedRx.notes)
    }
  }

  // ── build & save ─────────────────────────────────────────────────────────────
  const fupOptions = ['3 days','1 week','2 weeks','1 month','SOS']

  function buildRx(finalized=false) {
    const instrEn = [...instructionTags, instructionFreeText].filter(Boolean).join('. ')
    return {
      patientId:patient?.id, patientName:patient?.name||'', patientAge:patient?.age||'',
      patientGender:patient?.gender||'', patientPhone:patient?.phone||'', patientAbha:patient?.abha||'',
      patientAllergies:patient?.allergies||[], patientChronic:patient?.chronicConditions||[],
      doctorId, vitals, symptoms, diagnosis, medicines, tests,
      instructions:{ en:instrEn, hi:'' },
      followUp,
      followUpDate: (() => {
        if (!followUp || followUp === 'SOS') return null
        const d = new Date()
        if (followUp === '3 days')   d.setDate(d.getDate()+3)
        else if (followUp === '1 week')  d.setDate(d.getDate()+7)
        else if (followUp === '2 weeks') d.setDate(d.getDate()+14)
        else if (followUp === '1 month') d.setMonth(d.getMonth()+1)
        return d.toISOString()
      })(),
      doctorNote, status:finalized?'finalized':'draft', date:new Date().toISOString(),
    }
  }

  async function saveDraft() {
    if (!patient) return
    setSaving(true)
    const rx = buildRx(false)
    const s = savePrescription(rx)
    setSaving(false); setSaved(true); setTimeout(()=>setSaved(false),2000)
    return s
  }

  async function handlePrint() { const rx=await saveDraft(); if(!rx)return; router.push(`/portal/rx/${rx.id}?print=1`) }

  async function handleWhatsApp() {
    const rx = await saveDraft()
    if (!rx) return
    const phone = patient?.phone?.replace(/\D/g,'')
    if (phone) {
      const msg = buildWhatsAppMessage(rx, clinic)
      window.open(`https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`, '_blank')
    }
    router.push(`/portal/rx/${rx.id}`)
  }

  async function handleNextPatient() {
    if(patient)await saveDraft()
    const q=advanceQueue(doctorId)
    if(!q?.current?.patientId)return
    const pt=getPatient(q.current.patientId)
    if(!pt)return
    setQueueEntry(q); setPatient(pt); setVitals(q.staffVitals||{}); setStaffVitalsTime(q.staffVitalsTime||null)
    setSymptoms([]); setSymptomText(''); setDiagnosis([]); setMedicines([]); setTests([])
    setInstructionTags([]); setInstructionFreeText(''); setFollowUp(''); setDoctorNote('')
    startTime.current=Date.now()
  }

  async function handleEndConsultation() {
    if (!patient) { router.push('/portal/rx/history'); return }
    setSaving(true)
    setApprovalError(null)
    const rx = buildRx(true)
    const s = savePrescription(rx)

    // Call backend Approval Gate (Section 4.3). A failure here — including the
    // backend's doctor-only check on /approve — must NOT finalize or navigate to
    // the print view: an unapproved draft must never be treated as a signed Rx.
    try {
      await api.post('/prescriptions', s)
      const approvalRes = await api.post(`/prescriptions/${s.id}/approve`, {})
      s.rx_token = approvalRes.rx_token
      s.approved_at = approvalRes.approved_at
      s.is_approved = true

      const final = finalizePrescription(s.id)
      if (reviewContext) { resolveReview(reviewContext.id); setReviewContext(null) }
      setPendingReviews(getPendingReviews())
      setApprovalResult({ rx_token: approvalRes.rx_token, approved_at: approvalRes.approved_at, rxId: (final || s).id })
      setTimeout(() => router.push(`/portal/rx/${(final || s).id}`), 2200)
    } catch (err) {
      setApprovalError(err?.detail || err?.message || 'Approval failed. The prescription was NOT finalized — please ask a doctor to approve it.')
    } finally {
      setSaving(false)
    }
  }


  async function handleMarkForReview() {
    if (!patient || markingForReview) return
    setMarkingForReview(true)
    const rx = await saveDraft()
    addReviewEntry({
      patientId:               patient.id,
      patientName:             patient.name || '',
      patientPhone:            patient.phone || '',
      originalConsultationId:  rx?.id || '',
      diagnosis,
      testsRecommended:        tests.join(', '),
      consultationDate:        new Date().toISOString().split('T')[0],
      vitals,
      notes:                   doctorNote,
      doctorId,
    })
    const apptId = queueEntry?.current?.appointmentId
    const newQ   = apptId ? markAsAwaitingReports(apptId, doctorId) : getQueueEntry(doctorId)
    setQueueEntry(newQ)
    const nextPt = newQ?.current?.patientId ? getPatient(newQ.current.patientId) : null
    setPatient(nextPt || null)
    if (nextPt) {
      setVitals(newQ.staffVitals || {})
      setStaffVitalsTime(newQ.staffVitalsTime || null)
    }
    resetForm()
    setMarkingForReview(false)
    setReviewToast(true)
    setTimeout(() => setReviewToast(false), 3500)
  }

  const whatsappEnabled = clinic?.share?.whatsapp !== false
  const medNames = medicines.map(m=>m.brandName)
  const lastVisitVitals = pastVisits[0]?.vitals || null

  // chronic pill colors
  const CHRONIC_COLORS = [
    {bg:'#FEF9C3',color:'#854D0E',border:'#FEF08A'}, // yellow
    {bg:'#DBEAFE',color:'#1E40AF',border:'#BFDBFE'}, // blue
    {bg:'#DCFCE7',color:'#166534',border:'#BBF7D0'}, // green
    {bg:'#FCE7F3',color:'#9D174D',border:'#F9A8D4'}, // pink
    {bg:'#FEE2E2',color:'#991B1B',border:'#FECACA'}, // red
  ]

  // QUICK_INSTRUCTIONS - show first 6, rest under "more"
  const INSTR_QUICK = QUICK_INSTRUCTIONS_EN.slice(0, 6)
  const INSTR_MORE  = QUICK_INSTRUCTIONS_EN.slice(6)

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ background:C.page, minHeight:'100vh', fontFamily:"'Segoe UI',Inter,sans-serif", color:C.text }}>

      {/* ══ HEADER ══ */}
      <div style={{ position:'sticky', top:0, zIndex:100, background:'#fff', borderBottom:`1px solid ${C.border}`, boxShadow:'0 1px 4px rgba(0,0,0,.07)' }}>
        <div style={{ padding:'6px 12px', display:'flex', alignItems:'center', gap:10 }}>
          {/* Back button */}
          <button type="button" aria-label="Go back" onClick={()=>router.back()}
            style={{ width:44, height:44, display:'flex', alignItems:'center', justifyContent:'center', border:'none', background:'transparent', cursor:'pointer', color:'#6B7A9A', flexShrink:0, borderRadius:8 }}>
            <ArrowLeft size={20}/>
          </button>
          {patient ? (
            <>
              <div style={{ width:36, height:36, borderRadius:'50%', background:C.text, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <span style={{ color:'#fff', fontWeight:800, fontSize:13 }}>{initials(patient.name)}</span>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
                  <span style={{ fontSize:15, fontWeight:700, color:C.text }}>{patient.name}</span>
                  <span style={{ fontSize:12, color:C.muted }}>
                    {[patient.age&&`${patient.age}M`, `Visit #${(patient.visitCount||0)+1}`, patient.phone].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
              {patient.allergies?.length>0 && (
                <div className="rx-allergy-badge" style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 11px', background:'#FEE2E2', border:'1px solid #FECACA', borderRadius:8 }}>
                  <span style={{ fontSize:11, color:'#991B1B', fontWeight:700 }}>Allergic:</span>
                  <span style={{ fontSize:11, color:'#B91C1C' }}>{patient.allergies.join(', ')}</span>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 10px', background:C.surface, borderRadius:8, border:`1px solid ${C.border}` }}>
                <Clock size={11} color={C.muted}/>
                <span style={{ fontSize:12, fontFamily:'monospace', color:C.muted }}>{elapsed(startTime.current)}</span>
              </div>
            </>
          ) : (
            <span style={{ flex:1, fontSize:14, color:C.muted }}>OPD Console — waiting for patient</span>
          )}
          <VoiceButton
            patientName={patient?.name}
            patientAge={patient?.age}
            doctorName={clinic?.doctors?.find(d => d.id === doctorId)?.name || 'Doctor'}
            onPrescriptionParsed={handleAiPrescriptionParsed}
            onTranscript={(text) => {
              if (text && !symptomText) setSymptomText(text)
            }}
          />
          <button onClick={handleEndConsultation} disabled={saving}
            style={{ padding:'8px 18px', background:saving?C.muted:C.text, color:'#fff', border:'none', borderRadius:12, cursor:saving?'not-allowed':'pointer', fontSize:13, fontWeight:600, flexShrink:0, whiteSpace:'nowrap' }}>
            End consultation
          </button>
        </div>

        {/* Queue strip — single mode */}
        {!parallelMode && (
          <div style={{ background:C.surface, borderTop:`1px solid ${C.border}`, padding:'5px 18px', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', position:'relative' }}>
            {queueEntry?.current ? (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 11px', borderRadius:8, background:'#ECFDF5', border:'1px solid #86EFAC' }}>
                  <span style={{ width:6, height:6, borderRadius:'50%', background:'#16A34A', display:'inline-block' }}/>
                  <span style={{ fontSize:11, fontWeight:700, color:'#15803D' }}>In Cabin:</span>
                  <span style={{ fontSize:11, color:C.text }}>{patient?.name||'—'} · Token #{queueEntry.current.token}</span>
                </div>
                {queueEntry.next && <div style={{ fontSize:11, color:C.muted }}>Next: <strong>{queueEntry.next.name}</strong></div>}
                {queueEntry.waitingCount>0 && <div style={{ fontSize:11, color:C.muted }}>Waiting: <strong>{queueEntry.waitingCount}</strong></div>}
                <div style={{ flex:1 }}/>
                {pendingReviews.length>0 && (
                  <button onClick={()=>setShowReviews(s=>!s)}
                    style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 10px', borderRadius:8, background:'#FFF7ED', border:'1px solid #FCD34D', cursor:'pointer', fontFamily:'inherit' }}>
                    <span style={{ fontSize:11, fontWeight:700, color:C.amber }}>Reviews: {pendingReviews.length}</span>
                  </button>
                )}
                <button onClick={handleNextPatient}
                  style={{ padding:'4px 14px', background:C.coral, color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:11, fontWeight:700 }}>
                  Call Next →
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize:11, color:C.muted }}>No patient in queue.</span>
                <div style={{ flex:1 }}/>
                {pendingReviews.length>0 && (
                  <button onClick={()=>setShowReviews(s=>!s)}
                    style={{ fontSize:11, fontWeight:700, color:C.amber, padding:'3px 10px', borderRadius:8, background:'#FFF7ED', border:'1px solid #FCD34D', cursor:'pointer', fontFamily:'inherit' }}>
                    Reviews: {pendingReviews.length}
                  </button>
                )}
              </>
            )}
            {/* Reviews dropdown */}
            {showReviews && pendingReviews.length>0 && (
              <div style={{ position:'absolute', top:'calc(100% + 4px)', right:18, zIndex:200, background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,.12)', width:360, maxHeight:300, overflowY:'auto' }}>
                <div style={{ padding:'9px 14px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontSize:13, fontWeight:700 }}>Awaiting Review</span>
                  <button onClick={()=>setShowReviews(false)} style={{ background:'none', border:'none', cursor:'pointer', color:C.muted, fontSize:18 }}>×</button>
                </div>
                {pendingReviews.map(r=>(
                  <div key={r.id} style={{ padding:'9px 14px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600 }}>{r.patientName||'Unknown'}</div>
                      <div style={{ fontSize:11, color:C.muted }}>Tests: {r.testsOrdered?.join(', ')||'—'} · {fmtDate(r.orderedDate)}</div>
                    </div>
                    <button onClick={()=>openReview(r)} style={{ padding:'5px 10px', background:C.coral, color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:600 }}>Open →</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Multi-slot strip — parallel mode */}
        {parallelMode && (
          <div style={{ background:C.surface, borderTop:`1px solid ${C.border}`, padding:'8px 18px', display:'flex', alignItems:'stretch', gap:8 }}>
            {['A','B','C'].slice(0, maxSlots).map(slot => {
              const slotData   = slotsState.find(s => s.slot === slot)
              const isActive   = activeSlot === slot
              const hasPatient = !!slotData?.patientId

              // Colors: green=active, yellow=in-cabin-waiting, grey=empty
              const borderColor = isActive ? '#16A34A' : hasPatient ? '#D97706' : C.border
              const bgColor     = isActive ? '#F0FDF4' : hasPatient ? '#FFFBEB' : C.surface
              const badgeBg     = isActive ? '#16A34A' : hasPatient ? '#D97706' : '#9CA3AF'
              const subtitleColor = isActive ? '#15803D' : hasPatient ? '#92400E' : C.muted

              return (
                <button key={slot} onClick={() => hasPatient ? switchSlot(slot) : callNextForSlot(slot)}
                  style={{
                    flex:1, display:'flex', alignItems:'center', gap:8, padding:'7px 12px',
                    border:`2px solid ${borderColor}`,
                    borderRadius:9, background:bgColor,
                    cursor:'pointer', textAlign:'left', fontFamily:'inherit', transition:'all .15s',
                    minWidth:0,
                  }}>
                  {/* Slot badge */}
                  <div style={{ width:28, height:28, borderRadius:6, flexShrink:0, background:badgeBg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <span style={{ fontSize:13, fontWeight:800, color:'#fff' }}>{slot}</span>
                  </div>
                  {hasPatient ? (
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:C.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        {slotData.patientName}
                      </div>
                      <div style={{ fontSize:10, color:subtitleColor }}>
                        {isActive ? 'Active — editing now' : 'In cabin — click to switch'}
                      </div>
                    </div>
                  ) : (
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:11, color:C.muted }}>Empty slot</div>
                      <div style={{ fontSize:10, color:C.coral, fontWeight:600 }}>Call next patient →</div>
                    </div>
                  )}
                  {isActive && hasPatient && (
                    <div style={{ display:'flex', alignItems:'center', gap:3, padding:'2px 6px', background:'#16A34A', borderRadius:8, flexShrink:0 }}>
                      <span style={{ width:5, height:5, borderRadius:'50%', background:'#fff', display:'inline-block' }}/>
                      <span style={{ fontSize:10, fontWeight:700, color:'#fff' }}>Now</span>
                    </div>
                  )}
                </button>
              )
            })}
            <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:8 }}>
              {pendingReviews.length>0 && (
                <button onClick={()=>setShowReviews(s=>!s)}
                  style={{ fontSize:11, fontWeight:700, color:C.amber, padding:'3px 10px', borderRadius:8, background:'#FFF7ED', border:'1px solid #FCD34D', cursor:'pointer', fontFamily:'inherit' }}>
                  Reviews: {pendingReviews.length}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sensitive specialty warning for parallel mode */}
      {parallelMode && (() => {
        const doc = clinic?.doctors?.find(d => d.id === doctorId) || clinic?.doctors?.[0] || {}
        const sensitive = ['Gynaecology','Psychiatry','Gynaecology & Obstetrics'].includes(doc.specialty||'')
        return sensitive ? (
          <div style={{ background:'#FEF3C7', borderBottom:'2px solid #FDE68A', padding:'5px 18px', display:'flex', alignItems:'center', gap:8 }}>
            <AlertTriangle size={13} color={C.amber}/>
            <span style={{ fontSize:12, color:'#92400E', fontWeight:600 }}>Parallel consult is not recommended for {doc.specialty}. Patient privacy may be compromised.</span>
          </div>
        ) : null
      })()}

      {reviewContext && (
        <div style={{ background:'#FFF7ED', borderBottom:'2px solid #FCD34D', padding:'6px 18px', display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:12, color:C.amber, fontWeight:600 }}>Review: Tests ordered — {reviewContext.testsOrdered?.join(', ')}</span>
          <button onClick={()=>setReviewContext(null)} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:C.amber, fontSize:18 }}>×</button>
        </div>
      )}

      {/* ══ MAIN BODY ══ */}
      {patient ? (
        <div className="rx-main-body" style={{ display:'flex', maxWidth:1120, margin:'0 auto', minHeight:'calc(100vh - 96px)' }}>

          {/* ── LEFT SIDEBAR ── */}
          <div className="rx-left-panel" style={{ width:210, flexShrink:0, background:'#fff', borderRight:`1px solid ${C.border}`, padding:'16px 14px', display:'flex', flexDirection:'column', gap:18 }}>

            {/* Chronic conditions */}
            {patient.chronicConditions?.length>0 && (
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:7 }}>Chronic conditions</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                  {patient.chronicConditions.map((c,i)=>{
                    const style = CHRONIC_COLORS[i % CHRONIC_COLORS.length]
                    return (
                      <span key={c} style={{ fontSize:11, padding:'3px 10px', borderRadius:8, fontWeight:600, background:style.bg, color:style.color, border:`1px solid ${style.border}` }}>{c}</span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Recent visits */}
            {pastVisits.length>0 && (
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:7 }}>Recent visits</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {pastVisits.slice(0,4).map(v=>(
                    <div key={v.id}
                      onClick={()=>v.diagnosis?.length&&setDiagnosis(prev=>[...new Set([...prev,...(v.diagnosis||[])])])}
                      style={{ cursor: v.diagnosis?.length?'pointer':'default', padding:'7px 10px', borderRadius:8, border:`1px solid ${C.border}`, background:C.surface }}
                      onMouseEnter={e=>{ if(v.diagnosis?.length) e.currentTarget.style.borderColor=C.coral }}
                      onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                      <div style={{ fontSize:10, color:C.muted, marginBottom:1 }}>{fmtDate(v.date)}</div>
                      <div style={{ fontSize:12, fontWeight:600, color:C.text }}>{v.diagnosis?.join(', ')||'—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* BP trend */}
            {pastVisits.some(v=>v.vitals?.bp) && (
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>BP trend (3 mo)</div>
                {pastVisits.filter(v=>v.vitals?.bp).slice(0,3).map(v=>(
                  <div key={v.id} style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                    <span style={{ fontSize:10, color:C.muted }}>{fmtDate(v.date)?.slice(0,6)}</span>
                    <span style={{ fontSize:12, fontWeight:600, color:C.blue }}>{v.vitals.bp}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Doctor note */}
            {patient.doctorNote && (
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:5 }}>Doctor's note</div>
                <div style={{ fontSize:12, color:C.text, fontStyle:'italic', lineHeight:1.6, padding:'8px 10px', background:C.surface, borderRadius:8, border:`1px solid ${C.border}` }}>
                  "{patient.doctorNote}"
                </div>
              </div>
            )}

            {!patient.chronicConditions?.length && !pastVisits.length && !patient.doctorNote && (
              <div style={{ fontSize:12, color:C.muted, textAlign:'center', paddingTop:20 }}>No prior history</div>
            )}
          </div>

          {/* ── RIGHT FORM ── */}
          <div className="rx-right-panel" style={{ flex:1, padding:'16px 18px', display:'flex', flexDirection:'column', gap:12, paddingBottom:90 }}>

            {/* VITALS */}
            <div style={{ background:'#fff', borderRadius:10, border:`1px solid ${C.border}`, overflow:'hidden' }}>
              <div style={{ padding:'9px 14px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em' }}>Vitals</span>
                {lastVisitVitals && (
                  <button onClick={()=>{ setVitals(lastVisitVitals); setStaffVitalsTime(null) }}
                    style={{ fontSize:11, color:C.muted, border:`1px solid ${C.border}`, borderRadius:6, padding:'3px 10px', background:'#fff', cursor:'pointer', fontFamily:'inherit' }}>
                    Same as last
                  </button>
                )}
              </div>
              <div style={{ padding:'12px 14px', display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
                {[['BP','bp','120/80',''],['Pulse','pulse','72',''],['Temp','temp','98.6',''],['Weight','weight','70','']].map(([lbl,k,ph])=>(
                  <div key={k}>
                    <div style={{ fontSize:10, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4 }}>{lbl}</div>
                    <input value={vitals[k]||''} onChange={e=>setVitals(v=>({...v,[k]:e.target.value}))} placeholder={ph}
                      style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:7, padding:'8px 10px', fontSize:14, color:C.text, outline:'none', boxSizing:'border-box', fontFamily:'inherit' }}/>
                  </div>
                ))}
              </div>
            </div>

            {/* SYMPTOMS */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <span style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em' }}>Symptoms</span>
              </div>
              {/* Quick symptom chips */}
              <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:8 }}>
                {QUICK_SYMPTOMS.map(s=>{
                  const active = symptoms.includes(s)
                  return (
                    <button key={s} onClick={()=>toggleSymptom(s)}
                      style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'4px 11px', border:`1px solid ${active?C.blue:C.border}`, borderRadius:8, fontSize:12, cursor:'pointer', background:active?'#EFF6FF':'#fff', color:active?C.blue:C.muted, fontFamily:'inherit', fontWeight:active?600:400 }}>
                      {active ? null : <Plus size={10}/>}{s}
                    </button>
                  )
                })}
              </div>
              {/* Free text */}
              <textarea value={symptomText} onChange={e=>setSymptomText(e.target.value)}
                onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();addSymptomText()}}}
                placeholder="Free text complaints…"
                rows={2}
                style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:7, padding:'7px 10px', fontSize:13, outline:'none', resize:'none', fontFamily:'inherit', boxSizing:'border-box', background:C.surface, color:C.text }}/>
            </div>

            {/* DIAGNOSIS */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>Diagnosis</div>
              <DiagnosisInput values={diagnosis} onChange={setDiagnosis}/>
              {diagnosis.length>0 && (
                <div style={{ marginTop:12 }}>
                  <AiSuggestionsPanel doctorId={doctorId} diagnoses={diagnosis} currentMedNames={medNames} onAdd={addMedicine}/>
                </div>
              )}
            </div>

            {/* VOICE TRANSCRIPT — so the doctor can cross-check against what was actually said */}
            {aiTranscript && (
              <div style={{ background:'#F8FAFC', borderRadius:10, padding:'10px 14px', border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Voice transcript</div>
                <div style={{ fontSize:13, color:C.text, lineHeight:1.5, fontStyle:'italic' }}>&ldquo;{aiTranscript}&rdquo;</div>
              </div>
            )}

            {/* EXTRACTION WARNINGS — items the AI could not confidently extract/validate */}
            {aiExtractionWarnings.length>0 && (
              <div style={{ background:'#FFFBEB', borderRadius:10, padding:'10px 14px', border:'1px solid #FDE68A' }}>
                <div style={{ fontSize:12, fontWeight:700, color:'#92400E', marginBottom:6 }}>
                  Ye cheezein samajh nahi aayi, check karein:
                </div>
                <ul style={{ margin:0, paddingLeft:18, fontSize:12, color:'#92400E', lineHeight:1.6 }}>
                  {aiExtractionWarnings.map((w,i)=><li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* MEDICINES */}
            <div style={{ background:'#fff', borderRadius:10, border:`1px solid ${C.border}`, overflow:'hidden' }}>
              <div style={{ padding:'10px 14px', borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center' }}>
                <span style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', flex:1 }}>Medicines</span>
                <span style={{ fontSize:11, color:C.blue, background:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:8, padding:'3px 10px', fontWeight:600 }}>⚡ 30-sec</span>
              </div>
              {medicines.map((m,i)=>(
                <MedicineRow key={m.id||i} medicine={m} index={i} doctorId={doctorId}
                  onChange={v=>updateMedicine(i,v)} onRemove={()=>removeMedicine(i)}/>
              ))}
              <div style={{ padding:'10px 14px', borderTop: medicines.length>0?`1px solid ${C.border}`:'none' }}>
                <MedicineSearch doctorId={doctorId} onSelect={addMedicine} onAddCustom={()=>setShowCustomModal(true)}/>
              </div>
              <div style={{ padding:'4px 14px 12px' }}>
                <button onClick={()=>setShowCustomModal(true)}
                  style={{ width:'100%', padding:'8px', border:`1.5px dashed ${C.border}`, borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:C.muted, fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
                  <Plus size={13}/>Add medicine
                </button>
              </div>
            </div>

            {/* ALLERGY ALERT */}
            {allergyAlert.length>0 && (
              <div style={{ background:'#FEF2F2', border:'1px solid #FECACA', borderRadius:10, padding:'11px 14px', display:'flex', alignItems:'flex-start', gap:8 }}>
                <AlertTriangle size={15} color='#DC2626' style={{ flexShrink:0, marginTop:1 }}/>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:'#991B1B', marginBottom:2 }}>Allergy alert</div>
                  <div style={{ fontSize:12, color:'#B91C1C' }}>{allergyAlert.join(' · ')}</div>
                </div>
              </div>
            )}

            {/* TESTS / LABS */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>Tests / Labs</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center' }}>
                {tests.map(t=>(
                  <span key={t} style={{ display:'inline-flex', alignItems:'center', gap:3, background:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:8, padding:'4px 12px', fontSize:12, color:C.blue, fontWeight:600 }}>
                    {t}
                    <button onClick={()=>toggleTest(t)} style={{ background:'none', border:'none', cursor:'pointer', padding:0, display:'flex', color:'#93C5FD', marginLeft:2 }}><X size={10}/></button>
                  </span>
                ))}
                <div ref={testDropRef} style={{ position:'relative' }}>
                  <button onClick={()=>setShowTestDrop(d=>!d)}
                    style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 12px', border:`1.5px dashed ${C.border}`, borderRadius:8, background:'#fff', cursor:'pointer', fontSize:12, color:C.muted, fontFamily:'inherit' }}>
                    <Plus size={11}/>Add test
                  </button>
                  {showTestDrop && (
                    <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, zIndex:200, background:'#fff', border:`1px solid ${C.border}`, borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,.12)', width:220, maxHeight:280, overflowY:'auto' }}>
                      {COMMON_TESTS.filter(t=>!tests.includes(t)).map(t=>(
                        <button key={t} onClick={()=>{ toggleTest(t); setShowTestDrop(false) }}
                          style={{ display:'block', width:'100%', padding:'8px 12px', border:'none', background:'none', textAlign:'left', cursor:'pointer', fontSize:13, color:C.text, borderBottom:`1px solid ${C.border}` }}
                          onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                          onMouseLeave={e=>e.currentTarget.style.background='none'}>
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* INSTRUCTIONS */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <span style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em' }}>Instructions</span>
                <button onClick={()=>setShowMoreInstr(m=>!m)}
                  style={{ display:'flex', alignItems:'center', gap:3, fontSize:11, color:C.muted, background:'none', border:'none', cursor:'pointer', padding:0, fontFamily:'inherit' }}>
                  {showMoreInstr?'Less':'More'}<ChevronDown size={12} style={{ transform: showMoreInstr?'rotate(180deg)':'none' }}/>
                </button>
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                {[...new Set([...(showMoreInstr ? QUICK_INSTRUCTIONS_EN : INSTR_QUICK), ...instructionTags])].map(t=>{
                  const active = instructionTags.includes(t)
                  return (
                    <button key={t} onClick={()=>toggleInstrTag(t)}
                      style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 11px', border:`1px solid ${active?C.blue:C.border}`, borderRadius:8, fontSize:12, cursor:'pointer', background:active?'#EFF6FF':'#fff', color:active?C.blue:C.muted, fontFamily:'inherit', fontWeight:active?600:400 }}>
                      {active ? '✓ ' : <Plus size={10}/>}{t}
                    </button>
                  )
                })}
              </div>
              {instructionTags.length>0 && (
                <div style={{ marginTop:8, fontSize:12, color:C.text, background:C.surface, borderRadius:7, padding:'7px 10px' }}>
                  {instructionTags.join('. ')}
                </div>
              )}
            </div>

            {/* FOLLOW-UP */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>Follow-up</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {fupOptions.map(o=>{
                  const active=followUp===o
                  return (
                    <button key={o} onClick={()=>setFollowUp(active?'':o)}
                      style={{ padding:'6px 18px', border:`1.5px solid ${active?C.blue:C.border}`, borderRadius:8, fontSize:13, cursor:'pointer', background:active?C.blue:'#fff', color:active?'#fff':C.text, fontWeight:active?700:400, fontFamily:'inherit', transition:'all .1s' }}>
                      {o}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* DOCTOR NOTE */}
            <div style={{ background:'#fff', borderRadius:10, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.muted, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:7 }}>
                Doctor's Note <span style={{ fontWeight:400, textTransform:'none', fontSize:11 }}>(private)</span>
              </div>
              <textarea value={doctorNote} onChange={e=>setDoctorNote(e.target.value)} rows={2}
                placeholder="Clinical notes, reminders…"
                style={{ width:'100%', border:`1px solid ${C.border}`, borderRadius:7, padding:'7px 10px', fontSize:13, outline:'none', resize:'vertical', fontFamily:'inherit', boxSizing:'border-box', background:C.surface, color:C.text }}/>
            </div>

          </div>
        </div>
      ) : (
        /* ── Empty state ── */
        <EmptyPatientPanel onSelect={selectPatient} />
      )}


      {/* ══ REVIEW TOAST ══ */}
      {reviewToast && (
        <div style={{ position:'fixed', bottom:76, left:'50%', transform:'translateX(-50%)', zIndex:200, background:'#0F2342', color:'#fff', borderRadius:12, padding:'10px 20px', fontSize:13, fontWeight:600, boxShadow:'0 4px 24px rgba(0,0,0,.18)', display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap' }}>
          <Bookmark size={14} style={{ color:'#5EEAD4' }}/>Marked for review — patient added to Reports Pending list
        </div>
      )}

      {/* ══ BOTTOM BAR ══ */}
      {patient && (
        <div className="rx-bottom-bar" style={{ position:'fixed', bottom:0, left:0, right:0, background:'#fff', borderTop:`1px solid ${C.border}`, padding:'10px 16px', paddingBottom:'calc(10px + env(safe-area-inset-bottom, 0px))', display:'flex', gap:8, alignItems:'center', zIndex:100, boxShadow:'0 -2px 12px rgba(0,0,0,.06)' }}>
          {saved && <span style={{ fontSize:12, color:C.green, display:'flex', alignItems:'center', gap:4 }}><CheckCircle size={12}/>Draft saved</span>}
          <div className="rx-bottom-spacer" style={{ flex:1 }}/>
          <div className="rx-bottom-actions" style={{ display:'flex', gap:8, alignItems:'center' }}>
            <button onClick={handleMarkForReview} disabled={markingForReview}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'8px 18px', border:'1.5px solid #0D9488', borderRadius:7, background:'#F0FDFA', cursor:markingForReview?'not-allowed':'pointer', fontSize:13, fontWeight:600, color:'#0D9488', opacity:markingForReview?0.6:1, whiteSpace:'nowrap' }}>
              <Bookmark size={13}/>{markingForReview ? 'Saving…' : 'Mark for Review'}
            </button>
            <button onClick={saveDraft} disabled={saving}
              style={{ padding:'8px 18px', border:`1px solid ${C.border}`, borderRadius:7, background:'#fff', cursor:saving?'not-allowed':'pointer', fontSize:13, fontWeight:600, color:C.text }}>
              {saving?'Saving…':'Save draft'}
            </button>
            <button onClick={handlePrint}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'8px 18px', border:`1px solid ${C.border}`, borderRadius:7, background:'#fff', color:C.text, cursor:'pointer', fontSize:13, fontWeight:600 }}>
              <Printer size={13}/>Print
            </button>
            {whatsappEnabled ? (
              <button onClick={handleWhatsApp}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 22px', border:'none', borderRadius:7, background:'#25D366', color:'#fff', cursor:'pointer', fontSize:13, fontWeight:700 }}>
                <MessageCircle size={13}/>WhatsApp & Save
              </button>
            ) : (
              <button onClick={handleEndConsultation} disabled={saving}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 22px', border:'none', borderRadius:7, background:C.coral, color:'#fff', cursor:'pointer', fontSize:13, fontWeight:700 }}>
                <CheckCircle size={13}/>Save & Finalize
              </button>
            )}
          </div>
        </div>
      )}

      {showCustomModal && (
        <CustomMedicineModal doctorId={doctorId} onSave={addMedicine} onClose={()=>setShowCustomModal(false)}/>
      )}

      {/* ══ DOCTOR APPROVAL GATE MODAL ══ */}
      {approvalResult && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,35,66,.65)', backdropFilter: 'blur(3px)',
          zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            background: '#fff', borderRadius: 16, maxWidth: 440, width: '100%',
            padding: 28, textAlign: 'center', boxShadow: '0 20px 60px rgba(15,35,66,.25)',
            border: '1.5px solid #BBF7D0', animation: 'fadeIn 0.2s ease-out'
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%', background: '#DCFCE7',
              color: '#16A34A', display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px', border: '2px solid #86EFAC'
            }}>
              <CheckCircle size={32} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0F2342', marginBottom: 6 }}>
              Doctor Approval Gate Confirmed
            </div>
            <p style={{ fontSize: 13, color: '#6B7A9A', margin: '0 0 16px', lineHeight: 1.5 }}>
              The prescription has been explicitly signed and sealed by the attending doctor. 
              Status: <strong style={{ color: '#16A34A' }}>doctor_approved = TRUE</strong>
            </p>
            {approvalResult.rx_token && (
              <div style={{
                background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8,
                padding: '10px 14px', marginBottom: 20, textAlign: 'left'
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>
                  Cryptographic Rx Token
                </div>
                <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#0F2342', fontWeight: 600, wordBreak: 'break-all' }}>
                  {approvalResult.rx_token}
                </div>
                {approvalResult.approved_at && (
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>
                    Approved At: {new Date(approvalResult.approved_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => router.push(`/portal/rx/${approvalResult.rxId}`)}
              style={{
                width: '100%', background: '#0F2342', color: '#fff', border: 'none',
                borderRadius: 12, padding: '11px 0', fontSize: 14, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit'
              }}>
              View & Print Prescription →
            </button>
          </div>
        </div>
      )}

      {/* ══ APPROVAL FAILED — prescription NOT finalized ══ */}
      {approvalError && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,35,66,.65)', backdropFilter: 'blur(3px)',
          zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            background: '#fff', borderRadius: 16, maxWidth: 440, width: '100%',
            padding: 28, textAlign: 'center', boxShadow: '0 20px 60px rgba(15,35,66,.25)',
            border: '1.5px solid #FECACA',
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%', background: '#FEE2E2',
              color: '#DC2626', display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px', border: '2px solid #FCA5A5'
            }}>
              <AlertTriangle size={32} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0F2342', marginBottom: 6 }}>
              Approval Gate Blocked
            </div>
            <p style={{ fontSize: 13, color: '#6B7A9A', margin: '0 0 20px', lineHeight: 1.5 }}>
              {approvalError}
            </p>
            <button
              type="button"
              onClick={() => setApprovalError(null)}
              style={{
                width: '100%', background: '#0F2342', color: '#fff', border: 'none',
                borderRadius: 12, padding: '11px 0', fontSize: 14, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit'
              }}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
