"""Guardrails for the AI routes auth gap and the prescription approval gate
found in code review: anonymous calls must be rejected, only a doctor-role
user may approve, and exactly one code path may ever set status=approved."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _login(email: str, password: str, role: str = "clinic") -> str:
    res = client.post("/auth/login", json={"email": email, "password": password, "role": role})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_ai_routes_reject_anonymous():
    assert client.post("/ai/structure-prescription", json={"transcript": "Dolo 650"}).status_code == 401
    assert client.post("/ai/transcribe", files={"file": ("a.webm", b"x" * 600)}).status_code == 401
    assert client.post("/ai/voice-to-prescription", data={"transcript": "Dolo 650"}).status_code == 401


def test_receptionist_cannot_approve_prescription():
    doctor_token = _login("demo@trikmed.com", "demo1234")
    recep_token = _login("recep@trikmed.com", "demo1234")

    draft = client.post(
        "/prescriptions",
        json={"patient_name": "Test Patient", "medicines": [{"brandName": "Dolo 650"}]},
        headers=_auth(doctor_token),
    )
    assert draft.status_code == 200, draft.text
    rx_id = draft.json()["id"]

    blocked = client.post(f"/prescriptions/{rx_id}/approve", headers=_auth(recep_token))
    assert blocked.status_code == 403


def test_doctor_can_approve_own_draft():
    doctor_token = _login("demo@trikmed.com", "demo1234")

    draft = client.post(
        "/prescriptions",
        json={"patient_name": "Test Patient 2", "medicines": [{"brandName": "Crocin 650"}]},
        headers=_auth(doctor_token),
    )
    assert draft.status_code == 200, draft.text
    rx_id = draft.json()["id"]

    approved = client.post(f"/prescriptions/{rx_id}/approve", headers=_auth(doctor_token))
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["prescription"]["is_approved"] is True
    assert body["approved_by"]
    assert body["approved_at"]


def test_approve_requires_identity_not_hardcoded_fallback():
    # A token missing clinic_id/id can no longer fall back to "CLN-001"/"dr001";
    # this is a regression guard for the hardcoded-ID finding in code review.
    import app.api.routes.prescriptions as prescriptions_module

    src = Path(prescriptions_module.__file__).read_text(encoding="utf-8")
    assert '"CLN-001"' not in src.split("def approve_prescription")[1].split("\n\n\n")[0]
    assert '"dr001"' not in src.split("def approve_prescription")[1].split("\n\n\n")[0]


def test_single_place_sets_approved_status():
    # Spec 4.3 / code review: exactly one code path may ever write a *prescription's*
    # status to approved. Clinic-onboarding approval (portal.py) is a separate domain
    # with its own single writer and is intentionally not in scope here.
    pat = re.compile(r"[\"']status[\"']\]?\s*[:=]\s*[\"']approved[\"']")
    backend_root = Path(__file__).resolve().parents[1]
    writers = sorted(
        str(p.relative_to(backend_root))
        for p in backend_root.rglob("*.py")
        if "venv" not in p.parts
        and "tests" not in p.parts
        and "prescription" in p.read_text(encoding="utf-8").lower()
        and pat.search(p.read_text(encoding="utf-8"))
    )
    assert writers == ["app/storage/supabase_store.py"], writers
