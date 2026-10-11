"""
Integration tests for TrikMed Drug Validation Pipeline.

Req 8: Tests covering:
- exact drug match
- misspelled drug
- ASR-like drug variation
- semantic fallback
- unknown drug
- semantic result cannot become GREEN
- actual Supabase RPC response shape
- prescription endpoint validation
- doctor/clinic data isolation
"""
from __future__ import annotations

import pytest
from app.services.drug_validator import DrugValidator
from drug_validation.supabase_client import supabase_drug_client
from app.storage.supabase_store import SupabaseStore


# Fixtures
@pytest.fixture
def validator():
    return DrugValidator()

@pytest.fixture
def store():
    return SupabaseStore()


# 1. Exact Drug Match
def test_exact_drug_match(validator):
    result = validator.validate_medicine_name("Dolo 650")
    assert result["band"] == "green"
    assert result["matched_name"] == "Dolo 650 mg"
    assert result["score"] >= 0.85
    assert result["auto_corrected"] is True
    assert result["status"] == "verified"

def test_exact_drug_match_case_insensitive(validator):
    result = validator.validate_medicine_name("dolo 650")
    assert result["band"] == "green"
    assert result["matched_name"] == "Dolo 650 mg"


# 2. Misspelled Drug
def test_misspelled_drug_green(validator):
    result = validator.validate_medicine_name("Dolo 650mg")
    assert result["band"] == "green"
    assert result["matched_name"] == "Dolo 650 mg"

def test_misspelled_drug_unknown(validator):
    result = validator.validate_medicine_name("Xyzpillol 999")
    assert result["band"] == "red"
    assert result["matched_name"] is None
    assert result["auto_corrected"] is False


# 3. ASR-like Drug Variation
def test_asr_variation_do_low_650(validator):
    """ASR mis-transcription 'do low 650' -> normalized -> GREEN."""
    result = validator.validate_medicine_name("do low 650")
    assert result["band"] == "green"
    assert result["matched_name"] == "Dolo 650 mg"

def test_asr_variation_ogmentin(validator):
    result = validator.validate_medicine_name("ogmentin 625")
    assert result["band"] in ("green", "yellow")
    assert result["matched_name"] is not None

def test_asr_variation_pantocid(validator):
    result = validator.validate_medicine_name("pantocid")
    assert result["band"] in ("green", "yellow")
    assert result["matched_name"] is not None

def test_asr_variation_diclomol(validator):
    result = validator.validate_medicine_name("diploma mall")
    assert result["band"] in ("green", "yellow")
    assert result["matched_name"] is not None


# 4. Semantic Fallback
def test_semantic_fallback_below_threshold(validator, monkeypatch):
    monkeypatch.setattr(supabase_drug_client, "rpc_match_drug_semantic", lambda emb: [])
    result = validator._semantic_fallback("unknowndrugxxx")
    assert result is None


# 5. Unknown Drug
def test_unknown_drug_is_red(validator, monkeypatch):
    monkeypatch.setattr(supabase_drug_client, "rpc_match_drug_semantic", lambda emb: [])
    result = validator.validate_medicine_name("ZoglarexPharmaV99")
    assert result["band"] == "red"
    assert result["matched_name"] is None
    assert result["auto_corrected"] is False
    assert result["status"] == "unverified"

def test_empty_name_is_red(validator):
    result = validator.validate_medicine_name("")
    assert result["band"] == "red"


# 6. SAFETY INVARIANT: Semantic Cannot Become GREEN
def test_validate_full_path_semantic_capped(validator, monkeypatch):
    """Full validate_medicine_name: semantic path score must be <= 0.84."""
    mock_hits = [{"brand": "Dolo 650", "generic": "Paracetamol", "atc_code": "N02BE01", "category": "Analgesics", "score": 0.99}]
    monkeypatch.setattr(supabase_drug_client, "rpc_match_drug_semantic", lambda emb: mock_hits)
    result = validator.validate_medicine_name("paracetamol generic molecule")
    if result.get("method") in ("pgvector_semantic_fallback", "brand_stem_fallback"):
        assert result["band"] == "yellow"
        assert result["score"] <= 0.84
        assert result["auto_corrected"] is False


# 7. Actual Supabase RPC Response Shape
def test_supabase_rpc_returns_list_not_none():
    result = supabase_drug_client.rpc_match_drug(query="Paracetamol")
    assert isinstance(result, list)

def test_supabase_semantic_rpc_returns_list():
    dummy_embedding = [0.0] * 384
    result = supabase_drug_client.rpc_match_drug_semantic(dummy_embedding)
    assert isinstance(result, list)

def test_supabase_log_correction_unconfigured_returns_false():
    if not supabase_drug_client.is_configured:
        result = supabase_drug_client.log_doctor_correction(
            original_text="paracetamol",
            corrected_text="Dolo 650",
            prescription_id="RX-TEST-001",
            doctor_id="dr001",
        )
        assert result is False


# 8. Prescription Endpoint Validation
def test_prescription_starts_as_draft(store):
    rx = store.add_prescription({
        "id": "RX-INTEG-001",
        "clinic_id": "CLN-001",
        "doctor_id": "dr001",
        "patient_name": "Test Patient",
        "medicines": [{"name": "Dolo 650", "dosage": "1-0-1", "duration": "3 days"}],
    })
    assert rx["is_approved"] is False
    assert rx["status"] == "draft"
    assert rx["approved_at"] is None
    assert rx["approved_by"] is None

def test_prescription_approval_gate(store):
    store.add_prescription({
        "id": "RX-INTEG-002",
        "clinic_id": "CLN-001",
        "doctor_id": "dr001",
        "patient_name": "Test Patient 2",
        "medicines": [{"name": "Augmentin 625", "dosage": "1-0-1", "duration": "5 days"}],
    })
    approved = store.approve_prescription("RX-INTEG-002", "CLN-001", "dr001")
    assert approved["is_approved"] is True
    assert approved["approved_by"] == "dr001"
    assert approved["approved_at"] is not None
    assert approved["rx_token"].startswith("RX-")

def test_prescription_cross_clinic_denied(store):
    store.add_prescription({
        "id": "RX-INTEG-003",
        "clinic_id": "CLN-001",
        "doctor_id": "dr001",
        "patient_name": "Secured Patient",
        "medicines": [],
    })
    with pytest.raises(PermissionError):
        store.get_prescription("RX-INTEG-003", clinic_id="CLN-999")


# 9. Doctor/Clinic Data Isolation
def test_historical_prescriptions_only_approved(store):
    """Only APPROVED prescriptions appear in history suggestions."""
    store.add_prescription({
        "id": "RX-HIST-DRAFT-99",
        "clinic_id": "CLN-001",
        "doctor_id": "dr_hist",
        "diagnosis": ["Asthma"],
        "medicines": [{"brandName": "Foracort"}],
        "is_approved": False,
        "status": "draft",
    })
    store.add_prescription({
        "id": "RX-HIST-APPR-99",
        "clinic_id": "CLN-001",
        "doctor_id": "dr_hist",
        "diagnosis": ["Asthma"],
        "medicines": [{"brandName": "Seroflo 250"}],
        "is_approved": True,
        "status": "approved",
    })
    results = store.get_historical_prescriptions("CLN-001", "dr_hist", "Asthma")
    ids_returned = [r["id"] for r in results]
    assert "RX-HIST-DRAFT-99" not in ids_returned
    assert "RX-HIST-APPR-99" in ids_returned

def test_doctor_isolation(store):
    """Dr A history must not be visible to Dr B."""
    store.add_prescription({
        "id": "RX-DOC-A-ISO",
        "clinic_id": "CLN-001",
        "doctor_id": "dr_iso_a",
        "diagnosis": ["Diabetes"],
        "medicines": [{"brandName": "Metformin 500"}],
        "is_approved": True,
        "status": "approved",
    })
    results_b = store.get_historical_prescriptions("CLN-001", "dr_iso_b", "Diabetes")
    assert not any(r["id"] == "RX-DOC-A-ISO" for r in results_b)

def test_clinic_isolation(store):
    """Clinic A prescriptions must not bleed into Clinic B history."""
    store.add_prescription({
        "id": "RX-CLN-A-ISO",
        "clinic_id": "CLN-001",
        "doctor_id": "dr001",
        "diagnosis": ["Hypertension"],
        "medicines": [{"brandName": "Telmikind 40"}],
        "is_approved": True,
        "status": "approved",
    })
    results = store.get_historical_prescriptions("CLN-002", "dr001", "Hypertension")
    assert not any(r["id"] == "RX-CLN-A-ISO" for r in results)

def test_list_prescriptions_clinic_scoped(store):
    """list_prescriptions is scoped to the requesting clinic only."""
    store.add_prescription({
        "id": "RX-SCOPE-ISO",
        "clinic_id": "CLN-001",
        "doctor_id": "dr001",
        "patient_name": "Scoped Patient",
        "medicines": [],
    })
    results_other = store.list_prescriptions("CLN-999")
    assert not any(r["id"] == "RX-SCOPE-ISO" for r in results_other)
