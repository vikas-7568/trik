"""Drug safety regression tests on REAL CDCI data (fixture: tests/fixtures/cdci_sample.json).
Every case is a failure found in code review or a CDCI-specific edge case. Never delete a case."""
import json
from pathlib import Path

import pytest

from drug_validation.cdci_matcher import CDCIMatcher
from drug_validation.cdci_parse import parse_remainder

FX = json.loads((Path(__file__).parent / "fixtures" / "cdci_sample.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def m():
    return CDCIMatcher(FX["rows"], FX["substance_names"])


# --- parser ---------------------------------------------------------------
@pytest.mark.parametrize("rest,text,mg,total,form", [
    (" 650 mg oral tablet", "650 mg", 650, None, "oral tablet"),
    (" 1 g prolonged-release oral tablet", "1 g", 1000, None, "prolonged-release oral tablet"),
    (" 500 mg + 125 mg oral tablet", "500 mg + 125 mg", None, 625, "oral tablet"),
    (" 250 mg/5 mL oral suspension", "250 mg/5 mL", None, None, "oral suspension"),
    (" 500 mg/vial powder for solution for injection", "500 mg/vial", 500, None,
     "powder for solution for injection"),
    (" (paracetamol) 500 mg oral tablet", "500 mg", 500, None, "oral tablet"),
])
def test_parse_remainder(rest, text, mg, total, form):
    p = parse_remainder(rest)
    assert p.strength_text == text and p.strength_mg == mg and p.total_mg == total
    assert p.form_text == form


# --- a spoken strength is never replaced ----------------------------------
@pytest.mark.parametrize("spoken", ["Shelcal 500", "Augmentin 625", "Ecosprin 325"])
def test_strength_never_substituted(m, spoken):
    r = m.validate(spoken)
    assert r["band"] != "green"
    assert r["matched_name"].endswith(spoken.split()[-1])


def test_related_brand_offered_not_chosen(m):
    r = m.validate("Augmentin 625")
    assert r["reason"] == "strength_in_related_brand"
    assert any("Augmentin DUO 500 mg + 125 mg" in o["label"] for o in r["options"])


def test_same_strength_two_forms_is_yellow(m):
    r = m.validate("Ecosprin 325")            # plain and gastro-resistant both exist
    assert r["band"] == "yellow" and r["reason"] == "multiple_forms"


# --- generics stay generic (incl. Indian names vs SNOMED names) ------------
@pytest.mark.parametrize("spoken", ["Metformin", "Metformin 500", "Paracetamol", "Paracetamol 650",
                                    "Salbutamol", "Glibenclamide 5"])
def test_generic_never_mapped_to_brand(m, spoken):
    r = m.validate(spoken)
    assert r["band"] == "yellow" and r["reason"] == "generic_spoken" and r["matched_name"] is None


@pytest.mark.parametrize("spoken,forbidden", [("Metformin", "Tenormin"), ("Levolin", "Levoflox"),
                                              ("Becosules", "Rosuless")])
def test_no_dangerous_suggestion(m, spoken, forbidden):
    r = m.validate(spoken)
    names = [c["name"] for c in r["candidates"]] + [o["label"] for o in r["options"]] + [r["matched_name"] or ""]
    assert not any(forbidden.lower() in n.lower() for n in names)


@pytest.mark.parametrize("spoken", ["Dolo", "Pan D", "Levolin", "Montair LC"])
def test_missing_strength_not_invented(m, spoken):
    r = m.validate(spoken)
    assert r["band"] == "yellow" and r["reason"] == "strength_not_stated"


# --- happy path still green -----------------------------------------------
@pytest.mark.parametrize("spoken,expected", [
    ("Dolo 650", "Dolo 650 mg"), ("do low 650", "Dolo 650 mg"), ("Pan 40", "Pan 40 mg"),
    ("pant 40", "Pan 40 mg"), ("Telma 40", "Telma 40 mg"), ("Azithral 500", "Azithral 500 mg"),
    ("Glycomet 1000", "Glycomet 1 g"), ("Augmentin Duo 625", "Augmentin DUO 500 mg + 125 mg"),
    ("Thyronorm 50", "Thyronorm 50 mcg"), ("Taxim O 200", "Taxim-O 200 mg"), ("Crocin 650", "Crocin 650 mg"),
])
def test_happy_path_green(m, spoken, expected):
    r = m.validate(spoken)
    assert r["band"] == "green", r
    assert r["matched_name"] == expected
    assert r["cdci_code"]


def test_injection_only_strength_is_never_green(m):
    # Azithral 500 mg exists as tablet AND as 500 mg/vial injection; the oral one must win.
    r = m.validate("Azithral 500")
    assert "injection" not in r["form"]
