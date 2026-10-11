"""Parse Common Drug Codes for India (CDCI) Flat Files into clean drug rows.

Place at: backend/drug_validation/cdci_parse.py

Verified against the CDCI Flat Files Package (93,911 brands). Facts about the files that
this code handles on purpose:
  * Files are TSV. Most rows end with an extra trailing tab. GenericMaster, ProductMaster and
    others use CRLF line endings; BrandMaster uses LF. A handful of rows have too few or too many
    fields (e.g. a Covaxin row with 18 fields). So we never use COPY/pandas defaults blindly:
    every row is cut or padded to the header width.
  * BrandMaster."Brand Name" is the full label: "Dolo 650 mg oral tablet".
    ProductMaster gives the bare brand: "Dolo". The brand name starts with the product name in
    99.99% of rows, so: remainder = strength + dose form.
  * Strengths look like: "650 mg", "500 mg + 125 mg", "250 mg/5 mL", "500 mg/vial",
    "27.5 mcg/actuation", "1000 iu + 1.5 mg + ...".
  * Generic names use SNOMED (US) naming: Acetaminophen, not Paracetamol. See INDIAN_SYNONYMS.
  * License Status is "UNKNOWN" for every row, so it carries no information.
  * ~1,164 brand names appear more than once with different identifiers; we keep all codes but
    the matcher de-duplicates by (product, strength, form).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- file reading
def read_tsv(path: str | Path) -> list[dict[str, str]]:
    raw = Path(path).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    lines = [ln for ln in raw.split("\n") if ln.strip()]
    header = [h.strip() for h in lines[0].split("\t")]
    n = len(header)
    out = []
    for ln in lines[1:]:
        cells = (ln.split("\t") + [""] * n)[:n]
        out.append({h: c.strip() for h, c in zip(header, cells)})
    return out


# ---------------------------------------------------------------- strength parsing
_UNIT = r"million unit|miu|microgram|mcg|mg|ng|g|iu|unit|milliliter|ml|ul|nl|%"
_PER = r"ml|vial|actuation|g|sachet|ampule|syringe|hour|dose"
COMP = (rf"(\d+(?:\.\d+)?)\s*({_UNIT})\b"
        rf"(?:\s*/\s*(\d+(?:\.\d+)?)?\s*({_PER})\b)?")
COMP_RE = re.compile(COMP, re.I)
STRENGTH_BLOCK_RE = re.compile(rf"^\s*({COMP}(?:\s*\+\s*{COMP})*)\s*(.*)$", re.I)

TO_MG = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "microgram": 0.001, "ng": 1e-6}
PER_DOSE_UNITS = {None, "vial", "sachet", "ampule", "syringe"}   # amount per unit dose, not a concentration


@dataclass
class Component:
    value: float
    unit: str
    per_value: float | None
    per_unit: str | None

    @property
    def mg(self) -> float | None:
        """Amount in mg per dose unit, or None if it is a concentration / non-mass unit."""
        if self.unit in TO_MG and self.per_unit in PER_DOSE_UNITS:
            return round(self.value * TO_MG[self.unit], 6)
        return None


@dataclass
class ParsedBrand:
    strength_text: str = ""
    form_text: str = ""
    components: list[Component] = field(default_factory=list)

    @property
    def strength_mg(self) -> float | None:
        if len(self.components) == 1:
            return self.components[0].mg
        return None

    @property
    def total_mg(self) -> float | None:
        """Sum of components, e.g. 500 mg + 125 mg = 625. Indian doctors say 'Augmentin 625'."""
        mgs = [c.mg for c in self.components]
        if len(mgs) > 1 and all(m is not None for m in mgs):
            return round(sum(mgs), 6)
        return None

    @property
    def is_oral(self) -> bool:
        return "oral" in self.form_text.lower()


def parse_remainder(rest: str) -> ParsedBrand:
    # Generic-named products look like "Paracetamol (paracetamol) 500 mg oral tablet Supplier".
    rest = re.sub(r"^\s*\([^)]*\)\s*", "", rest or "")
    m = STRENGTH_BLOCK_RE.match(rest)
    if not m:
        return ParsedBrand(form_text=(rest or "").strip())
    block, form = m.group(1), m.group(m.lastindex)
    comps = []
    for c in COMP_RE.finditer(block):
        unit = c.group(2).lower()
        per_unit = c.group(4).lower() if c.group(4) else None
        comps.append(Component(float(c.group(1)), unit,
                               float(c.group(3)) if c.group(3) else None, per_unit))
    return ParsedBrand(strength_text=block.strip(), form_text=(form or "").strip(), components=comps)


def split_brand(brand_name: str, product_name: str) -> tuple[str, ParsedBrand]:
    """'Dolo 650 mg oral tablet', 'Dolo' -> ('Dolo', ParsedBrand(650 mg, oral tablet))."""
    if product_name and brand_name.lower().startswith(product_name.lower()):
        return product_name.strip(), parse_remainder(brand_name[len(product_name):])
    # Rare (~0.01%): label does not start with product name. Keep the product name as the base
    # and try to find the strength block anywhere in the label.
    m = COMP_RE.search(brand_name)
    rest = brand_name[m.start():] if m else ""
    return (product_name or brand_name).strip(), parse_remainder(rest)


# ---------------------------------------------------------------- generic synonyms
# CDCI follows SNOMED/US naming. Indian doctors say the left side. Keep this list small and
# reviewed (PG students / pharmacist). Never add brand names here.
INDIAN_SYNONYMS = {
    "paracetamol": "acetaminophen",
    "salbutamol": "albuterol",
    "levosalbutamol": "levalbuterol",
    "glibenclamide": "glyburide",
    "adrenaline": "epinephrine",
    "noradrenaline": "norepinephrine",
    "frusemide": "furosemide",
    "lignocaine": "lidocaine",
}


_FORM_NOISE = re.compile(r"\b(film-coated|uncoated|coated)\b", re.I)


def form_key(form_text: str) -> str:
    """'film-coated oral tablet' and 'oral tablet' are the same thing for a prescription.
    Release modifiers (gastro-resistant, prolonged-release, dispersible) are NOT removed."""
    return re.sub(r"\s+", " ", _FORM_NOISE.sub("", (form_text or "").lower())).strip()


def norm(s: str) -> str:
    return re.sub(r"[\s\-_.]+", "", (s or "").lower())


# ---------------------------------------------------------------- full transform
def build_rows(folder: str | Path) -> dict:
    folder = Path(folder)
    brands = read_tsv(folder / "BrandMaster.txt")
    products = {r["Identifier"]: r["Product Name"] for r in read_tsv(folder / "ProductMaster.txt")}
    generics = {r["Identifier"]: r for r in read_tsv(folder / "GenericMaster.txt")}
    suppliers = {r["Identifier"]: r["Supplier Name"] for r in read_tsv(folder / "SupplierMaster.txt")}
    substances = read_tsv(folder / "SubstanceMaster.txt")

    rows, problems = [], []
    for b in brands:
        product = products.get(b["Product Identifier"], "")
        if not product:
            problems.append(("no_product", b["Identifier"], b["Brand Name"]))
            continue
        base, p = split_brand(b["Brand Name"], product)
        g = generics.get(b["Generic Identifier"])
        if not g:
            problems.append(("no_generic", b["Identifier"], b["Brand Name"]))
        rows.append({
            "cdci_code": b["Identifier"],
            "brand_name": b["Brand Name"],
            "product_code": b["Product Identifier"],
            "base_name": base,
            "base_norm": norm(base),
            "strength_text": p.strength_text,
            "strength_mg": p.strength_mg,
            "total_mg": p.total_mg,
            "form_text": p.form_text,
            "is_oral": p.is_oral,
            "generic_code": b["Generic Identifier"] if g else None,   # FK-safe
            "generic_name": g["Generic Name"] if g else None,
            "supplier_code": b["Supplier Identifier"] or None,
            "supplier_name": suppliers.get(b["Supplier Identifier"]),
            "cdci_updated_on": b.get("last_updated_on") or None,
        })

    substance_names = {norm(s["Substance Name"]): s["Substance Name"] for s in substances if s["Substance Name"]}
    return {"rows": rows, "problems": problems, "substance_names": substance_names}
