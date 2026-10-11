# TrikMed — Claude Code Guide

TrikMed = WhatsApp-first clinic software for Tier 2-3 India. Doctor bolta hai, AI prescription banata hai,
doctor approve karta hai, patient ko WhatsApp pe reminders jaate hain.
**Ye healthcare software hai. Galat dawa ya galat dose = patient ko nuksaan. Speed se pehle safety.**

---

## Repo Structure
- `frontend/` — Next.js 16, React 19, Tailwind v4 (Vercel pe deploy)
- `backend/` — FastAPI, Python 3.11, Supabase via REST (`app/storage/supabase_store.py`), Railway pe deploy
- `contract/openapi.yaml` — **API contract. Har endpoint ka single source of truth.**
- `backend/drug_validation/` — CDCI drug matcher (`cdci_matcher.py`) + lab test matcher (`matcher.py`)
- `backend/doctor_memory/` — Doctor Memory (doctor ki aadatein seekhna). Design: `docs/DOCTOR_MEMORY.md`
- `backend/migrations/` — Supabase SQL migrations, number order mein apply hote hain

## Run Locally
- Frontend: `cd frontend && npm run dev`
- Backend: `cd backend && uvicorn main:app --reload`
- Backend tests: `cd backend && CDCI_FOLDER=<cdci folder ka full path> pytest`
- API docs: http://localhost:8000/docs

## Live URLs
- Frontend: https://trikmed.com / https://trikmedcom.vercel.app
- Backend API: https://trikmedweb-production.up.railway.app
- API Docs: https://trikmedweb-production.up.railway.app/docs

---

## 1. API Contract Rules (sabse zaroori)
Pehle ulte-seedhe endpoints bante the kyunki frontend aur backend ek doosre ko dekhte nahi the. Ab:

1. **Koi bhi endpoint banane, badalne ya hatane se PEHLE `contract/openapi.yaml` update karo.** Phir backend, phir frontend.
2. **Contract mein jo nahi hai, woh endpoint mat banao.** Zaroorat lage toh ruko aur poocho, khud se naam mat socho.
3. Frontend sirf wahi path call kare jo contract mein hai. Naya `api.get('/kuch-bhi')` likhne se pehle contract check karo.
4. Jo endpoint agreed hai lekin abhi bana nahi, uspe contract mein `x-trikmed-status: planned` lagao.
5. `backend/tests/test_contract.py` ye sab check karta hai. **Ye test fail hai toh kaam done nahi hai.**
6. Response ke field names contract ke schema jaise hi rakho (jaise `ValidatedMedicine`). Naam badalna = contract change.

## 2. Safety Rules (kabhi nahi todne)
1. **Approval gate:** prescription sirf doctor (`clinic_role` = doctor / doctor_owner) approve kar sakta hai, sirf
   `POST /prescriptions/{id}/approve` se. Koi AI route, background job ya fallback approve nahi karega.
   Approve fail hua toh print / WhatsApp / finalize kuch nahi hoga.
2. **Draft kabhi patient tak nahi:** Print aur WhatsApp sirf approved prescription ke liye. Draft pe "DRAFT, NOT APPROVED" watermark.
3. **AI drug naam nahi banata:** naam sirf CDCI reference (`drug_validation/cdci_matcher.py`) decide karta hai.
   Boli hui strength kabhi nahi badalni. Generic naam pe brand choose nahi karna.
4. **Koi fabricating fallback nahi:** LLM ya speech fail = 503 + "manually likhein". Stub parser production mein nahi.
5. **Koi invented default nahi:** "3 days", "1-0-1", "Tablet", confidence 0.95, "dr001", "CLN-001", "9876543210"
   jaisi values code mein kabhi nahi. Missing hai toh khaali chhodo aur UI mein "Not stated" dikhao.
6. **Har route pe auth:** `Depends(require_clinic_user)` (ya router-level `dependencies=[...]`). Bina token 401.
7. **Clinic scoping:** clinic data har query mein `clinic_id` se filter. Clinic A, clinic B ka kuch nahi dekh sakta.
8. **Logs mein patient data nahi:** transcript text, naam, phone, provider response body kabhi log mat karo.
   Sirf IDs, counts, status codes, latency.
9. **Provider calls sirf `app/ai/adapter.py` se.** Kisi aur file mein provider URL ya SDK nahi.
10. **Lab test aliases:** koi alias do tests pe point nahi karega. `scripts/build_free_drug_db.py` mat chalao,
    woh `seed_lab_tests.json` overwrite kar deta hai.

## 3. Doctor Memory Rules (AI jo doctor ki aadatein seekhta hai)
Pura design: `docs/DOCTOR_MEMORY.md`. Short mein:
1. Sirf **approved** prescriptions se seekhta hai. Draft se kabhi nahi.
2. Sirf **suggest** karta hai: "Aapka usual" option ko upar dikhana, ya jo field doctor ne nahi bola uska
   suggestion. **Kabhi band green nahi karta, kabhi field auto-fill nahi karta, kabhi approve nahi karta.**
3. Har doctor ki memory sirf usi doctor + clinic ki. Kisi aur doctor ki aadat kabhi nahi.
4. Memory table mein patient ki pehchaan (naam, phone, age, patient id) nahi rakhni.
5. Memory fail ho toh suggestions khaali, prescription kabhi nahi rukta.
6. Doctor dekh sakta hai kya seekha gaya (`GET /doctors/me/memory`) aur reset kar sakta hai (`DELETE`).

## 4. Code Rules
- Frontend change = sirf `frontend/` touch karo. Backend change = sirf `backend/` (+ contract agar endpoint badla).
- **Ek prompt mein ek kaam.**
- Backend imports: KABHI `from backend.xyz` mat likho, sirf `from xyz`.
- Naya backend feature = test ke saath. Pehle test likho, purane code pe fail hote dekho, phir fix.
- Kisi file ko "done" tab bolo jab: tests pass + real flow chala ke dekha (record → review → approve → server restart → data wapas aaye).

## 5. Git Rules (live clinics pe chal raha hai)
- **`main` pe seedha push mat karo.** `main` push hote hi Vercel aur Railway live deploy kar dete hain.
- Har kaam ke liye branch: `git checkout -b feat/<kaam-ka-naam>`
- Kaam ke baad: `cd backend && pytest` → sab pass → `git add -A && git commit -m "..." && git push -u origin <branch>`
- Phir Pull Request banao. Vikas review karke merge karega.
- `.env`, API keys, CDCI data files kabhi commit nahi.

## 6. Purane docs jo ab galat hain (inhe follow mat karo)
- "Drug Database Spec" (Sept 2026) ka 1mg / Netmeds scraping wala plan → **band**. Drug data ab sirf Govt CDCI (nrces.in, CC BY 4.0).
- Koi bhi doc jo 150-entry hand-typed drug list ya `scrape_drugs.py` ki baat kare → purana.
- Kahin doc aur code alag bolein: pehle Vikas se poocho, khud decide mat karo.
