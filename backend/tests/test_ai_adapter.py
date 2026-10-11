from __future__ import annotations

import asyncio
from pathlib import Path
import re
import pytest
from pydantic import BaseModel

from app.ai.adapter import (
    DeIdentifier,
    LocalStubLLMClient,
    LocalStubSpeechClient,
    Transcript,
    get_llm_client,
    get_speech_client,
)
from app.services.drug_validator import drug_validator
from app.storage.supabase_store import SupabaseStore
from app.api.routes import ai, prescriptions


class DummyPrescription(BaseModel):
    patient_name: str
    age: int
    diagnosis: str


# ── Module 1: Adapter & De-identification Tests ───────────────────────────────

def test_speech_client_contract():
    client = LocalStubSpeechClient()
    transcript = client.transcribe(b'fake_audio_stream')
    assert transcript.text
    assert transcript.confidence > 0


def test_transcribe_route_uses_configured_speech_client(monkeypatch):
    """The API route must use the adapter, not the retired local faster-whisper service."""
    class FakeSpeechClient:
        def transcribe(self, audio, filename="audio.wav", language_hint=None):
            assert audio == b"recorded dictation"
            assert filename == "dictation.webm"
            assert language_hint == "hi-IN"
            return Transcript(text="Patient has fever", language="hi-IN", confidence=0.91)

    async def read_audio():
        return b"recorded dictation"

    class FakeUpload:
        filename = "dictation.webm"
        content_type = "audio/webm"
        read = staticmethod(read_audio)

    monkeypatch.setattr(ai, "get_speech_client", lambda: FakeSpeechClient())
    result = asyncio.run(ai.transcribe_audio(file=FakeUpload(), language_hint="hi-IN"))

    assert result["text"] == "Patient has fever"
    assert result["language"] == "hi-IN"
    assert result["confidence"] == 0.91


def test_llm_client_contract():
    client = LocalStubLLMClient()
    result = client.complete('System prompt', 'Dictated user text', DummyPrescription)
    assert hasattr(result, 'patient_name')
    assert hasattr(result, 'diagnosis')


def test_de_identification_scrubbing():
    """Section 12: No patient identity leaves our servers."""
    raw = 'Patient Ramesh Kumar with mobile 9876543210 treated by Dr. Sharma at Apex Clinic'
    scrubbed = DeIdentifier.scrub_text(raw, patient_name='Ramesh Kumar', doctor_name='Dr. Sharma')
    assert 'Ramesh Kumar' not in scrubbed
    assert '9876543210' not in scrubbed
    assert '[PATIENT_NAME]' in scrubbed
    assert '[PHONE_NUMBER]' in scrubbed


# ── Module 1: Drug Safety Layer Tests (Section 5) ─────────────────────────────

def test_drug_validator_three_bands():
    """Section 5.1: 3-Band Drug Name Verification."""
    # Green Band (>= 0.85): High confidence, auto-corrected
    res_green = drug_validator.validate_medicine_name('Dolo 650')
    assert res_green['band'] == 'green'
    assert res_green['status'] == 'verified'
    assert res_green['score'] >= 0.85
    assert res_green['matched_name'] == 'Dolo 650 mg'

    res_typo = drug_validator.validate_medicine_name('Dolo 650mg')
    assert res_typo['band'] == 'green'
    assert res_typo['matched_name'] == 'Dolo 650 mg'

    # Yellow Band (0.70 - 0.84): Needs confirmation, candidate suggested
    res_yellow = drug_validator.validate_medicine_name('Pantocid')
    assert res_yellow['band'] in ['green', 'yellow']
    assert res_yellow['score'] >= 0.70

    # Red Band (< 0.70): Unverified, require manual entry
    res_red = drug_validator.validate_medicine_name('CompletelyFakeDrug123')
    assert res_red['band'] == 'red'
    assert res_red['status'] == 'unverified'
    assert res_red['matched_name'] is None


def test_drug_validator_audit_logging():
    """Section 5.3: Every validation outcome is logged."""
    drug_validator.validate_medicine_name('Azithral 500')
    logs = drug_validator.get_validation_logs()
    assert len(logs) > 0
    latest = logs[-1]
    assert 'raw_name' in latest
    assert 'score' in latest
    assert 'band' in latest
    assert 'timestamp' in latest


# ── Module 1: Approval Gate Tests (Section 4.3) ───────────────────────────────

def test_approval_gate_ai_route_isolation():
    """Section 4.3 Invariant: The AI service has NO route that can set the approved flag."""
    ai_route_endpoints = [route.path for route in ai.router.routes]
    assert '/approve' not in ai_route_endpoints
    assert '/prescriptions/approve' not in ai_route_endpoints
    for route in ai.router.routes:
        assert 'approve' not in route.path.lower() or 'disapproved' in route.path.lower()


def test_approval_gate_state_machine_and_audit():
    """Section 4.3: Prescription starts unapproved; approval records approved_at and approved_by."""
    store = SupabaseStore()
    
    # 1. Create prescription -> must be unapproved / draft
    draft = store.add_prescription({
        'id': 'RX-TEST-001',
        'clinic_id': 'CLN-001',
        'doctor_id': 'USR-DOC-001',
        'patient_name': 'Aarav Sharma',
        'medicines': [{'name': 'Dolo 650', 'dosage': '1-0-1', 'duration': '3 days'}]
    })
    assert draft['is_approved'] is False
    assert draft['status'] == 'draft'
    assert draft['approved_at'] is None
    assert draft['approved_by'] is None

    # 2. Doctor explicitly approves -> writes is_approved, approved_at, approved_by, and mints RX token
    approved = store.approve_prescription('RX-TEST-001', 'CLN-001', 'USR-DOC-001')
    assert approved['is_approved'] is True
    assert approved['status'] == 'approved'
    assert approved['approved_at'] is not None
    assert approved['approved_by'] == 'USR-DOC-001'
    assert approved['rx_token'].startswith('RX-')
    assert re.match(r'^RX-[A-Z0-9]{6}$', approved['rx_token']) is not None


# ── Module 1: Historical Suggestions Tests (Section 6) ────────────────────────

def test_historical_suggestions_invariants():
    """Section 6: Scoped to diagnosis, doctor, and clinic. Failure returns empty list."""
    store = SupabaseStore()

    # Pre-seed approved historical prescriptions for Dr A at Clinic 1
    store.add_prescription({
        'id': 'RX-HIST-001',
        'clinic_id': 'CLN-001',
        'doctor_id': 'dr001',
        'diagnosis': ['Viral Fever', 'URTI'],
        'medicines': [
            {'brandName': 'Dolo 650', 'dose': '650mg', 'dosage': '1-0-1', 'duration': '3 days'},
            {'brandName': 'Azithral 500', 'dose': '500mg', 'dosage': '1-0-0', 'duration': '3 days'}
        ],
        'is_approved': True,
        'status': 'approved'
    })

    # 1. Matching query for Dr A at Clinic 1 -> returns suggestions
    results = store.get_historical_prescriptions('CLN-001', 'dr001', 'Viral Fever')
    assert len(results) >= 1
    assert results[0]['medicines'][0]['brandName'] == 'Dolo 650'

    # 2. Privacy Scoping: Another doctor (dr002) at Clinic 1 sees NO suggestions
    results_other_doc = store.get_historical_prescriptions('CLN-001', 'dr002', 'Viral Fever')
    assert len(results_other_doc) == 0

    # 3. Privacy Scoping: Another clinic (CLN-002) sees NO suggestions
    results_other_clinic = store.get_historical_prescriptions('CLN-002', 'dr001', 'Viral Fever')
    assert len(results_other_clinic) == 0

    # 4. Invariant 4: Non-matching diagnosis returns empty list
    empty_results = store.get_historical_prescriptions('CLN-001', 'dr001', 'Fractured Femur')
    assert empty_results == []


# ── Cross-Cutting: Structural Provider SDK Import Guard (Section 11.2) ─────────

def test_structural_no_direct_provider_imports():
    """Section 11.2: Enforce that NO provider SDKs are imported outside adapter.py."""
    backend_root = Path(__file__).resolve().parents[1]
    forbidden_modules = ['google.generativeai', 'google.genai', 'openai', 'groq', 'bhashini', 'sarvam']
    
    violations = []
    for py_file in backend_root.rglob('*.py'):
        if 'tests' in py_file.parts or 'adapter.py' in py_file.parts or '.venv' in py_file.parts or 'venv' in py_file.parts:
            continue
        try:
            content = py_file.read_text(encoding='utf-8')
            for mod in forbidden_modules:
                if f'import {mod}' in content or f'from {mod}' in content:
                    violations.append(f'{py_file.name} imports {mod}')
        except Exception:
            pass
            
    assert not violations, f'Found direct provider imports outside adapter: {violations}'
