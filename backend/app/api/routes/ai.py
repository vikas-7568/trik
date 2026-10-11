from __future__ import annotations

import time
import os
from typing import Any
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.ai.adapter import DeIdentifier, get_llm_client, get_speech_client
from app.services.drug_validator import drug_validator

router = APIRouter(prefix="/ai", tags=["AI Integration"])


class MedicineItemSchema(BaseModel):
    # spoken_name is the source-of-truth.  Validation may suggest a canonical
    # name, but it must never replace something the doctor did not say.
    spoken_name: str = ""
    canonical_name: str | None = None
    name: str = ""  # legacy UI compatibility; populated after validation
    dose: str | None = None
    unit: str | None = None
    frequency: str | None = None
    timing: str | None = None
    duration: str | None = None
    instructions: str | None = None
    morning: bool | None = None
    afternoon: bool | None = None
    night: bool | None = None
    after_food: bool | None = None
    before_food: bool | None = None


class StructuredPrescriptionSchema(BaseModel):
    patient_name: str = ""
    age: int = 0
    symptoms: list[str] | None = Field(default_factory=list)
    diagnosis: str = ""
    medicines: list[MedicineItemSchema] = Field(default_factory=list)
    investigations: list[Any] | None = Field(default_factory=list)
    instruction_tags: list[str] | None = Field(default_factory=list)
    advice: list[str] | None = Field(default_factory=list)
    follow_up: list[str] | str | None = Field(default_factory=list)
    warnings: list[str] | None = Field(default_factory=list)
    raw_transcript: str = ""
    normalized_transcript: str = ""
    extraction_warnings: list[str] | None = Field(default_factory=list)
    notes: str = ""
    confidence: float = 1.0


class StructureRequest(BaseModel):
    transcript: str
    patient_name: str | None = None
    patient_age: int | None = None
    doctor_name: str | None = None


def _build_system_prompt() -> str:
    """Build a grounded system prompt with Hinglish clinical rules and WHO ATC drug list."""
    # No drug list in the prompt: the model extracts what was spoken; CDCI validation decides.
    return f"""You are a clinical AI prescription structuring assistant for Indian clinics.
You convert doctor audio dictations (which frequently code-switch between Hindi, English, and Hinglish) into clean, standard structured JSON prescriptions.

HINGLISH & CLINICAL COMPREHENSION RULES:
1. CODE-SWITCHED HINGLISH DOSAGE FREQUENCY MAPPINGS:
   - "subah shaam" / "din mein do baar" / "do time" -> frequency: "1-0-1", morning: true, afternoon: false, night: true
   - "din mein teen baar" / "subah dopahar raat" / "teen time" -> frequency: "1-1-1", morning: true, afternoon: true, night: true
   - "sirf subah" / "roz subah ek baar" -> frequency: "1-0-0", morning: true, afternoon: false, night: false
   - "sirf raat ko" / "sote waqt" / "raat mein ek" -> frequency: "0-0-1", morning: false, afternoon: false, night: true
   - "dopahar ko" -> frequency: "0-1-0", morning: false, afternoon: true, night: false
   - "zaroorat padne par" / "jab dard ho tabhi" / "sos" -> frequency: "SOS", morning: false, afternoon: false, night: false

2. FOOD TIMING RULES:
   - "khana khane ke baad" / "nashte ke baad" / "khana kha kar" -> after_food: true, before_food: false
   - "khali pet" / "bhookhe pet" / "khana khane se pehle" / "subah khali pet" -> before_food: true, after_food: false

3. DURATION & FOLLOW-UP MAPPINGS:
   - "teen din" / "3 din tak" -> duration: "3 days"
   - "paanch din" / "5 din tak" -> duration: "5 days"
   - "ek hafta" / "saat din" -> duration: "1 week" / "7 days"

4. MULTIPLE MEDICINES & TESTS (STRICT RULE):
   - You MUST separate every medicine and every lab test into independent entries.
   - Example Input: "Dolo 650 subah shaam khane ke baad, Augmentin 625 din mein do baar five days, Pan 40 breakfast se pehle"
   - Must produce THREE separate medicine objects. NEVER combine them.
   - Example Input: "CBC, fasting sugar aur lipid profile"
   - Must produce THREE separate investigation strings in the array. NEVER combine them.

5. NO HALLUCINATION (CORE SAFETY RULE):
   - You are an EXTRACTOR, not a medical authority. Extract only information explicitly supported by the transcript.
   - NEVER invent, infer, substitute, or normalize a medicine/test into a different entity. Preserve uncertain terms verbatim in spoken_name.
   - Never invent a dose, frequency, duration, diagnosis, test, advice, or follow-up. Use null/empty arrays when absent.
   - Medicines must include the exact spoken_name.
"""


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language_hint: str = Form("hi-IN")
) -> dict[str, Any]:
    """Transcribe doctor speech to text using configured speech provider (adapter pattern)."""
    try:
        t0 = time.perf_counter()
        audio_bytes = await file.read()
        filename = getattr(file, "filename", None) or "audio.wav"

        speech = get_speech_client()
        transcript = speech.transcribe(audio_bytes, filename=filename, language_hint=language_hint)

        latency = (time.perf_counter() - t0) * 1000
        return {
            "success": True,
            "text": transcript.text,
            "language": transcript.language,
            "confidence": transcript.confidence,
            "model": os.getenv("ASR_MODEL", os.getenv("OPENAI_TRANSCRIPTION_MODEL", "large-v3")),
            "latency_ms": round(latency, 1)
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/structure-prescription")
def structure_prescription(payload: StructureRequest) -> dict[str, Any]:
    """Convert raw transcript into a validated structured prescription."""
    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript cannot be empty")

    # Step 1: De-identification (Section 12)
    scrubbed = DeIdentifier.scrub_text(
        transcript,
        patient_name=payload.patient_name,
        doctor_name=payload.doctor_name
    )

    # Do not pre-correct the transcript. RAG validates extracted spoken terms
    # afterwards; modifying the input here was the source of hallucinated drugs.
    t0 = time.perf_counter()
    llm = get_llm_client()
    structured: StructuredPrescriptionSchema = llm.complete(
        system=_build_system_prompt(),
        user=scrubbed,
        schema=StructuredPrescriptionSchema
    )
    llm_latency = (time.perf_counter() - t0) * 1000

    # Step 3: Re-attach local patient identity (Section 12.1)
    result_dict = structured.model_dump()
    result_dict["raw_transcript"] = transcript
    if isinstance(result_dict.get("follow_up"), str):
        result_dict["follow_up"] = [result_dict["follow_up"]] if result_dict["follow_up"] else []
    warnings = list(result_dict.get("extraction_warnings") or [])
    if payload.patient_name:
        result_dict["patient_name"] = payload.patient_name
    if payload.patient_age:
        result_dict["age"] = payload.patient_age

    # Step 4: 3-Band Drug Safety Layer (Section 5)
    validated_medicines = []
    has_unverified = False

    for med in result_dict.get("medicines", []):
        raw_name = (med.get("spoken_name") or med.get("name") or "").strip()
        # Reject an LLM-created entity. Do not try to recover it by asking RAG.
        if not raw_name or raw_name.casefold() not in transcript.casefold():
            warnings.append(f"Dropped unsupported medicine extraction: {raw_name or 'empty name'}")
            continue
        val = drug_validator.validate_medicine_name(raw_name)

        med_entry = {
            **med,
            "spoken_name": raw_name,
            "raw_name": raw_name,
            "canonical_name": val["matched_name"] if val["band"] == "green" else None,
            "matched_name": val["matched_name"],
            "proposed_generic_name": val.get("generic_name"),
            "match_method": val.get("method"),
            "validation_score": val["score"],
            "validation_band": val["band"],      # "green", "yellow", "red"
            "validation_status": val["status"],  # "verified", "needs_confirmation", "unverified"
            "auto_corrected": val["auto_corrected"],
            "validation_reason": val.get("reason"),     # why green/yellow/red, for the UI
            "candidates": val.get("candidates", []),     # similar brand names (never pre-selected)
            "options": val.get("options", []),           # strengths/forms for the doctor to pick
            "form": val.get("form"),
            "cdci_code": val.get("cdci_code"),

        }

        # Only exact/high-confidence fuzzy validation may set a canonical name.
        if val["band"] == "green" and val["matched_name"]:
            med_entry["name"] = val["matched_name"]
        else:
            med_entry["name"] = raw_name

        if val["band"] != "green":
            has_unverified = True

        validated_medicines.append(med_entry)

    result_dict["medicines"] = validated_medicines
    result_dict["has_unverified_items"] = has_unverified

    # Step 5: Lab Investigations Validation Layer (Section 4 + Lab Tests Catalog)
    raw_investigations = result_dict.get("investigations", [])
    validated_investigations = []
    standardized_investigations = []
    seen_test_names = set()

    # Process tests returned by LLM
    for inv in raw_investigations:
        raw_test = str(inv.get("spoken_name") if isinstance(inv, dict) else inv).strip()
        if not raw_test or raw_test.casefold() not in transcript.casefold():
            warnings.append(f"Dropped unsupported investigation extraction: {raw_test or 'empty name'}")
            continue
        val = drug_validator.validate_lab_test(raw_test)
        # Candidates are suggestions only; unknown spoken tests stay unchanged.
        tname = val["matched_name"] if val["band"] == "green" else raw_test
        if tname not in seen_test_names:
            seen_test_names.add(tname)
            standardized_investigations.append(tname)
            validated_investigations.append({
                "spoken_name": raw_test,
                "raw_text": raw_test,
                "matched_name": val["matched_name"],
                "category": val.get("category"),
                "specimen": val.get("specimen"),
                "is_fasting_required": val.get("is_fasting_required", False),
                "validation_score": val["score"],
                "validation_band": val["band"],
                "validation_status": val["status"],
            })

    # Supplement with any spoken lab tests detected directly in dictation
    spoken_tests = drug_validator.extract_lab_tests(transcript)
    for st in spoken_tests:
        tname = st["matched_name"]
        if tname and tname not in seen_test_names:
            seen_test_names.add(tname)
            standardized_investigations.append(tname)
            validated_investigations.append({
                "raw_text": st["raw_name"],
                "matched_name": tname,
                "category": st.get("category"),
                "specimen": st.get("specimen"),
                "is_fasting_required": st.get("is_fasting_required", False),
                "validation_score": st["score"],
                "validation_band": st["band"],
                "validation_status": st["status"],
            })

    result_dict["investigations"] = standardized_investigations
    result_dict["validated_investigations"] = validated_investigations
    result_dict["extraction_warnings"] = warnings
    result_dict["llm_latency_ms"] = round(llm_latency, 1)

    return result_dict



@router.post("/voice-to-prescription")
async def voice_to_prescription(
    file: UploadFile | None = File(None),
    transcript: str | None = Form(None),
    patient_name: str | None = Form(None),
    patient_age: int | None = Form(None),
    doctor_name: str | None = Form(None),
    language_hint: str = Form("en-IN")
) -> dict[str, Any]:
    """End-to-end voice to structured validated prescription."""
    transcript_text = (transcript or "").strip()
    transcribe_latency = 0.0

    # 1. Transcribe audio using Whisper with medical prompt biasing whenever file is uploaded
    if file:
        try:
            transcribe_res = await transcribe_audio(file=file, language_hint=language_hint)
            server_text = transcribe_res.get("text", "").strip()
            if server_text:
                transcript_text = server_text
                transcribe_latency = transcribe_res.get("latency_ms", 0.0)
        except Exception as e:
            # Fall back to client-provided transcript if server audio transcription fails
            if not transcript_text:
                raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    if not transcript_text:
        raise HTTPException(status_code=400, detail="No speech or transcript was detected. Please try again.")

    # 2. Structure & Validate with LLM
    struct_req = StructureRequest(
        transcript=transcript_text,
        patient_name=patient_name,
        patient_age=patient_age,
        doctor_name=doctor_name
    )
    res = structure_prescription(struct_req)
    res["transcript"] = transcript_text
    res["raw_transcript"] = transcript_text
    res["asr_model"] = os.getenv("ASR_MODEL", os.getenv("OPENAI_TRANSCRIPTION_MODEL", "large-v3"))
    res["transcribe_latency_ms"] = transcribe_latency
    res["total_latency_ms"] = round(transcribe_latency + res.get("llm_latency_ms", 0.0), 1)
    return res

