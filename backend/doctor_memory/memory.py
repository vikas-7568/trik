"""Doctor Memory core logic. Pure Python: no database, no network, no LLM.

Storage keeps one append-only row per medicine line of every APPROVED prescription
(table doctor_rx_memory, see migrations/04_doctor_memory.sql). This module turns those rows
into suggestions. It can only ORDER options and OFFER suggestions; it can never change a
validation band, fill a field, or approve anything.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

WINDOW_DAYS = 180            # habits older than this are forgotten (doctors change brands)
MIN_USES = 3                 # never call something "usual" on fewer uses
MIN_SHARE = 0.70             # and only if it is clearly dominant
MIN_ALIAS_CONFIRMATIONS = 3  # a doctor-specific speech-recognition alias needs repeated confirmation


def norm(s: str | None) -> str:
    return re.sub(r"[\s\-_.]+", "", (s or "").lower())


@dataclass(frozen=True)
class MemoryEvent:
    """One medicine line from one approved prescription. No patient identity, by design."""
    doctor_id: str
    clinic_id: str
    prescription_id: str
    approved_at: datetime
    diagnosis_norm: str
    spoken_norm: str              # what the doctor said, normalised ("ogmentin625")
    base_norm: str                # brand base that was finally approved ("augmentinduo")
    label: str                    # final approved label ("Augmentin DUO 500 mg + 125 mg")
    cdci_code: str | None = None
    form_text: str = ""
    frequency: str = ""           # "1-0-1"
    duration: str = ""            # "5 days"
    after_food: bool | None = None
    doctor_confirmed: bool = False


def events_from_approved_rx(rx: dict, doctor_id: str, clinic_id: str) -> list[MemoryEvent]:
    """Called ONLY from the approve route, after approval succeeded.
    Raises if the prescription is not approved, so unapproved drafts can never teach the system."""
    if not rx.get("is_approved") or not rx.get("approved_at"):
        raise ValueError("Doctor Memory learns only from approved prescriptions")
    approved_at = rx["approved_at"]
    if isinstance(approved_at, str):
        approved_at = datetime.fromisoformat(approved_at.replace("Z", "+00:00"))
    diagnoses = rx.get("diagnosis") or []
    if isinstance(diagnoses, str):
        diagnoses = [diagnoses]
    dx = norm(diagnoses[0]) if diagnoses else ""
    out = []
    for m in rx.get("medicines") or []:
        label = (m.get("brandName") or m.get("name") or "").strip()
        if not label:
            continue
        base = m.get("base_norm") or norm(re.split(r"\s\d", label, maxsplit=1)[0])
        out.append(MemoryEvent(
            doctor_id=doctor_id, clinic_id=clinic_id, prescription_id=str(rx.get("id", "")),
            approved_at=approved_at, diagnosis_norm=dx,
            spoken_norm=norm(m.get("spoken_name") or label), base_norm=base, label=label,
            cdci_code=m.get("cdci_code"), form_text=m.get("form") or "",
            frequency=m.get("dosage") or m.get("frequency") or "",
            duration=m.get("duration") or "", after_food=m.get("after_food"),
            doctor_confirmed=bool(m.get("doctor_confirmed")),
        ))
    return out


@dataclass
class DoctorMemory:
    """All suggestions for ONE doctor in ONE clinic. Build it from that doctor's rows only."""
    doctor_id: str
    clinic_id: str
    events: list[MemoryEvent] = field(default_factory=list)
    now: datetime | None = None

    def __post_init__(self) -> None:
        now = self.now or datetime.now(timezone.utc)
        cutoff = now - timedelta(days=WINDOW_DAYS)
        # Scoping is enforced here as well as in the query: a foreign row is a bug, so drop it.
        self.events = [e for e in self.events
                       if e.doctor_id == self.doctor_id and e.clinic_id == self.clinic_id
                       and e.approved_at >= cutoff]

    # ------------------------------------------------------------------ 1. usual variant
    def usual_variant(self, base_norm: str) -> dict | None:
        """'Dolo' -> the strength/form this doctor nearly always approves, if clearly dominant."""
        labels = Counter(e.label for e in self.events if e.base_norm == base_norm)
        total = sum(labels.values())
        if total < MIN_USES:
            return None
        label, n = labels.most_common(1)[0]
        if n / total < MIN_SHARE:
            return None
        sample = next(e for e in self.events if e.label == label)
        return {"label": label, "cdci_code": sample.cdci_code, "uses": n, "share": round(n / total, 2),
                "source": "doctor_usual"}

    # ------------------------------------------------------------------ 2. usual regimen
    def usual_regimen(self, label: str) -> dict | None:
        """How this doctor usually gives this exact medicine. Offered ONLY for fields not spoken."""
        rows = [e for e in self.events if e.label == label]
        if len(rows) < MIN_USES:
            return None
        out = {}
        for fld in ("frequency", "duration", "after_food"):
            vals = Counter(getattr(e, fld) for e in rows if getattr(e, fld) not in ("", None))
            if vals:
                v, n = vals.most_common(1)[0]
                if n >= MIN_USES and n / len(rows) >= MIN_SHARE:
                    out[fld] = v
        return {"label": label, "uses": len(rows), **out, "source": "doctor_usual"} if out else None

    # ------------------------------------------------------------------ 3. personal aliases
    def personal_alias(self, spoken_norm: str) -> dict | None:
        """This doctor's own speech-recognition quirk: 'ogmentin625' confirmed as Augmentin DUO
        three or more times. Returned as a candidate to show FIRST, never as a match."""
        rows = [e for e in self.events if e.spoken_norm == spoken_norm and e.doctor_confirmed]
        if len(rows) < MIN_ALIAS_CONFIRMATIONS:
            return None
        labels = Counter(e.label for e in rows)
        label, n = labels.most_common(1)[0]
        if n / len(rows) < MIN_SHARE:
            return None
        return {"label": label, "confirmations": n, "source": "doctor_alias"}

    # ------------------------------------------------------------------ 4. diagnosis history
    def suggestions_for_diagnosis(self, diagnosis: str, limit: int = 3) -> list[dict]:
        """Past regimens this doctor approved for the same diagnosis (spec Section 6).
        Shown in a separate 'past prescribing history' panel, never merged into the Rx."""
        dx = norm(diagnosis)
        if not dx:
            return []
        by_rx: dict[str, list[MemoryEvent]] = defaultdict(list)
        for e in self.events:
            if e.diagnosis_norm and (e.diagnosis_norm == dx or dx in e.diagnosis_norm or e.diagnosis_norm in dx):
                by_rx[e.prescription_id].append(e)
        regimens = Counter()
        last_seen: dict[tuple, datetime] = {}
        for rows in by_rx.values():
            key = tuple(sorted((e.label, e.frequency, e.duration) for e in rows))
            regimens[key] += 1
            last_seen[key] = max(last_seen.get(key, rows[0].approved_at), rows[0].approved_at)
        ranked = sorted(regimens.items(), key=lambda kv: (-kv[1], -last_seen[kv[0]].timestamp()))
        return [{"times_used": n, "last_used": last_seen[k].date().isoformat(),
                 "medicines": [{"label": l, "frequency": f, "duration": d} for l, f, d in k],
                 "label": "Past prescribing history (reference only)"}
                for k, n in ranked[:limit]]

    # ------------------------------------------------------------------ 5. transparency
    def summary(self, top: int = 15) -> dict:
        """What the system has learned about this doctor. Shown to the doctor, who can reset it."""
        labels = Counter(e.label for e in self.events)
        return {"window_days": WINDOW_DAYS, "prescriptions_learned_from": len({e.prescription_id for e in self.events}),
                "top_medicines": [{"label": l, "uses": n} for l, n in labels.most_common(top)]}

    # ------------------------------------------------------------------ apply to a validated medicine
    def annotate(self, med: dict) -> dict:
        """Attach suggestions to ONE validated medicine from /ai/structure-prescription.
        Never touches validation_band, name, or any field value. Never raises."""
        try:
            out = dict(med)
            base = med.get("base_norm") or norm(re.split(r"\s\d", med.get("name") or "", maxsplit=1)[0])
            usual = self.usual_variant(base)
            alias = self.personal_alias(norm(med.get("spoken_name")))
            if usual or alias:
                out["doctor_usual"] = alias or usual       # UI shows this option first: "Aapka usual"
            label = med.get("name") if med.get("validation_band") == "green" else (usual or {}).get("label")
            reg = self.usual_regimen(label) if label else None
            if reg:
                missing = {k: v for k, v in reg.items()
                           if k in ("frequency", "duration", "after_food") and med.get(k) in (None, "")}
                if missing:
                    out["suggested_regimen"] = {**missing, "uses": reg["uses"], "source": "doctor_usual"}
            return out
        except Exception:
            return dict(med)   # memory is a convenience; it must never break a prescription
