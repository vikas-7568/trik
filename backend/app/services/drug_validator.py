from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any
from rapidfuzz import fuzz, process

DRUG_DB_PATH = Path(__file__).resolve().parents[1] / 'data' / 'drug_reference.json'


class DrugValidator:
    def __init__(self, db_path: Path | str = DRUG_DB_PATH):
        self.db_path = Path(db_path)
        self.medicines: list[dict[str, Any]] = []
        self.brand_lookup: dict[str, dict[str, Any]] = {}
        self.brand_names: list[str] = []
        self.generic_lookup: dict[str, list[dict[str, Any]]] = {}
        self.atc_lookup: dict[str, list[dict[str, Any]]] = {}
        self.validation_logs: list[dict[str, Any]] = []
        self._load_database()
        from drug_validation.cdci_matcher import load_matcher
        self.matcher = load_matcher()

    def _load_database(self) -> None:
        if self.db_path.exists():
            with open(self.db_path, 'r', encoding='utf-8') as f:
                self.medicines = json.load(f)
            for med in self.medicines:
                bname = med.get('brand_name', '').strip()
                gname = med.get('generic_name', '').strip().lower()
                atc = med.get('atc_code', '').strip().upper()
                if bname:
                    self.brand_lookup[bname.lower()] = med
                    self.brand_names.append(bname)
                if gname:
                    self.generic_lookup.setdefault(gname, []).append(med)
                if atc and atc != 'VARIOUS':
                    self.atc_lookup.setdefault(atc, []).append(med)

    def _semantic_fallback(self, cleaned: str) -> dict[str, Any] | None:
        import os
        try:
            from drug_validation.embeddings import embedding_service
            from drug_validation.supabase_client import supabase_drug_client

            embedding = embedding_service.get_embedding(cleaned)
            if not embedding:
                return None
                
            hits = supabase_drug_client.rpc_match_drug_semantic(embedding)
            semantic_threshold = float(os.getenv("SEMANTIC_THRESHOLD", "0.80"))

            if hits and hits[0]["score"] >= semantic_threshold:
                hit = hits[0]
                return {
                    'raw_name': cleaned,
                    'matched_name': hit.get('brand'),
                    'generic_name': hit.get('generic'),
                    'atc_code': hit.get('atc_code'),
                    'atc_category': hit.get('category'),
                    'score': 0.75,
                    'band': 'yellow',
                    'auto_corrected': False,
                    'status': 'needs_confirmation',
                    'method': 'pgvector_semantic_fallback',
                    'details': hit,
                }
        except Exception:
            pass
        return None

    def validate_medicine_name(self, raw_name: str) -> dict[str, Any]:
        """CDCI-backed, strength-aware validation (drug_validation/cdci_matcher.py)."""
        if self.matcher is None:
            res = {"spoken_name": raw_name, "matched_name": None, "band": "red", "status": "unverified",
                   "reason": "reference_not_loaded", "score": 0.0, "candidates": [], "options": [],
                   "auto_corrected": False, "generic_name": None}
        else:
            res = self.matcher.validate(raw_name)
        res["raw_name"] = raw_name
        res["method"] = res["reason"]
        res["timestamp"] = datetime.now(timezone.utc).isoformat()
        self.log_validation(res)
        return res

    def validate_lab_test(self, test_name: str) -> dict[str, Any]:
        from drug_validation.matcher import lab_test_matcher
        res = lab_test_matcher.match(test_name)
        return {
            "raw_name": res.raw_text,
            "matched_name": res.matched_name or test_name,
            "category": res.category,
            "specimen": res.specimen,
            "is_fasting_required": res.is_fasting_required,
            "score": res.score,
            "band": res.band,
            "status": res.status,
        }

    def extract_lab_tests(self, text: str) -> list[dict[str, Any]]:
        from drug_validation.matcher import lab_test_matcher
        results = lab_test_matcher.extract_from_text(text)
        return [
            {
                "raw_name": r.raw_text,
                "matched_name": r.matched_name or r.raw_text,
                "category": r.category,
                "specimen": r.specimen,
                "is_fasting_required": r.is_fasting_required,
                "score": r.score,
                "band": r.band,
                "status": r.status,
            }
            for r in results
        ]

    def get_drug_context_for_prompt(self, limit: int = 40) -> str:
        return ", ".join(self.brand_names[:limit])

    def get_validation_logs(self) -> list[dict[str, Any]]:
        return list(self.validation_logs)

    def log_validation(self, result: dict[str, Any]) -> None:
        self.validation_logs.append(result)


drug_validator = DrugValidator()
