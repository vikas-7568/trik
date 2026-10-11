"""Lab catalog regression tests (218 tests, 15 departments). Never delete a case."""
import json
from collections import defaultdict
from pathlib import Path

import pytest

from drug_validation.matcher import lab_test_matcher as m

CATALOG = json.loads((Path(__file__).resolve().parents[1] / "drug_validation" / "data" /
                      "seed_lab_tests.json").read_text(encoding="utf-8"))


def test_no_alias_points_to_two_tests():
    owner = defaultdict(set)
    for t in CATALOG:
        for a in t["common_aliases"]:
            owner[a.lower()].add(t["test_name"])
    assert not {a: o for a, o in owner.items() if len(o) > 1}


@pytest.mark.parametrize("spoken,expected", [
    ("x ray knee lateral view", "X-Ray Knee (AP & Lateral)"),    # was wrongly -> Chest X-Ray
    ("MRI knee both sides", "MRI Knee"),                         # was wrongly -> MRI Scan
    ("ghutne ka x ray", "X-Ray Knee (AP & Lateral)"),
    ("chest x ray", "Chest X-Ray (PA View)"),
    ("usg kub", "USG KUB"),
    ("double marker", "Double Marker Test"),
    ("beta hcg", "Serum Beta hCG"),
    ("ncv", "NCV (Nerve Conduction Velocity)"),
    ("tmt", "Treadmill Test (TMT)"),
    ("tsh", "TSH (Thyroid Stimulating Hormone)"),
    ("platelet count", "Platelet Count"),
    ("hs crp", "hs-CRP (High Sensitivity CRP)"),
    ("typhidot", "Typhidot (IgM)"),
    ("dexa scan", "DEXA Scan (Bone Density)"),
])
def test_specific_tests(spoken, expected):
    r = m.match(spoken)
    assert r.band == "green" and r.matched_name == expected


def test_bare_xray_is_not_silently_chest():
    assert m.match("x ray").matched_name != "Chest X-Ray (PA View)"


def test_hindi_phrase_kal_ana_is_not_ana_test():
    found = [e.matched_name for e in m.extract_from_text("Patient ko kal ana hai, CBC karwa lo")]
    assert "ANA (Antinuclear Antibody)" not in found
