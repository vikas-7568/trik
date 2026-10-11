"""Strength-aware drug matcher built on CDCI rows (output of cdci_parse.build_rows or the
drug_brands table). Replaces strength_matcher.py once CDCI is imported.

Place at: backend/drug_validation/cdci_matcher.py

Safety rules (unchanged from strength_matcher.py):
  1. A spoken strength is never replaced by a different strength.
  2. A generic name is never mapped to a brand the doctor did not say.
  3. Green needs: confident brand match AND spoken strength exists AND exactly one oral form.
  4. Aliases fix spelling only.
New with CDCI:
  5. Combination totals: "Augmentin Duo 625" matches 500 mg + 125 mg (Indian convention).
  6. Oral forms are preferred for OPD dictation; an injection-only match is never green.
  7. Same strength in two different forms (e.g. plain vs gastro-resistant) -> yellow, doctor picks.
"""
from __future__ import annotations

import re
from collections import defaultdict

from rapidfuzz import fuzz, process

from drug_validation.cdci_parse import INDIAN_SYNONYMS, form_key, norm

SPOKEN_STRENGTH_RE = re.compile(
    r"(?<![A-Za-z0-9\-])(\d+(?:\.\d+)?)\s*(mg|mcg|gm|g)?(?![A-Za-z0-9])", re.I)
TO_MG = {"mg": 1.0, "g": 1000.0, "gm": 1000.0, "mcg": 0.001}

SPELLING_ALIASES = [            # spelling / ASR errors ONLY
    (r"\b(do\s*low|duo\s*low|dolow)\b", "Dolo"),
    (r"\b(ogmentin|augmenten|augmenton)\b", "Augmentin"),
    (r"\b(diploma\s*mall|diploma\s*mole|diplomall|diclo\s*mol)\b", "Diclomol"),
    (r"\bpant\b(?=\s*\d)", "Pan"),
    (r"\b(cal\s*pol|kalpol)\b", "Calpol"),
    (r"\b(azith\s*ral|azitral|azithrol)\b", "Azithral"),
    (r"\b(combi\s*flam|combiflame)\b", "Combiflam"),
    (r"\b(eco\s*sprin)\b", "Ecosprin"),
]


def split_spoken(text: str):
    """'Dolo 650' -> ('Dolo', 650.0). 'Thyronorm 50 mcg' -> ('Thyronorm', 0.05).
    A bare number is read as mg, except micro-dose brands are handled by the caller."""
    m = SPOKEN_STRENGTH_RE.search(text or "")
    if not m:
        return (text or "").strip(), None, None
    value, unit = float(m.group(1)), (m.group(2) or "").lower() or None
    base = re.sub(r"\s{2,}", " ", (text[:m.start()] + " " + text[m.end():])).strip()
    return base, value, unit


class CDCIMatcher:
    GREEN, YELLOW, MARGIN = 85, 80, 10

    def __init__(self, rows: list[dict], substance_names: dict[str, str] | None = None,
                 synonyms: dict[str, str] | None = None):
        self.by_base: dict[str, list[dict]] = defaultdict(list)
        self.display: dict[str, str] = {}
        for r in rows:
            k = r["base_norm"]
            self.by_base[k].append(r)
            self.display.setdefault(k, r["base_name"])
        self.keys = sorted(self.by_base)
        self.generics = dict(substance_names or {})
        for indian, snomed in (synonyms or INDIAN_SYNONYMS).items():
            self.generics[norm(indian)] = f"{indian.title()} ({snomed})"

    # ------------------------------------------------------------------ public
    def validate(self, spoken: str) -> dict:
        spoken = (spoken or "").strip()
        res = {"spoken_name": spoken, "matched_name": None, "cdci_code": None, "generic_name": None,
               "band": "red", "status": "unverified", "reason": "", "score": 0.0,
               "candidates": [], "options": [], "auto_corrected": False}
        if not spoken:
            res["reason"] = "empty"
            return res

        text = spoken
        for pat, rep in SPELLING_ALIASES:
            text = re.sub(pat, rep, text, flags=re.I)
        q_base, q_val, q_unit = split_spoken(text)
        q_key = norm(q_base)

        # 1. Generic spoken -> stays generic, no brand chosen.
        if q_key in self.generics:
            res.update(band="yellow", status="needs_confirmation", reason="generic_spoken",
                       generic_name=self.generics[q_key], score=1.0)
            return res

        # 2. Brand base: exact, or fuzzy with margin.
        if q_key in self.by_base:
            top_key, top, second = q_key, 100.0, 0.0
        else:
            hits = process.extract(q_key, self.keys, scorer=fuzz.ratio, limit=3)
            if not hits or hits[0][1] < self.YELLOW:
                res["reason"] = "no_credible_match"
                return res
            top_key, top = hits[0][0], hits[0][1]
            second = hits[1][1] if len(hits) > 1 else 0.0
            res["candidates"] = [self._cand(k, s) for k, s, _ in hits if s >= self.YELLOW]
        res["score"] = round(top / 100, 3)
        if top < 100 and (top < self.GREEN or top - second < self.MARGIN):
            res.update(band="yellow", status="needs_confirmation",
                       reason="low_score" if top < self.GREEN else "ambiguous_top_two")
            return res

        variants = self.by_base[top_key]
        base_name = self.display[top_key]
        oral = [v for v in variants if v["is_oral"]] or []
        res["options"] = self._options(oral or variants)

        # 3. Strength.
        if q_val is None:
            if all(not v["strength_text"] for v in variants):
                return self._green(res, variants[0], "brand_match_no_strength_in_reference")
            res.update(band="yellow", status="needs_confirmation", reason="strength_not_stated",
                       matched_name=base_name)
            return res

        q_mg = q_val * TO_MG.get(q_unit or "mg", 1.0)
        hits = self._strength_hits(oral, q_mg)
        if not hits and q_unit is None:
            hits = self._strength_hits(oral, q_val * 0.001)        # "Thyronorm 50" means 50 mcg
        if not hits:
            non_oral = self._strength_hits([v for v in variants if not v["is_oral"]], q_mg)
            # "Augmentin 625" lives under the sibling product "Augmentin DUO". Offer it, never pick it.
            sibling_hits = [h for k in self.keys if k != top_key and k.startswith(top_key)
                            for h in self._strength_hits([v for v in self.by_base[k] if v["is_oral"]], q_mg)]
            res.update(band="yellow", status="needs_confirmation",
                       reason="non_oral_only" if non_oral else
                              ("strength_in_related_brand" if sibling_hits else "strength_not_in_reference"),
                       matched_name=f"{base_name} {q_val:g}")      # spoken strength kept
            if sibling_hits:
                res["options"] = self._options(sibling_hits)
            return res

        forms = {form_key(v["form_text"]) for v in hits}
        if len(forms) > 1:
            res.update(band="yellow", status="needs_confirmation", reason="multiple_forms",
                       matched_name=f"{base_name} {q_val:g}", options=self._options(hits))
            return res
        return self._green(res, hits[0], "brand_strength_form_match")

    def search(self, query: str, limit: int = 15) -> list[dict]:
        """Typeahead for the doctor's manual medicine search. Prefix matches first, then fuzzy.
        Oral forms first. Whatever the doctor picks here is a deliberate choice by the doctor."""
        q = norm(query)
        if len(q) < 2:
            return []
        # Exact first, then shorter prefix matches ("dol" -> Dolo before Dolamine). Popularity ranking
        # comes later from clinic usage data.
        keys = sorted((k for k in self.keys if k.startswith(q)), key=lambda k: (k != q, len(k), k))[:limit]
        if len(keys) < limit:
            keys += [k for k, _, _ in process.extract(q, self.keys, scorer=fuzz.WRatio, limit=limit)
                     if k not in keys]
        out = []
        for k in keys[:limit]:
            vs = [v for v in self.by_base[k] if v["is_oral"]] or self.by_base[k]
            out.extend(self._options(vs)[:4])
        return out[: limit * 2]

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _strength_hits(variants, q_mg):
        eq = lambda a: a is not None and abs(a - q_mg) < 1e-6
        return [v for v in variants if eq(v["strength_mg"]) or eq(v["total_mg"])]

    def _green(self, res, v, reason):
        res.update(band="green", status="verified", reason=reason,
                   matched_name=f'{v["base_name"]} {v["strength_text"]}'.strip(),
                   form=v["form_text"], cdci_code=v["cdci_code"], generic_name=v["generic_name"])
        res["auto_corrected"] = norm(res["matched_name"]) != norm(res["spoken_name"])
        return res

    @staticmethod
    def _options(vs):
        seen, out = set(), []
        for v in vs:
            key = (v["strength_text"], form_key(v["form_text"]))
            if key not in seen:
                seen.add(key)
                out.append({"label": f'{v["base_name"]} {v["strength_text"]} {v["form_text"]}'.strip(),
                            "cdci_code": v["cdci_code"], "generic_name": v["generic_name"]})
        return out[:12]

    def _cand(self, key, score):
        v = self.by_base[key][0]
        return {"name": self.display[key], "generic_name": v["generic_name"], "score": round(score / 100, 3)}


def load_matcher_from_db(conn) -> CDCIMatcher:
    """Build the matcher from Postgres at app startup (~94k rows, under a second to index).
    Only CDCI rows and human-reviewed non-CDCI rows are matchable."""
    from psycopg.rows import dict_row
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("""
            select b.cdci_code, b.brand_name, b.base_name, b.base_norm, b.strength_text,
                   b.strength_mg::float as strength_mg, b.total_mg::float as total_mg,
                   b.form_text, b.is_oral, g.name as generic_name
            from drug_brands b left join drug_generics g on g.code = b.generic_code
            where b.is_active and (b.source = 'cdci' or b.review_status = 'reviewed')""")
        rows = cur.fetchall()
        cur.execute("select name_norm, name from drug_substances")
        substances = {r["name_norm"]: r["name"] for r in cur.fetchall()}
        cur.execute("select indian_name, snomed_name from drug_generic_synonyms")
        synonyms = {r["indian_name"]: r["snomed_name"] for r in cur.fetchall()} or None
    return CDCIMatcher(rows, substances, synonyms)


def load_matcher_from_folder(folder) -> CDCIMatcher:
    """Local development: build straight from the downloaded CDCI folder, no database needed."""
    from drug_validation.cdci_parse import build_rows
    data = build_rows(folder)
    return CDCIMatcher(data["rows"], data["substance_names"])


def load_matcher() -> CDCIMatcher | None:
    """Startup entry point. DATABASE_URL (Supabase direct connection) when deployed,
    CDCI_FOLDER for local development. Returns None (everything RED, loudly logged) if neither is set."""
    import logging
    import os
    if os.getenv("DATABASE_URL"):
        import psycopg
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            return load_matcher_from_db(conn)
    if os.getenv("CDCI_FOLDER"):
        return load_matcher_from_folder(os.environ["CDCI_FOLDER"])
    logging.getLogger(__name__).error(
        "Drug reference NOT loaded: set DATABASE_URL or CDCI_FOLDER. Every medicine will be RED.")
    return None
