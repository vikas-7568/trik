"""Doctor Memory safety invariants. Never delete a case."""
from datetime import datetime, timedelta, timezone

import pytest

from doctor_memory import DoctorMemory, MemoryEvent, events_from_approved_rx

NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)


def ev(label, *, doctor="D1", clinic="C1", rx="R", days_ago=1, dx="viralfever", spoken=None,
       freq="1-0-1", dur="5 days", confirmed=False, base=None):
    return MemoryEvent(doctor_id=doctor, clinic_id=clinic, prescription_id=rx,
                       approved_at=NOW - timedelta(days=days_ago), diagnosis_norm=dx,
                       spoken_norm=spoken or label.lower().replace(" ", ""),
                       base_norm=base or label.split()[0].lower(), label=label,
                       frequency=freq, duration=dur, doctor_confirmed=confirmed)


def mem(events, doctor="D1", clinic="C1"):
    return DoctorMemory(doctor, clinic, events, now=NOW)


# 1. Learns ONLY from approved prescriptions
def test_unapproved_rx_cannot_teach():
    with pytest.raises(ValueError):
        events_from_approved_rx({"is_approved": False, "medicines": [{"brandName": "Dolo 650 mg"}]}, "D1", "C1")


def test_approved_rx_produces_events_without_patient_identity():
    rx = {"id": "R1", "is_approved": True, "approved_at": "2026-10-10T10:00:00+00:00",
          "patient_name": "Ramesh", "phone": "9999999999", "diagnosis": ["Viral fever"],
          "medicines": [{"brandName": "Dolo 650 mg", "dosage": "1-0-1", "duration": "3 days"}]}
    events = events_from_approved_rx(rx, "D1", "C1")
    assert len(events) == 1
    stored = str(events[0])
    assert "Ramesh" not in stored and "9999999999" not in stored


# 2. Usual needs real evidence
def test_usual_needs_three_uses():
    assert mem([ev("Dolo 650 mg", rx=f"R{i}") for i in range(2)]).usual_variant("dolo") is None
    u = mem([ev("Dolo 650 mg", rx=f"R{i}") for i in range(3)]).usual_variant("dolo")
    assert u["label"] == "Dolo 650 mg" and u["uses"] == 3


def test_no_usual_when_doctor_is_mixed():
    events = [ev("Dolo 650 mg", rx=f"A{i}") for i in range(3)] + [ev("Dolo 500 mg", rx=f"B{i}") for i in range(3)]
    assert mem(events).usual_variant("dolo") is None


# 3. Strict scoping: another doctor's or clinic's habits never leak
def test_other_doctor_and_clinic_ignored():
    events = [ev("Dolo 650 mg", doctor="D2", rx=f"X{i}") for i in range(5)] + \
             [ev("Dolo 650 mg", clinic="C2", rx=f"Y{i}") for i in range(5)]
    m = mem(events)
    assert m.usual_variant("dolo") is None and m.summary()["top_medicines"] == []


# 4. Old habits are forgotten
def test_habits_older_than_window_forgotten():
    assert mem([ev("Dolo 650 mg", rx=f"R{i}", days_ago=200) for i in range(5)]).usual_variant("dolo") is None


# 5. annotate() never changes band, name or values; only adds suggestions
def test_annotate_never_changes_safety_fields():
    m = mem([ev("Dolo 650 mg", rx=f"R{i}") for i in range(5)])
    med = {"spoken_name": "Dolo", "name": "Dolo", "validation_band": "yellow",
           "validation_reason": "strength_not_stated", "frequency": None, "duration": None}
    out = m.annotate(med)
    for k in ("name", "validation_band", "validation_reason", "frequency", "duration"):
        assert out[k] == med[k]
    assert out["doctor_usual"]["label"] == "Dolo 650 mg"
    assert out["suggested_regimen"]["frequency"] == "1-0-1"


def test_spoken_values_are_never_overridden_by_suggestion():
    m = mem([ev("Dolo 650 mg", rx=f"R{i}") for i in range(5)])
    out = m.annotate({"spoken_name": "Dolo 650", "name": "Dolo 650 mg", "validation_band": "green",
                      "frequency": "0-0-1", "duration": "3 days"})
    assert "suggested_regimen" not in out   # doctor said both, nothing to suggest


def test_annotate_never_raises():
    assert mem([]).annotate({"name": None}) == {"name": None}


# 6. Personal alias needs repeated doctor confirmation
def test_personal_alias_requires_confirmations():
    rows = [ev("Augmentin DUO 500 mg + 125 mg", rx=f"R{i}", spoken="ogmentin625", confirmed=True)
            for i in range(2)]
    assert mem(rows).personal_alias("ogmentin625") is None
    rows.append(ev("Augmentin DUO 500 mg + 125 mg", rx="R9", spoken="ogmentin625", confirmed=True))
    assert mem(rows).personal_alias("ogmentin625")["label"].startswith("Augmentin DUO")


def test_unconfirmed_matches_do_not_create_alias():
    rows = [ev("Augmentin DUO 500 mg + 125 mg", rx=f"R{i}", spoken="ogmentin625", confirmed=False)
            for i in range(5)]
    assert mem(rows).personal_alias("ogmentin625") is None


# 7. Diagnosis history: reference only, ranked by use
def test_diagnosis_suggestions():
    rows = [ev("Dolo 650 mg", rx=f"A{i}") for i in range(3)] + [ev("Crocin 650 mg", rx="B1")]
    s = mem(rows).suggestions_for_diagnosis("Viral Fever")
    assert s[0]["times_used"] == 3 and s[0]["medicines"][0]["label"] == "Dolo 650 mg"
    assert "reference only" in s[0]["label"]
    assert mem(rows).suggestions_for_diagnosis("") == []
