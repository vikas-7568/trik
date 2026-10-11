"""Core matching engine for medicines and lab tests.
Implements Section 3.2, 3.3 & 5.2 of TrikMed Technical Specification.
"""

from __future__ import annotations
import json
from pathlib import Path
import re
from typing import Any
from rapidfuzz import fuzz, process

from drug_validation.schema import (
    DrugReferenceSchema,
    ValidationResult,
    LabTestReferenceSchema,
    LabTestValidationResult,
)
from drug_validation.supabase_client import supabase_drug_client

DATA_DIR = Path(__file__).resolve().parent / "data"
SEED_DRUGS_PATH = DATA_DIR / "seed_drugs.json"
SEED_LAB_TESTS_PATH = DATA_DIR / "seed_lab_tests.json"


class DrugMatcher:
    """Two-layer Drug Safety Validator adhering strictly to Technical Specification Section 3 & 5.

    Layer 1: Fuzzy string matching with RapidFuzz across reference brand names.
      - Green Band (>= 0.85): Auto-correct to reference spelling. Record both original and corrected.
      - Yellow Band (0.70 - 0.84): Flag needs_confirmation. Doctor must explicitly confirm.
      - Red Band (< 0.70): Mark unverified. Require manual entry. Never guess substitute.

    Layer 2: Semantic / generic fallback when fuzzy matching fails (< 0.70).
      - SAFETY INVARIANT: Strictly capped at Yellow Band (max 0.75). NEVER Green.
    """

    def __init__(self, db_path: Path | str = SEED_DRUGS_PATH):
        self.db_path = Path(db_path)
        self.medicines: list[dict[str, Any]] = []
        self.brand_lookup: dict[str, dict[str, Any]] = {}
        self.brand_names: list[str] = []
        self.generic_lookup: dict[str, list[dict[str, Any]]] = {}
        self.atc_lookup: dict[str, list[dict[str, Any]]] = {}
        self._load_database()

    def _load_database(self) -> None:
        if self.db_path.exists():
            with open(self.db_path, "r", encoding="utf-8") as f:
                self.medicines = json.load(f)
            for med in self.medicines:
                bname = med.get("brand_name", "").strip()
                gname = med.get("generic_name", "").strip().lower()
                atc = med.get("atc_code", "").strip().upper()
                if bname:
                    self.brand_lookup[bname.lower()] = med
                    self.brand_names.append(bname)
                if gname:
                    self.generic_lookup.setdefault(gname, []).append(med)
                if atc and atc != "VARIOUS":
                    self.atc_lookup.setdefault(atc, []).append(med)

    def match(self, raw_name: str) -> ValidationResult:
        """Validate an extracted drug name against reference database with 3-band scoring."""
        cleaned = (raw_name or "").strip()
        if not cleaned or not self.brand_names:
            return ValidationResult(
                raw_name=raw_name,
                matched_name=None,
                score=0.0,
                band="red",
                auto_corrected=False,
                status="unverified",
                method="empty",
            )

        # ── 1. Normalise known ASR / phonetic mis-transcriptions ─────────────────
        normalized_query = cleaned
        for alias_pattern, replacement in [
            (r"\b(do\s*low|duo\s*low|dolow)\b", "Dolo"),
            (r"\b(ogmentin|augmenten|augmonton)\b", "Augmentin"),
            (r"\b(diploma\s*mall|diploma\s*mole|diplomall|diclomol|diclo\s*mol)\b", "Diclomol"),
            (r"\bpan\s*d\b", "Pan D"),
            (r"\bpant\s*40\b", "Pan 40"),
            (r"\bpan\s+40\b", "Pan 40"),
            (r"\bpantocid\b", "Pan 40"),
            (r"\b(nitro\s*glycerine|nitro\s*glycerin|nitroglycerin|nitroglycerine)\b", "Nitrocontin"),
            (r"\b(allegra\b)", "Allegra 120"),
            (r"\b(meftal\s*spas)\b", "Meftal-Spas"),
            (r"\b(montair\s*lc)\b", "Montair-LC"),
            (r"\b(taxim\s*o)\b", "Taxim-O"),
            (r"\b(ascoril\s*d)\b", "Ascoril-D"),
            # Levothyroxine — ASR commonly transcribes as "livo thyroxin" / "levo thyroxine"
            (r"\b(livo\s*thyroxin|levo\s*thyroxin[e]?|livo\s*thyroxine|levothyroxin[e]?)\b", "Levothyroxine"),
        ]:
            normalized_query = re.sub(alias_pattern, replacement, normalized_query, flags=re.IGNORECASE)

        # ── 2. Layer 1: RapidFuzz Exact & Trigram/Token Comparison (Section 3.2) ──
        candidates_to_score = [normalized_query] if normalized_query != cleaned else [cleaned]
        best_match_name = None
        highest_score = 0.0

        for q in candidates_to_score:
            m_sort = process.extractOne(q, self.brand_names, scorer=fuzz.token_sort_ratio)
            m_part = process.extractOne(q, self.brand_names, scorer=fuzz.partial_ratio)
            for m in (m_sort, m_part):
                if m and m[1] > highest_score:
                    best_match_name = m[0]
                    highest_score = float(m[1])

        normalized_score = highest_score / 100.0

        # Green Band (>= 0.85): Auto-correct to reference spelling
        if normalized_score >= 0.85 and best_match_name:
            details = self.brand_lookup.get(best_match_name.lower(), {})
            return ValidationResult(
                raw_name=raw_name,
                matched_name=best_match_name,
                score=round(normalized_score, 3),
                band="green",
                auto_corrected=True,
                status="verified",
                generic_name=details.get("generic_name"),
                strength=details.get("strength"),
                form=details.get("form"),
                category=details.get("category"),
                atc_code=details.get("atc_code"),
                method="fuzzy_match",
            )

        # Yellow Band (0.70 - 0.84): Needs confirmation, do NOT auto-correct
        if normalized_score >= 0.70 and best_match_name:
            details = self.brand_lookup.get(best_match_name.lower(), {})
            return ValidationResult(
                raw_name=raw_name,
                matched_name=best_match_name,
                score=round(normalized_score, 3),
                band="yellow",
                auto_corrected=False,
                status="needs_confirmation",
                generic_name=details.get("generic_name"),
                strength=details.get("strength"),
                form=details.get("form"),
                category=details.get("category"),
                atc_code=details.get("atc_code"),
                method="fuzzy_match",
            )

        # ── 3. Layer 2: Semantic / Generic Molecule Fallback (Section 3.2) ────────
        # SAFETY INVARIANT: Strictly capped at Yellow (0.75 max). Can NEVER be green.
        cleaned_lower = cleaned.lower()
        for gname, meds in self.generic_lookup.items():
            if gname in cleaned_lower or cleaned_lower in gname:
                matched_med = meds[0]
                return ValidationResult(
                    raw_name=raw_name,
                    matched_name=matched_med.get("brand_name"),
                    score=0.75,
                    band="yellow",
                    auto_corrected=False,
                    status="needs_confirmation",
                    generic_name=matched_med.get("generic_name"),
                    strength=matched_med.get("strength"),
                    form=matched_med.get("form"),
                    category=matched_med.get("category"),
                    atc_code=matched_med.get("atc_code"),
                    method="generic_atc_fallback",
                )

        # Red Band (< 0.70): Mark unverified. Require manual doctor entry
        return ValidationResult(
            raw_name=raw_name,
            matched_name=None,
            score=round(normalized_score, 3),
            band="red",
            auto_corrected=False,
            status="unverified",
            method="unmatched",
        )


class LabTestMatcher:
    """Matches and validates spoken diagnostic lab investigations against master catalog."""

    def __init__(self, db_path: Path | str = SEED_LAB_TESTS_PATH):
        self.db_path = Path(db_path)
        self.tests: list[dict[str, Any]] = []
        self.alias_to_test: dict[str, dict[str, Any]] = {}
        self.test_names: list[str] = []
        self._load_database()

    def _load_database(self) -> None:
        if self.db_path.exists():
            with open(self.db_path, "r", encoding="utf-8") as f:
                self.tests = json.load(f)
            for t in self.tests:
                tname = t.get("test_name", "").strip()
                if tname:
                    self.test_names.append(tname)
                    self.alias_to_test[tname.lower()] = t
                for alias in t.get("common_aliases", []):
                    self.alias_to_test[alias.lower().strip()] = t

    def match(self, spoken_text: str) -> LabTestValidationResult:
        """Resolve a spoken lab investigation phrase to standardized test."""
        cleaned = (spoken_text or "").strip().lower()
        if not cleaned:
            return LabTestValidationResult(raw_text=spoken_text, score=0.0, band="red")

        # 1. Exact alias match
        if cleaned in self.alias_to_test:
            matched = self.alias_to_test[cleaned]
            return LabTestValidationResult(
                raw_text=spoken_text,
                matched_name=matched["test_name"],
                category=matched.get("category"),
                specimen=matched.get("specimen"),
                is_fasting_required=matched.get("is_fasting_required", False),
                score=1.0,
                band="green",
                status="verified",
            )

        # 2. Compound phrases: the LONGEST alias contained as whole words wins, so
        #    "x ray knee lateral" -> X-Ray Knee (not a shorter generic alias of another test).
        for alias in sorted(self.alias_to_test, key=len, reverse=True):
            test_obj = self.alias_to_test[alias]
            if len(alias) >= 3 and re.search(r"\b" + re.escape(alias) + r"\b", cleaned):
                return LabTestValidationResult(
                    raw_text=spoken_text,
                    matched_name=test_obj["test_name"],
                    category=test_obj.get("category"),
                    specimen=test_obj.get("specimen"),
                    is_fasting_required=test_obj.get("is_fasting_required", False),
                    score=0.95,
                    band="green",
                    status="verified",
                )

        # 3. RapidFuzz token matching
        best = process.extractOne(cleaned, list(self.alias_to_test.keys()), scorer=fuzz.token_sort_ratio)
        if best and best[1] >= 80:
            matched = self.alias_to_test[best[0]]
            score = round(best[1] / 100.0, 3)
            band = "green" if score >= 0.85 else "yellow"
            return LabTestValidationResult(
                raw_text=spoken_text,
                matched_name=matched["test_name"],
                category=matched.get("category"),
                specimen=matched.get("specimen"),
                is_fasting_required=matched.get("is_fasting_required", False),
                score=score,
                band=band,
                status="verified" if band == "green" else "needs_confirmation",
            )

        return LabTestValidationResult(
            raw_text=spoken_text,
            matched_name=spoken_text.title(),
            score=0.50,
            band="yellow",
            status="needs_confirmation",
        )

    def extract_from_text(self, text: str) -> list[LabTestValidationResult]:
        if not text or not text.strip():
            return []

        found_results: list[LabTestValidationResult] = []
        found_test_names: set[str] = set()

        sorted_aliases = sorted(self.alias_to_test.keys(), key=lambda a: len(a), reverse=True)
        lowered_text = text.lower()

        for alias in sorted_aliases:
            if len(alias) < 2:
                continue
            pattern = "\\b" + re.escape(alias) + "\\b"
            if re.search(pattern, lowered_text):
                test_obj = self.alias_to_test[alias]
                tname = test_obj["test_name"]
                if tname not in found_test_names:
                    found_test_names.add(tname)
                    found_results.append(
                        LabTestValidationResult(
                            raw_text=alias,
                            matched_name=tname,
                            category=test_obj.get("category"),
                            specimen=test_obj.get("specimen"),
                            is_fasting_required=test_obj.get("is_fasting_required", False),
                            score=1.0,
                            band="green",
                            status="verified"
                        )
                    )
                # Remove matched alias from text to prevent overlapping shorter matches
                lowered_text = re.sub(pattern, " ", lowered_text)

        return found_results



# Singleton instances
drug_matcher = DrugMatcher()
lab_test_matcher = LabTestMatcher()

