'use client'
import { useState, useRef, useEffect } from 'react'
import { Mic, MicOff, Loader2, X, CheckCircle, AlertCircle } from 'lucide-react'
import api from '../../services/api'

/**
 * VoiceButton — AI Voice Dictation
 *
 * Flow:
 *   1. Doctor clicks → microphone turns on
 *   2. Browser SpeechRecognition provides a best-effort live preview
 *   3. Doctor clicks Stop → the recorded audio is transcribed on the server
 *   4. The verified transcript is structured into a prescription
 *   5. Parsed medicines/symptoms/diagnosis fill the form automatically
 *
 * Storage: the audio and transcript are sent only to the configured API for
 * this request. They are not stored by this component; the parsed result fills
 * the current prescription form fields.
 */
export default function VoiceButton({
  onTranscript,
  onPrescriptionParsed,
  patientName = '',
  patientAge = null,
  doctorName = '',
  size = 'sm',
}) {
  const [phase, setPhase] = useState('idle') // idle | recording | processing | done | error
  const [seconds, setSeconds] = useState(0)
  const [liveText, setLiveText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [showPanel, setShowPanel] = useState(false)
  const [result, setResult] = useState(null)

  const mediaRecorderRef = useRef(null)
  const mediaStreamRef   = useRef(null)
  const audioChunksRef   = useRef([])
  const timerRef         = useRef(null)
  const recognitionRef   = useRef(null)
  const isRecordingRef   = useRef(false)
  const isStartingRef    = useRef(false)
  const accumulatedRef   = useRef('')   // accumulated final transcript segments
  const panelRef         = useRef(null)

  const sz = size === 'sm' ? 14 : 16

  // Close panel on outside click
  useEffect(() => {
    const h = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        if (phase === 'idle' || phase === 'done' || phase === 'error') {
          setShowPanel(false)
        }
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [phase])

  // Releasing the stream is important: otherwise the browser can keep the
  // microphone locked after the panel is closed or the screen is changed.
  function releaseMicrophone() {
    mediaStreamRef.current?.getTracks().forEach(track => track.stop())
    mediaStreamRef.current = null
  }

  useEffect(() => () => {
    clearInterval(timerRef.current)
    isRecordingRef.current = false
    try { recognitionRef.current?.stop() } catch {}
    releaseMicrophone()
  }, [])

  async function startRecording() {
    if (isStartingRef.current || isRecordingRef.current) return
    isStartingRef.current = true
    setErrorMsg('')
    setLiveText('')
    setFinalText('')
    accumulatedRef.current = ''
    audioChunksRef.current = []
    setSeconds(0)
    setResult(null)
    setShowPanel(true)
    isRecordingRef.current = true

    // ── 1. MediaRecorder (audio capture for backend) ───────────────────────
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('This browser does not support microphone recording.')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      mediaStreamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported?.('audio/mp4')
          ? 'audio/mp4'
          : ''
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      mediaRecorder.start(500)
    } catch (err) {
      releaseMicrophone()
      mediaRecorderRef.current = null
      isRecordingRef.current = false
      isStartingRef.current = false
      setPhase('error')
      setErrorMsg(err?.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser settings, then try again.'
        : err?.message || 'Could not start the microphone. Check that it is connected and not in use by another app.')
      return
    }

    // Browser speech recognition is deliberately disabled in production.
    // Backend ASR is the only medical transcription source; the browser only
    // captures audio so recognition quality is consistent across browsers.
    const SpeechRecognition = null
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition()
      recognition.lang = 'en-IN'
      recognition.continuous = true
      recognition.interimResults = true
      recognition.onresult = (event) => {
        let interim = ''
        let finalSegments = ''
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const text = event.results[index][0]?.transcript || ''
          if (event.results[index].isFinal) finalSegments += text
          else interim += text
        }
        if (finalSegments) accumulatedRef.current = `${accumulatedRef.current} ${finalSegments}`.trim()
        setLiveText(`${accumulatedRef.current} ${interim}`.trim())
      }
      recognition.onerror = (event) => {
        // "no-speech" and "aborted" are normal while recording. The audio
        // upload is still available, so do not make the whole dictation fail.
        if (!['no-speech', 'aborted'].includes(event.error)) console.warn('Speech recognition preview unavailable:', event.error)
      }
      recognition.onend = () => {
        if (isRecordingRef.current) {
          try { recognition.start() } catch {}
        }
      }
      recognitionRef.current = recognition
      try { recognition.start() } catch (err) { console.warn('Could not start live speech preview:', err) }
    }

    // ── 3. Timer ────────────────────────────────────────────────────────────
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
    isStartingRef.current = false
    setPhase('recording')
  }

  async function stopRecording() {
    if (isStartingRef.current) return
    clearInterval(timerRef.current)
    isRecordingRef.current = false

    // Stop recognition
    if (recognitionRef.current) {
      recognitionRef.current.onend = null   // prevent auto-restart
      try { recognitionRef.current.stop() } catch {}
      recognitionRef.current = null
    }

    setPhase('processing')

    try {
      const recorder = mediaRecorderRef.current
      if (!recorder || recorder.state === 'inactive') {
        throw new Error('No audio was captured. Please try again.')
      }

      // MediaRecorder emits its last chunk asynchronously. Waiting for `stop`
      // prevents the previous empty-upload race that left the UI recording.
      const audioBlob = await new Promise((resolve, reject) => {
        recorder.addEventListener('stop', () => {
          const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          if (blob.size === 0) reject(new Error('No audio was captured. Please try again.'))
          else resolve(blob)
        }, { once: true })
        recorder.addEventListener('error', () => reject(new Error('Microphone recording failed. Please try again.')), { once: true })
        recorder.stop()
      })
      releaseMicrophone()
      mediaRecorderRef.current = null

      const liveTranscript = ''
      const fd = new FormData()
      const extension = audioBlob.type.includes('mp4') ? 'm4a' : 'webm'
      if (audioBlob) fd.append('file', audioBlob, `dictation.${extension}`)
      fd.append('language_hint', 'hi-IN')
      if (patientName) fd.append('patient_name', patientName)
      if (patientAge)  fd.append('patient_age', String(patientAge))
      if (doctorName)  fd.append('doctor_name', doctorName)

      let res = null
      try {
        res = await api.upload('/ai/voice-to-prescription', fd)
      } catch (uploadErr) {
        console.warn('Backend audio upload failed:', uploadErr)
        throw new Error(uploadErr?.message || uploadErr?.detail || 'Voice transcription failed. Please try again.')
      }

      // If backend was unreachable or returned empty, build a client-side parsed draft
      // Never build a clinical prescription from browser heuristics in a real
      // session. The server is the single extraction/validation authority.
      if (!res && liveTranscript && process.env.NODE_ENV === 'test') {
        const text = liveTranscript
        const lower = text.toLowerCase()

        // 1. UNIVERSAL SYMPTOM EXTRACTOR (Captures all spoken symptoms & severity)
        const symptoms = []
        const symptomRules = [
          { pattern: /\b(chest pain|seene mein dard|chhati mein dard|seene me dard)\b/i, label: 'Chest pain' },
          { pattern: /\b(saans phoolna|breathlessness|shortness of breath|dyspnea)\b/i, label: 'Breathlessness' },
          { pattern: /\b(bhari sar dard|severe headache|tez sar dard)\b/i, label: 'Severe Headache' },
          { pattern: /\b(sar dard|headache|sir dard|sar me dard)\b/i, label: 'Headache' },
          { pattern: /\b(tej tapman|high fever|high temperature|tez bukhar)\b/i, label: 'High Fever' },
          { pattern: /\b(tapman|bukhar|fever|taap)\b/i, label: 'Fever' },
          { pattern: /\b(pet dard|stomach ache|abdominal pain|pet kharab|stomach pain)\b/i, label: 'Abdominal pain' },
          { pattern: /\b(gala kharab|gale mein dard|throat pain|sore throat|kharash)\b/i, label: 'Sore throat' },
          { pattern: /\b(khansi|cough|sardi|jukaam|cold|runny nose)\b/i, label: 'Cough & Cold' },
          { pattern: /\b(chakkar|dizziness|vertigo)\b/i, label: 'Dizziness / Vertigo' },
          { pattern: /\b(ghabrahat|anxiety|restlessness|palpitation)\b/i, label: 'Palpitation / Anxiety' },
          { pattern: /\b(dast|diarrhea|loose motion)\b/i, label: 'Diarrhea' },
          { pattern: /\b(vomiting|ulti|nausea)\b/i, label: 'Nausea & Vomiting' },
          { pattern: /\b(sujan|swelling|edema)\b/i, label: 'Swelling' },
          { pattern: /\b(khujli|itching|rash)\b/i, label: 'Skin Rash / Itching' },
          { pattern: /\b(joint pain|body ache|badan dard|kamar dard|back pain)\b/i, label: 'Body ache / Pain' },
        ]
        for (const rule of symptomRules) {
          if (rule.pattern.test(text) && !symptoms.includes(rule.label)) {
            symptoms.push(rule.label)
          }
        }

        // 2. UNIVERSAL DRUG & MEDICINE EXTRACTOR (Matches all brand names + open regex matches)
        const extractedMeds = []
        const seenNames = new Set()
        const seenBases = new Set()

        // A. Primary Dictionary of Indian Brands & Formulations
        const DRUG_CATALOG = [
          { match: /\b(nitro\s*glycerine|nitro\s*glycerin|nitroglycerin|nitroglycerine|nitrocontin)\b/i, name: 'Nitrocontin 2.6', defaultDose: '2.6mg', band: 'green', matched: 'Nitrocontin 2.6' },
          { match: /\b(pant\s*40|pan\s*40|pantocid\s*40)\b/i, name: 'Pan 40', defaultDose: '40mg', band: 'green', matched: 'Pan 40' },
          { match: /\b(diploma\s*mall|diploma\s*mole|diplomall|diclomol|diclo\s*mol)\b/i, name: 'Diclomol 200', defaultDose: '200mg', band: 'green', matched: 'Diclomol 200' },
          { match: /\b(dolo|do\s*low|duo\s*low|dolow)\b/i, name: 'Dolo 650', defaultDose: '650mg', band: 'green', matched: 'Dolo 650' },
          { match: /\b(crocin)\b/i, name: 'Crocin 650', defaultDose: '650mg', band: 'green', matched: 'Crocin 650' },
          { match: /\b(calpol)\b/i, name: 'Calpol 500', defaultDose: '500mg', band: 'green', matched: 'Calpol 500' },
          { match: /\b(augmentin|ogmentin|augmenten)\b/i, name: 'Augmentin 625', defaultDose: '625mg', band: 'green', matched: 'Augmentin 625' },
          { match: /\b(clavam)\b/i, name: 'Clavam 625', defaultDose: '625mg', band: 'green', matched: 'Clavam 625' },
          { match: /\b(pan\s*d|pantocid\s*dsr)\b/i, name: 'Pan D', defaultDose: '40mg+30mg', band: 'green', matched: 'Pan D' },
          { match: /\b(pantocid)\b/i, name: 'Pantocid 40', defaultDose: '40mg', band: 'green', matched: 'Pantocid 40' },
          { match: /\b(azithral|azithromycin|zithromax)\b/i, name: 'Azithral 500', defaultDose: '500mg', band: 'green', matched: 'Azithral 500' },
          { match: /\b(montair\s*lc|levocetirizine)\b/i, name: 'Montair-LC', defaultDose: '5mg+10mg', band: 'green', matched: 'Montair-LC' },
          { match: /\b(allegra|fexofenadine)\b/i, name: 'Allegra 120', defaultDose: '120mg', band: 'green', matched: 'Allegra 120' },
          { match: /\b(ecosprin|aspirin)\b/i, name: 'Ecosprin 75', defaultDose: '75mg', band: 'green', matched: 'Ecosprin 75' },
          { match: /\b(monocef)\b/i, name: 'Monocef 1g', defaultDose: '1g', band: 'green', matched: 'Monocef 1g' },
          { match: /\b(combiflam)\b/i, name: 'Combiflam', defaultDose: '400mg+325mg', band: 'green', matched: 'Combiflam' },
          { match: /\b(meftal\s*spas)\b/i, name: 'Meftal-Spas', defaultDose: '250mg+10mg', band: 'green', matched: 'Meftal-Spas' },
          { match: /\b(taxim\s*o|cefixime)\b/i, name: 'Taxim-O 200', defaultDose: '200mg', band: 'green', matched: 'Taxim-O 200' },
          { match: /\b(telma|telmisartan)\b/i, name: 'Telma 40', defaultDose: '40mg', band: 'green', matched: 'Telma 40' },
          { match: /\b(glycomet|metformin)\b/i, name: 'Glycomet 500', defaultDose: '500mg', band: 'green', matched: 'Glycomet 500' },
          { match: /\b(paracetamol)\b/i, name: 'Dolo 650', defaultDose: '650mg', band: 'yellow', matched: 'Dolo 650' },
        ]

        for (const item of DRUG_CATALOG) {
          const itemBase = item.name.split(' ')[0].toLowerCase()
          if (item.match.test(text) && !seenBases.has(itemBase) && !seenNames.has(item.name)) {
            seenNames.add(item.name)
            seenBases.add(itemBase)
            
            // Extract dosage specific to this medicine clause
            let dose = item.defaultDose
            const matchIndex = text.search(item.match)
            let itemSnippet = lower
            if (matchIndex !== -1) {
              const followingText = text.substring(matchIndex)
              // Bound snippet to next "aur", punctuation, or 120 chars to avoid leaking into next drug
              const nextBoundary = followingText.search(/(?:aur\s+(?:gale|pet|patient|blood)|[.;\n]|$)/i)
              itemSnippet = followingText.substring(0, nextBoundary > 20 ? nextBoundary : 120).toLowerCase()
            }
            const itemDoseMatch = itemSnippet.match(/(\d+\s*(?:mg|ml|gm|g|mcg|iu))/i)
            if (itemDoseMatch) dose = itemDoseMatch[1].replace(/\s+/g, '')

            let freq = '1-0-1'
            let morn = true, aft = false, night = true
            if (/(din mein do baar|do baar|do time|twice|subah shaam)/i.test(itemSnippet)) {
              freq = '1-0-1'; morn = true; aft = false; night = true
            } else if (/(din mein ek baar|ek baar|ek time|once|roz ek|subah khane|sirf subah)/i.test(itemSnippet)) {
              freq = '1-0-0'; morn = true; aft = false; night = false
            } else if (/(teen baar|teen time|thrice|subah dopahar raat)/i.test(itemSnippet)) {
              freq = '1-1-1'; morn = true; aft = true; night = true
            } else if (/(raat ko|sote waqt|night)/i.test(itemSnippet)) {
              freq = '0-0-1'; morn = false; aft = false; night = true
            }

            let dur = '3 days'
            const durMatch = itemSnippet.match(/(\d+)\s*(?:din|days|day)/i)
            if (durMatch) dur = `${durMatch[1]} days`

            let afterFood = true
            if (/(khali pet|khane se pahle|khane ke pahle|bhookhe pet|empty stomach|before food)/i.test(itemSnippet)) {
              afterFood = false
            } else if (/(khane ke bad|khane ke baad|after food)/i.test(itemSnippet)) {
              afterFood = true
            }

            extractedMeds.push({
              name: item.name,
              dose: dose,
              frequency: freq,
              duration: dur,
              morning: morn,
              afternoon: aft,
              night: night,
              after_food: afterFood,
              validation_band: item.band,
              validation_status: item.band === 'green' ? 'verified' : 'needs_confirmation',
              matched_name: item.matched,
            })
          }
        }

        // B. Open-Vocabulary Drug Regex (Catches ANY unlisted medicine + dosage)
        const openDrugRegex = /\b([A-Za-z][A-Za-z0-9\-_]{2,20})\s+(\d+\s*(?:mg|ml|gm|g|mcg)?)\b/gi
        let match
        while ((match = openDrugRegex.exec(text)) !== null) {
          const rawDrugName = match[1]
          const rawBase = rawDrugName.toLowerCase()
          const rawDose = match[2].replace(/\s+/g, '')
          if (!seenBases.has(rawBase) && !seenNames.has(rawDrugName) && !seenNames.has(rawBase) && !['fever', 'headache', 'pain', 'tablet', 'syrup', 'test', 'lap', 'lab', 'patient', 'liye', 'din'].includes(rawBase)) {
            seenNames.add(rawDrugName)
            seenBases.add(rawBase)
            extractedMeds.push({
              name: rawDrugName,
              dose: rawDose,
              frequency: '1-0-1',
              duration: '3 days',
              morning: true,
              afternoon: false,
              night: true,
              after_food: true,
              validation_band: 'yellow',
              validation_status: 'needs_confirmation',
              matched_name: rawDrugName,
            })
          }
        }

        // 3. UNIVERSAL INVESTIGATION & LAB TEST EXTRACTOR (Captures all spoken tests)
        const investigations = []
        const knownTestMap = [
          { pattern: /\b(cbc|complete blood count|cbc lap test|cbc lab test|sidhi\s*si|seedhi\s*si)\b/i, name: 'CBC (Complete Blood Count)' },
          { pattern: /\b(lipid profile|lipid test|cholesterol panel|cholesterol test)\b/i, name: 'Lipid Profile' },
          { pattern: /\b(lft|liver function test)\b/i, name: 'Liver Function Test (LFT)' },
          { pattern: /\b(kft|kidney function test|renal function)\b/i, name: 'Kidney Function Test (KFT)' },
          { pattern: /\b(fasting sugar|blood sugar fasting|sugar test|rbs)\b/i, name: 'Blood Sugar Fasting' },
          { pattern: /\b(pp sugar|blood sugar pp)\b/i, name: 'Blood Sugar PP' },
          { pattern: /\b(hba1c)\b/i, name: 'HbA1c' },
          { pattern: /\b(urine r\/?m|urine routine|urine culture)\b/i, name: 'Urine R/M' },
          { pattern: /\b(thyroid|tsh|t3 t4 tsh)\b/i, name: 'Thyroid Profile (TSH)' },
          { pattern: /\b(chest x-?ray|x-?ray chest)\b/i, name: 'Chest X-Ray' },
          { pattern: /\b(ecg|electrocardiogram)\b/i, name: 'ECG' },
          { pattern: /\b(ultrasound|usg abdomen|sonography)\b/i, name: 'Ultrasound Abdomen' },
          { pattern: /\b(widal|typhoid test|typhoid widal)\b/i, name: 'Typhoid Widal' },
          { pattern: /\b(dengue|dengue ns1)\b/i, name: 'Dengue NS1+IgM' },
          { pattern: /\b(crp|c-reactive protein)\b/i, name: 'CRP' },
          { pattern: /\b(vitamin d|vitamin d3)\b/i, name: 'Vitamin D3 (25-OH)' },
          { pattern: /\b(vitamin b12|b12 test)\b/i, name: 'Vitamin B12' },
          { pattern: /\b(serum calcium|calcium test)\b/i, name: 'Serum Calcium' },
        ]
        for (const testItem of knownTestMap) {
          if (testItem.pattern.test(text) && !investigations.includes(testItem.name)) {
            investigations.push(testItem.name)
          }
        }

        // Open regex for any other custom test spoken: e.g. "... test karvana hai", "... scan karvana hai"
        const customTestRegex = /\b([A-Za-z0-9\s\-\+\/]{2,25})\s+(?:lap\s+test|lab\s+test|test|jaanch|scan|culture|screen)\b/gi
        let customTestMatch
        while ((customTestMatch = customTestRegex.exec(text)) !== null) {
          const testName = customTestMatch[1].trim()
          if (testName.length > 2 && !['karna', 'karvana', 'karana', 'aur', 'uske', 'yeh', 'unhe', 'blood', 'sidhi', 'si'].includes(testName.toLowerCase())) {
            const formatted = testName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            if (!investigations.some(inv => inv.toLowerCase().includes(testName.toLowerCase()))) {
              investigations.push(formatted)
            }
          }
        }

        // 4. UNIVERSAL DIETARY & LIFESTYLE INSTRUCTION EXTRACTOR (Captures all doctor advice)
        const instruction_tags = []
        const knownInstructions = [
          { pattern: /\b(avoid oily and spicy food|oily and spicy food avoid|tel mirch masala avoid|oily food avoid|spicy food avoid|oily khana avoid|oily khana)\b/i, name: 'Avoid oily and spicy food' },
          { pattern: /\b(bed rest|bed rest advised|aaram karna|rest karna)\b/i, name: 'Bed rest advised' },
          { pattern: /\b(plenty of fluids|paani khoob peena|paani zyada|fluids|water intake)\b/i, name: 'Plenty of fluids (2-3 litres per day)' },
          { pattern: /\b(low salt|kam namak|salt restriction)\b/i, name: 'Low salt diet' },
          { pattern: /\b(avoid sweets|sugar avoid|mithai band|sugar band)\b/i, name: 'Diabetic diet — avoid sweets' },
          { pattern: /\b(steam inhalation|bhap lena|bhaap)\b/i, name: 'Steam inhalation twice daily' },
          { pattern: /\b(gargle|garare|namak paani)\b/i, name: 'Warm saline gargles' },
          { pattern: /\b(walk 30 minutes|walk daily|tahalna)\b/i, name: 'Walk 30 minutes daily' },
          { pattern: /\b(complete course|dawa ka pura course)\b/i, name: 'Take complete course of medicines' },
        ]
        for (const instr of knownInstructions) {
          if (instr.pattern.test(text) && !instruction_tags.includes(instr.name)) {
            instruction_tags.push(instr.name)
          }
        }

        // Catch any custom spoken "avoid ..." or "... band karna" phrases
        const customAvoidMatch = text.match(/\b([a-zA-Z\s]{3,30})\s+(?:avoid\s+karna|band\s+karna|se\s+parhez)\b/i)
        if (customAvoidMatch) {
          const avoidItem = `Avoid ${customAvoidMatch[1].trim()}`
          if (!instruction_tags.includes(avoidItem)) instruction_tags.push(avoidItem)
        }

        let followUpVal = '3 days'
        if (lower.includes('3 din') || lower.includes('3 days') || lower.includes('teen din')) followUpVal = '3 days'
        else if (lower.includes('hafta') || lower.includes('week') || lower.includes('7 din')) followUpVal = '1 week'
        else if (lower.includes('2 weeks') || lower.includes('do hafte')) followUpVal = '2 weeks'
        else if (lower.includes('sos') || lower.includes('zaroorat padne par')) followUpVal = 'SOS'

        res = {
          patient_name: patientName || '',
          age: patientAge || 0,
          symptoms: symptoms.length ? symptoms : ['Fever & Headache'],
          diagnosis: (symptoms.includes('High Fever') || symptoms.includes('Fever')) && symptoms.includes('Headache') ? 'Acute Febrile Illness / Headache' : 'General OPD Consultation',
          medicines: extractedMeds,
          investigations: investigations,
          instruction_tags: instruction_tags,
          follow_up: followUpVal,
          notes: 'Follow up if no improvement. Avoid oily and spicy food, bed rest advised.',
          transcript: text,
          confidence: 0.95
        }
      }

      if (res?.transcript) {
        setFinalText(res.transcript)
        accumulatedRef.current = res.transcript
        setLiveText(res.transcript)
        onTranscript?.(res.transcript)
      }

      if (!res) throw new Error('No speech was detected. Please try speaking again.')

      setResult(res)
      setPhase('done')
      onPrescriptionParsed?.(res)
    } catch (err) {
      releaseMicrophone()
      mediaRecorderRef.current = null
      // Already shown to the doctor via errorMsg below — console.warn, not .error,
      // so an expected/handled failure doesn't surface as a Next.js dev-overlay "Issue".
      console.warn('AI voice error:', err)
      setPhase('error')
      setErrorMsg(err?.message || 'Processing failed. Please try again.')
    }
  }

  function toggle() {
    if (phase === 'recording') stopRecording()
    else if (phase === 'idle' || phase === 'done' || phase === 'error') startRecording()
  }

  function dismiss() {
    if (phase === 'recording') {
      clearInterval(timerRef.current)
      isRecordingRef.current = false
      try { recognitionRef.current?.stop() } catch {}
      try { mediaRecorderRef.current?.stop() } catch {}
      mediaRecorderRef.current = null
      releaseMicrophone()
    }
    isStartingRef.current = false
    setShowPanel(false)
    setPhase('idle')
    setLiveText('')
    setFinalText('')
    setResult(null)
    setErrorMsg('')
  }

  // ── Button label / icon ───────────────────────────────────────────────────
  const btnStyle = {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '6px 14px', borderRadius: '12px',
    cursor: phase === 'processing' ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', fontSize: '12px', fontWeight: 600,
    transition: 'all 0.15s ease',
    border: phase === 'recording' ? '1.5px solid #E84C3D'
          : phase === 'done'      ? '1.5px solid #16A34A'
          : phase === 'error'     ? '1.5px solid #DC2626'
          :                         '1.5px solid #BFDBFE',
    background: phase === 'recording' ? '#FEE2E2'
              : phase === 'done'      ? '#DCFCE7'
              : phase === 'error'     ? '#FEE2E2'
              :                         '#EFF6FF',
    color: phase === 'recording' ? '#E84C3D'
         : phase === 'done'      ? '#16A34A'
         : phase === 'error'     ? '#DC2626'
         :                         '#0F2342',
  }

  return (
    <div ref={panelRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* ── Main button ── */}
      <button
        type="button"
        onClick={toggle}
        disabled={phase === 'processing'}
        title={phase === 'recording' ? 'Stop & process dictation' : 'Start AI voice dictation'}
        style={btnStyle}
      >
        {phase === 'processing' ? (
          <><Loader2 size={sz} className="animate-spin" /><span>Processing…</span></>
        ) : phase === 'recording' ? (
          <><MicOff size={sz} /><span>Stop ({seconds}s)</span></>
        ) : phase === 'done' ? (
          <><CheckCircle size={sz} /><span>Voice Rx ✓</span></>
        ) : phase === 'error' ? (
          <><AlertCircle size={sz} /><span>Try Again</span></>
        ) : (
          <><Mic size={sz} color="#0F2342" /><span>AI Voice Rx</span></>
        )}
      </button>

      {/* ── Recording Status + result panel ── */}
      {showPanel && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0,
          width: 360, zIndex: 500,
          background: '#fff', borderRadius: 12,
          border: '1.5px solid #E4E6EB',
          boxShadow: '0 8px 32px rgba(0,0,0,.14)',
          overflow: 'hidden',
          fontFamily: "'Segoe UI', Inter, sans-serif",
        }}>
          {/* Panel header */}
          <div style={{
            padding: '10px 14px',
            background: phase === 'recording' ? '#FEE2E2'
                      : phase === 'done'      ? '#DCFCE7'
                      : phase === 'error'     ? '#FEE2E2'
                      :                         '#EFF6FF',
            display: 'flex', alignItems: 'center', gap: 8,
            borderBottom: '1px solid #E4E6EB',
          }}>
            {phase === 'recording' && (
              <>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#E84C3D', display: 'inline-block', animation: 'pulse 1s infinite' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#E84C3D', flex: 1 }}>Recording… {seconds}s — click Stop when done</span>
              </>
            )}
            {phase === 'processing' && (
              <>
                <Loader2 size={12} className="animate-spin" style={{ color: '#0F2342' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#0F2342', flex: 1 }}>AI is structuring your prescription…</span>
              </>
            )}
            {phase === 'done' && (
              <>
                <CheckCircle size={12} color="#16A34A" />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#16A34A', flex: 1 }}>Prescription filled from voice ✓</span>
              </>
            )}
            {phase === 'error' && (
              <>
                <AlertCircle size={12} color="#DC2626" />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#DC2626', flex: 1 }}>Error</span>
              </>
            )}
            <button onClick={dismiss} type="button"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: '#6B7A9A' }}>
              <X size={14} />
            </button>
          </div>

          {/* Recording Status box */}
          <div style={{ padding: '10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#6B7A9A', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {phase === 'recording' ? 'Recording Status' : 'Transcript used'}
            </div>
            <div style={{
              minHeight: 60, maxHeight: 120, overflowY: 'auto',
              background: '#F8F9FA', borderRadius: 8,
              padding: '8px 10px',
              fontSize: 13, color: '#1F2937', lineHeight: 1.6,
              border: '1px solid #E4E6EB',
            }}>
              {liveText || finalText || (
                <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>
                  {phase === 'recording' ? 'Start speaking… (speak in English or Hindi)' : 'No transcript captured'}
                </span>
              )}
            </div>

            {/* Error message */}
            {phase === 'error' && errorMsg && (
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#FEE2E2', borderRadius: 8, fontSize: 12, color: '#991B1B' }}>
                {errorMsg}
              </div>
            )}

            {/* Structuring failed — transcript above is still real; nothing was fabricated */}
            {phase === 'done' && result?.error && (
              <div style={{ marginTop: 10, padding: '8px 10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 12, color: '#92400E' }}>
                {result.error} Transcript upar hai — medicines manually add karein.
              </div>
            )}

            {/* Result summary */}
            {phase === 'done' && result?.prescription && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#6B7A9A', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Added to prescription
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {result.prescription.symptoms?.length > 0 && (
                    <span style={{ fontSize: 11, background: '#EFF6FF', color: '#1D4ED8', padding: '3px 8px', borderRadius: 6, fontWeight: 600 }}>
                      {result.prescription.symptoms.length} symptom{result.prescription.symptoms.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {result.prescription.diagnosis && (
                    <span style={{ fontSize: 11, background: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: 6, fontWeight: 600 }}>
                      Diagnosis: {Array.isArray(result.prescription.diagnosis) ? result.prescription.diagnosis[0] : result.prescription.diagnosis}
                    </span>
                  )}
                  {result.prescription.medicines?.length > 0 && (
                    <span style={{ fontSize: 11, background: '#DCFCE7', color: '#166534', padding: '3px 8px', borderRadius: 6, fontWeight: 600 }}>
                      {result.prescription.medicines.length} medicine{result.prescription.medicines.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {result.prescription.investigations?.length > 0 && (
                    <span style={{ fontSize: 11, background: '#F3E8FF', color: '#7E22CE', padding: '3px 8px', borderRadius: 6, fontWeight: 600 }}>
                      {result.prescription.investigations.length} test{result.prescription.investigations.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {result.prescription.llm_latency_ms && (
                    <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 'auto' }}>
                      {Math.round(result.prescription.llm_latency_ms)}ms
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Action footer */}
          {(phase === 'done' || phase === 'error') && (
            <div style={{ padding: '8px 14px', borderTop: '1px solid #E4E6EB', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={dismiss} type="button"
                style={{ fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 8, border: '1.5px solid #D3D1C7', background: '#fff', color: '#374151', cursor: 'pointer' }}>
                Close
              </button>
              <button onClick={() => { dismiss(); setTimeout(startRecording, 100) }} type="button"
                style={{ fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 8, border: 'none', background: '#0F2342', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Mic size={12} /> Dictate Again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
