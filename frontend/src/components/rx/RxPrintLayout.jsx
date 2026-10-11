'use client'
// A5 prescription print layout — brand: navy #0F2342, coral #E84C3D
import { useEffect } from 'react'

const P = {
  navy: '#0F2342',
  coral: '#E84C3D',
  cream: '#F7F5F0',
  surface: '#FAFAF7',
  border: '#D3D1C7',
  muted: '#6B7A9A',
  blue: '#1A5CB5',
  lb: '#E6F1FB',
  pb: '#B5D4F4',
  green: '#16A34A',
}

export default function RxPrintLayout({ rx, clinic, doctor, autoPrint = false }) {
  useEffect(() => {
    if (autoPrint) {
      const t = setTimeout(() => window.print(), 600)
      return () => clearTimeout(t)
    }
  }, [autoPrint])

  if (!rx) return null

  // Safety rule 2: a draft must never be mistaken for a signed Rx, wherever it's opened from.
  const isApproved = Boolean(rx.is_approved)

  const doc = doctor || clinic?.doctors?.find(d => d.isPrimary) || clinic?.doctors?.[0] || {}
  const rxDate = rx.date ? new Date(rx.date) : new Date()
  const followDate = rx.followUpDate ? new Date(rx.followUpDate) : null
  const rxToken = rx.rx_token || rx.rxToken || (rx.rxNumber ? `RX-${rx.rxNumber.slice(-6)}` : `RX-${String(rx.id).slice(-6).toUpperCase()}`)
  const clinicPhone = (clinic?.phone || '9876543210').replace(/\D/g, '')
  const qrTargetUrl = `https://wa.me/91${clinicPhone}?text=OPTIN%20${rxToken}`
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(qrTargetUrl)}`

  return (
    <>
      <style>{`
        @media print {
          body * { visibility:hidden !important; }
          #rx-print-root, #rx-print-root * { visibility:visible !important; }
          #rx-print-root { position:fixed !important; inset:0 !important; z-index:9999 !important; background:#fff !important; }
          @page { size:A5 portrait; margin:0; }
        }
      `}</style>

      <div
        id="rx-print-root"
        style={{
          width: '100%',
          maxWidth: 560,
          background: '#fff',
          fontFamily: "'Segoe UI',Inter,sans-serif",
          fontSize: 12,
          color: P.navy,
          margin: '0 auto',
          boxShadow: '0 2px 16px rgba(15,35,66,.12)',
          borderRadius: 8,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Draft watermark — a draft must never read as a signed prescription,
            no matter how this screen was opened (direct link, history, etc.) */}
        {!isApproved && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', overflow: 'hidden',
          }}>
            <span style={{
              fontSize: 42, fontWeight: 800, color: 'rgba(220,38,38,0.22)',
              transform: 'rotate(-28deg)', whiteSpace: 'nowrap', letterSpacing: '.05em',
              textTransform: 'uppercase', userSelect: 'none',
            }}>
              DRAFT — NOT APPROVED
            </span>
          </div>
        )}

        {/* Navy header */}
        <div style={{ background: P.navy, padding: '13px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ width: 36, height: 36, background: P.coral, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>T</span>
            </div>
            <div>
              <div style={{ fontSize: 9, color: P.pb, letterSpacing: '.1em', marginBottom: 2 }}>TRIKMED · CLINICAL PARCHE</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', lineHeight: 1.1 }}>{clinic?.name || clinic?.clinic_name || 'Clinic Name'}</div>
              {doc.name && <div style={{ fontSize: 11, color: P.pb, marginTop: 3 }}>{doc.name}{doc.qualifications ? ` · ${doc.qualifications}` : ''}</div>}
              {doc.registrationNumber && <div style={{ fontSize: 10, color: P.pb }}>MCI Reg: {doc.registrationNumber}</div>}
            </div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 10, color: P.pb, lineHeight: 1.7 }}>
            {clinic?.phone && <div>📞 {clinic.phone}</div>}
            {clinic?.email && <div>✉ {clinic.email}</div>}
            {clinic?.address && <div style={{ maxWidth: 140 }}>{clinic.address}{clinic.city ? `, ${clinic.city}` : ''}</div>}
          </div>
        </div>

        {/* Coral strip */}
        <div style={{ height: 3, background: P.coral }} />

        {/* Meta strip */}
        <div style={{ background: P.cream, padding: '5px 14px', display: 'flex', justifyContent: 'space-between', borderBottom: `1px solid ${P.border}`, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 14 }}>
            <span><b style={{ color: P.muted }}>Rx No:</b> {rx.rxNumber || rx.rx_number || '—'}</span>
            <span><b style={{ color: P.muted }}>Token:</b> {rxToken}</span>
            <span><b style={{ color: P.muted }}>Status:</b> {isApproved
              ? <span style={{ color: P.green, fontWeight: 700 }}>Approved ✓</span>
              : <span style={{ color: P.coral, fontWeight: 700 }}>Draft — Not Approved</span>}</span>
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            <span><b style={{ color: P.muted }}>Date:</b> {rxDate.toLocaleDateString('en-IN')}</span>
            {followDate && <span style={{ color: P.coral }}><b>Follow-up:</b> {followDate.toLocaleDateString('en-IN')}</span>}
          </div>
        </div>

        {/* Patient / Vitals / Conditions */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderBottom: `1px solid ${P.border}` }}>
          <div style={{ padding: '9px 12px', borderRight: `1px solid ${P.border}` }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: P.muted, textTransform: 'uppercase', marginBottom: 4 }}>Patient</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{rx.patientName || rx.patient_name || 'Patient'}</div>
            <div style={{ fontSize: 11, color: P.muted }}>{(rx.patientAge || rx.patient_age) && `${rx.patientAge || rx.patient_age} yrs`} {(rx.patientGender || rx.patient_gender) && `· ${rx.patientGender || rx.patient_gender}`}</div>
            {(rx.patientPhone || rx.patient_phone) && <div style={{ fontSize: 11, color: P.muted }}>📞 {rx.patientPhone || rx.patient_phone}</div>}
            {rx.patientAbha && <div style={{ fontSize: 10, color: P.muted }}>ABHA: {rx.patientAbha}</div>}
          </div>
          <div style={{ padding: '9px 12px', borderRight: `1px solid ${P.border}` }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: P.muted, textTransform: 'uppercase', marginBottom: 4 }}>Vitals</div>
            {rx.vitals?.bp && <div style={{ fontSize: 11 }}>BP: <b>{rx.vitals.bp}</b> mmHg</div>}
            {rx.vitals?.pulse && <div style={{ fontSize: 11 }}>Pulse: <b>{rx.vitals.pulse}</b> bpm</div>}
            {rx.vitals?.temp && <div style={{ fontSize: 11 }}>Temp: <b>{rx.vitals.temp}</b>°F</div>}
            {rx.vitals?.weight && <div style={{ fontSize: 11 }}>Weight: <b>{rx.vitals.weight}</b> kg</div>}
            {rx.vitals?.spo2 && <div style={{ fontSize: 11 }}>SpO₂: <b>{rx.vitals.spo2}</b>%</div>}
            {!rx.vitals?.bp && !rx.vitals?.temp && !rx.vitals?.pulse && <span style={{ fontSize: 11, color: P.muted }}>Recorded normal</span>}
          </div>
          <div style={{ padding: '9px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: P.muted, textTransform: 'uppercase', marginBottom: 4 }}>Allergies & History</div>
            {rx.patientAllergies?.length > 0 ? (
              <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 4, padding: '2px 6px', fontSize: 10, color: '#991B1B', marginBottom: 4 }}>
                ⚠ Allergy: {rx.patientAllergies.join(', ')}
              </div>
            ) : null}
            {rx.patientChronic?.map(c => <div key={c} style={{ fontSize: 11, marginBottom: 2 }}>• {c}</div>)}
            {!rx.patientAllergies?.length && !rx.patientChronic?.length && <span style={{ fontSize: 11, color: P.muted }}>No known allergies</span>}
          </div>
        </div>

        {/* Complaints + Diagnosis */}
        <div style={{ padding: '7px 14px', borderBottom: `1px solid ${P.border}`, display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, fontSize: 12 }}>
          <span style={{ fontWeight: 700, color: P.muted }}>Complaints</span>
          <span>{Array.isArray(rx.symptoms) ? rx.symptoms.join(', ') : (rx.symptoms || '—')}</span>
        </div>
        <div style={{ padding: '7px 14px', borderBottom: `1px dashed ${P.border}`, background: P.surface, display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, fontSize: 12 }}>
          <span style={{ fontWeight: 700, color: P.muted }}>Diagnosis</span>
          <span style={{ fontWeight: 600 }}>{Array.isArray(rx.diagnosis) ? rx.diagnosis.join('; ') : (rx.diagnosis || '—')}</span>
        </div>

        {/* ℞ + medicines table (1-0-1 format) */}
        <div style={{ padding: '10px 14px 6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 26, fontFamily: 'Georgia,serif', fontStyle: 'italic', color: P.coral, lineHeight: 1 }}>℞</span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em' }}>PRESCRIPTION (1-0-1 FORMAT)</span>
          </div>
          {rx.medicines?.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: P.lb }}>
                  {['#', 'Medicine Formulation', 'Dose (M-A-N)', 'Timing', 'Duration'].map(h => (
                    <th key={h} style={{ padding: '5px 8px', fontSize: 11, fontWeight: 700, textAlign: 'left', borderBottom: `2px solid ${P.blue}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rx.medicines.map((m, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? P.surface : '#fff' }}>
                    <td style={{ padding: '5px 8px', fontSize: 11, color: P.muted }}>{i + 1}</td>
                    <td style={{ padding: '5px 8px' }}>
                      <div style={{ fontWeight: 600 }}>{m.brandName || m.name}</div>
                      {(m.genericName || m.generic_name) && <div style={{ fontSize: 10, color: P.muted }}>{m.genericName || m.generic_name} {m.strength || m.dose}</div>}
                      {m.notes && <div style={{ fontSize: 10, color: P.coral, fontStyle: 'italic' }}>{m.notes}</div>}
                    </td>
                    <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontWeight: 700, fontSize: 13 }}>{m.dosage || m.frequency || '1-0-1'}</td>
                    <td style={{ padding: '5px 8px', fontSize: 11 }}>{m.timing || (m.after_food ? 'After food' : 'Before food')}</td>
                    <td style={{ padding: '5px 8px', fontSize: 11 }}>{m.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div style={{ fontSize: 12, color: P.muted, fontStyle: 'italic' }}>No medicines prescribed.</div>}
        </div>

        {/* Tests + Instructions */}
        {(rx.tests?.length > 0 || rx.instructions?.en || rx.investigations?.length > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: (rx.tests?.length || rx.investigations?.length) && rx.instructions?.en ? '1fr 1fr' : '1fr', gap: 0, padding: '8px 14px', borderTop: `1px dashed ${P.border}`, marginTop: 4 }}>
            {(rx.tests?.length > 0 || rx.investigations?.length > 0) && (
              <div style={{ paddingRight: 10, borderRight: rx.instructions?.en ? `1px dashed ${P.border}` : 'none' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: P.muted, textTransform: 'uppercase', marginBottom: 4 }}>Investigations / Tests</div>
                {(rx.tests || rx.investigations || []).map(t => <div key={t} style={{ fontSize: 11, marginBottom: 2 }}>• {t}</div>)}
              </div>
            )}
            {rx.instructions?.en && (
              <div style={{ paddingLeft: rx.tests?.length || rx.investigations?.length ? 10 : 0 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: P.muted, textTransform: 'uppercase', marginBottom: 4 }}>Instructions</div>
                <div style={{ fontSize: 11 }}>{rx.instructions.en}</div>
                {rx.instructions?.hi && <div style={{ fontSize: 11, marginTop: 4, fontFamily: "'Noto Sans Devanagari',sans-serif" }}>{rx.instructions.hi}</div>}
              </div>
            )}
          </div>
        )}

        {/* Mandatory Regulatory Disclaimer — Section 4.4 */}
        <div style={{ margin: '6px 14px 0', padding: '5px 10px', background: '#FFF1F2', border: '1px solid #FECDD3', borderRadius: 6, textAlign: 'center', fontSize: 10, color: '#9F1239', fontWeight: 600 }}>
          Clinical decision support only. Doctor verification mandatory.
        </div>

        {/* Footer: QR Code Opt-in + Doctor Signature */}
        <div style={{ borderTop: `1px solid ${P.border}`, padding: '9px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          {/* Section 4.4 & 9.2: QR Code linking patient to WhatsApp reminder opt-in */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={qrImgUrl}
              alt="WhatsApp Reminder QR"
              style={{ width: 52, height: 52, border: `1px solid ${P.border}`, borderRadius: 6, display: 'block' }}
            />
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: P.navy }}>WhatsApp Reminders</div>
              <div style={{ fontSize: 9, color: P.muted }}>Scan to activate daily dose alerts</div>
              <div style={{ fontSize: 8, color: P.blue, fontFamily: 'monospace', marginTop: 2 }}>Token: {rxToken}</div>
            </div>
          </div>

          {/* Doctor Signature Block */}
          <div style={{ textAlign: 'center', minWidth: 140 }}>
            {doc.signatureUrl ? (
              <img src={doc.signatureUrl} alt="Signature" style={{ height: 34, display: 'block', margin: '0 auto 4px', transform: 'rotate(-4deg)', opacity: .9 }} />
            ) : (
              <div style={{ height: 32, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', marginBottom: 2 }}>
                <span style={{ fontSize: 16, fontFamily: 'Georgia,serif', fontStyle: 'italic', color: P.navy, transform: 'rotate(-4deg)', display: 'inline-block' }}>
                  {doc.name?.split(' ')[0] || 'Doctor'}
                </span>
              </div>
            )}
            <div style={{ borderTop: `1.5px solid ${P.navy}`, paddingTop: 2, fontSize: 10, fontWeight: 700 }}>{doc.name || 'Treating Doctor'}</div>
            {doc.registrationNumber && <div style={{ fontSize: 9, color: P.muted }}>Reg: {doc.registrationNumber}</div>}
            {isApproved && rx.approved_at && (
              <div style={{ fontSize: 8, color: P.muted, marginTop: 1 }}>
                Approved: {new Date(rx.approved_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        </div>

        {/* Bottom navy band */}
        <div style={{ background: P.navy, padding: '5px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: P.pb }}>Powered by <b style={{ color: '#fff' }}>Trik</b><b style={{ color: P.coral }}>Med</b></span>
          <span style={{ fontSize: 9, color: P.pb }}>ABDM Compliant · Digitally Verified Parche</span>
          <span style={{ fontSize: 9, color: P.pb }}>Not valid without signature</span>
        </div>
      </div>
    </>
  )
}
