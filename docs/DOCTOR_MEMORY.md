# Doctor Memory — AI jo har doctor ki aadat seekhta hai

**Goal:** kuch hi dinon mein TrikMed doctor ki aadat jaan le. Doctor "Dolo" bole toh system jaane ki ye doctor
hamesha Dolo 650 deta hai. Har hafte doctor ke taps kam hon.

**Safety ka rule:** memory sirf *suggest* karti hai. Final decision hamesha doctor ka.

---

## 1. Ye kya seekhta hai (4 cheezein)

| # | Seekhta hai | Example | Kaise dikhega |
|---|---|---|---|
| 1 | **Usual strength / form** | Doctor 3+ baar "Dolo" bol ke Dolo 650 approve kare (70%+ baar) | "Dolo" yellow aayega, lekin **"Aapka usual: Dolo 650 mg (12 baar)"** option sabse upar, ek tap |
| 2 | **Usual regimen** | Dolo 650 hamesha 1-0-1, 3 din, khane ke baad | Doctor ne frequency nahi boli toh **suggestion chip** dikhega. Bola hai toh kuch nahi |
| 3 | **Doctor ka apna awaaz-alias** | Iske bolne pe speech-to-text hamesha "ogmentin 625" likhta hai, aur doctor 3+ baar Augmentin DUO confirm kar chuka | Augmentin DUO **pehla candidate** dikhega, phir bhi confirm chahiye |
| 4 | **Diagnosis wise history** | "Viral fever" mein pichhle 3 baar kya diya | Alag panel: "Past prescribing history (reference only)". Prescription mein khud nahi judta |

Plus doctor ke liye ek page: "TrikMed ne aapke baare mein kya seekha", top medicines ke saath, aur **Reset** button.

## 2. Ye kya KABHI nahi karta
- Band green nahi karta. Field auto-fill nahi karta. Approve nahi karta.
- Draft ya unapproved prescription se nahi seekhta.
- Ek doctor ki aadat doosre doctor ya clinic ko nahi dikhata.
- Patient ka naam, phone, age, patient id store nahi karta.
- Fail ho toh prescription nahi rokta (suggestions bas khaali).
- 180 din se purani aadat bhool jaata hai (doctor brand badalte hain).

## 3. "RAG" ya LLM fine-tuning kyu nahi?
Ye aadat-wala data **structured** hai: kaunsi dawa, kitni baar, kaunsa regimen. Isko seedha count karke
nikalna (a) har suggestion ka reason dikha sakta hai ("12 baar diya"), (b) hallucinate nahi kar sakta,
(c) patient data kisi LLM ko nahi bhejta, (d) free aur fast hai. Vector search / embeddings tab lagenge jab
diagnosis matching mein zaroorat dikhe (jaise "fever with body ache" ≈ "viral fever"). Shuruat counting se.

## 4. Data flow
```
Doctor approve karta hai
   └─► approve route (approval SUCCESS ke baad)
         └─► events_from_approved_rx(rx) → doctor_rx_memory table mein rows (har medicine ki ek row)

Doctor agla prescription bolta hai
   └─► /ai/structure-prescription → CDCI validation → DoctorMemory.annotate(med)
         └─► har medicine pe `doctor_usual` / `suggested_regimen` (contract: ValidatedMedicine)

Doctor diagnosis likhta hai
   └─► GET /prescriptions/historical-suggestions → DoctorMemory.suggestions_for_diagnosis()
```

## 5. Files
- `backend/doctor_memory/memory.py` — saara logic (pure Python, tested)
- `backend/tests/test_doctor_memory.py` — 12 safety tests
- `backend/migrations/04_doctor_memory.sql` — `doctor_rx_memory` table
- `contract/openapi.yaml` — `GET/DELETE /doctors/me/memory`, `ValidatedMedicine.doctor_usual`, `suggested_regimen`

## 6. Wiring: Claude Code ke liye prompts (ek-ek karke, har ek alag branch/PR)

**Prompt 1 — Store functions**
```
backend/app/storage/supabase_store.py mein 3 functions add karo, baaki store functions ke pattern
(_insert, _select, _request) mein:
1. insert_memory_events(rows: list[dict]) -> None : table doctor_rx_memory, header
   "Prefer: resolution=ignore-duplicates" taaki same (prescription_id, label) dobara na jude.
2. get_memory_events(doctor_id, clinic_id, since_iso) -> list[dict] : dono filters ke saath,
   approved_at >= since_iso.
3. delete_memory(doctor_id, clinic_id) -> int : sirf us doctor + clinic ki rows.
Koi hardcoded doctor_id / clinic_id fallback nahi. Tests likho.
```

**Prompt 2 — Seekhna (approve ke baad)**
```
backend/app/api/routes/prescriptions.py ke approve route mein, approval SUCCESS hone ke BAAD:
events = events_from_approved_rx(approved_rx, doctor_id, clinic_id) (doctor_memory se),
phir store.insert_memory_events(...) ko BackgroundTasks se chalao.
Memory fail ho toh sirf log (bina patient data) karo, approval response pe koi asar nahi.
Test: unapproved prescription se events_from_approved_rx ValueError deta hai;
memory insert fail hone pe bhi approve 200 deta hai.
```

**Prompt 3 — Suggest karna (structure route)**
```
backend/app/api/routes/ai.py mein, CDCI validation ke baad har medicine pe
DoctorMemory(doctor_id, clinic_id, events).annotate(med) lagao. events = store.get_memory_events
(last 180 days), per doctor 10 minute cache. annotate validation_band, name ya kisi field ki value
nahi badlega, sirf doctor_usual aur suggested_regimen jodega (contract ka ValidatedMedicine dekho).
Memory fail = medicines waise hi return. Test likho ki band kabhi nahi badalta.
```

**Prompt 4 — History panel**
```
GET /prescriptions/historical-suggestions ko DoctorMemory.suggestions_for_diagnosis() pe shift karo.
Response format contract jaisa hi rakho. Hardcoded "CLN-001" / "dr001" hatao, identity missing = 401.
Failure = [] (empty list), kabhi error nahi.
```

**Prompt 5 — Memory endpoints**
```
contract/openapi.yaml mein GET aur DELETE /doctors/me/memory planned hain. Inhe banao
(require_doctor dependency, doctor_id/clinic_id token se). GET = DoctorMemory.summary().
DELETE = store.delete_memory(). Contract se x-trikmed-status: planned hata do. test_contract.py pass hona chahiye.
```

**Prompt 6 — Frontend (alag PR)**
```
frontend/src/components/rx/MedicineRow.jsx mein: agar medicine.doctor_usual hai toh options mein
use sabse upar "Aapka usual: <label> (<uses> baar)" chip ki tarah dikhao, ek tap pe select +
doctor_confirmed = true. suggested_regimen ho toh khaali field ke paas suggestion chip, tap pe hi
fill ho. Band ka colour waisa hi rahe jab tak doctor tap na kare. Aur "Sab usual confirm karein"
button jo sirf doctor_usual wali medicines ko confirm kare.
```

## 7. Kaam kar raha hai, kaise pata chalega
Har doctor ke liye har hafte: **taps per prescription** aur **% medicines jahan doctor ne usual chuna**.
Pehle hafte taps zyada honge. Teesre-chauthe hafte tak taps clearly kam hone chahiye. Yahi "AI doctor ka
dost ban gaya" ka asli measurement hai.
