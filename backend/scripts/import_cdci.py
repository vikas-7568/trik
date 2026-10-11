"""Import a CDCI Flat Files release into Postgres / Supabase.

Place at: backend/scripts/import_cdci.py
Usage:
    DATABASE_URL=postgresql://... python scripts/import_cdci.py /path/to/cdci_folder --release-date 2026-08-31

Use the DIRECT Postgres connection string from Supabase (Settings -> Database), not the REST API.
Everything runs in ONE transaction: either the whole release lands, or nothing changes.
Re-running the same release is safe (upserts). A newer release marks brands that disappeared
as is_active = false; it never deletes them (old prescriptions may reference them).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from drug_validation.cdci_parse import build_rows, norm, read_tsv  # noqa: E402

FILES = ["BrandMaster.txt", "GenericMaster.txt", "ProductMaster.txt", "SubstanceMaster.txt",
         "SupplierMaster.txt", "DrugFormMaster.txt", "RouteOfAdministrationMaster.txt"]


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def split_plus(v: str) -> list[str]:
    return [x.strip() for x in (v or "").split("+") if x.strip()]


def copy_into_temp(cur, table: str, columns: list[str], rows: list[tuple]) -> None:
    cur.execute(f"create temp table {table} ({', '.join(c + ' text' for c in columns)}) on commit drop")
    with cur.copy(f"copy {table} ({', '.join(columns)}) from stdin") as cp:
        for r in rows:
            cp.write_row(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--release-date", required=True, help="date from the NRCeS release note, YYYY-MM-DD")
    args = ap.parse_args()
    folder = Path(args.folder)

    missing = [f for f in FILES if not (folder / f).exists()]
    if missing:
        sys.exit(f"Missing files: {missing}")

    data = build_rows(folder)
    rows = data["rows"]
    print(f"Parsed {len(rows)} brands; problems: {len(data['problems'])} (logged below)")
    for kind, code, name in data["problems"]:
        print(f"  {kind}: {code} {name}")

    substances = read_tsv(folder / "SubstanceMaster.txt")
    forms = read_tsv(folder / "DrugFormMaster.txt")
    routes = read_tsv(folder / "RouteOfAdministrationMaster.txt")
    generics = read_tsv(folder / "GenericMaster.txt")
    suppliers = read_tsv(folder / "SupplierMaster.txt")
    products = read_tsv(folder / "ProductMaster.txt")

    checksums = {f: sha256(folder / f) for f in FILES}

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("""
            insert into drug_releases (release_date, brand_count, generic_count, file_sha256)
            values (%s, %s, %s, %s)
            on conflict (release_date) do update
              set imported_at = now(), brand_count = excluded.brand_count,
                  generic_count = excluded.generic_count, file_sha256 = excluded.file_sha256
            returning id""",
            (args.release_date, len(rows), len(generics), json.dumps(checksums)))
        release_id = cur.fetchone()[0]

        # --- small masters: plain upserts
        cur.executemany("""insert into drug_substances (code, name, name_norm) values (%s, %s, %s)
                           on conflict (code) do update set name = excluded.name, name_norm = excluded.name_norm""",
                        [(s["Identifier"], s["Substance Name"], norm(s["Substance Name"]))
                         for s in substances if s["Identifier"]])
        cur.executemany("""insert into drug_dose_forms (code, name) values (%s, %s)
                           on conflict (code) do update set name = excluded.name""",
                        [(f["Id"], f["Dose Form"]) for f in forms if f["Id"]])
        cur.executemany("""insert into drug_routes (code, name) values (%s, %s)
                           on conflict (code) do update set name = excluded.name""",
                        [(r["Identifier"], r["RouteOfAdministration"]) for r in routes if r["Identifier"]])
        cur.executemany("""insert into drug_generics (code, name, name_norm, substance_codes, route_codes, dose_form_code)
                           values (%s, %s, %s, %s, %s, %s)
                           on conflict (code) do update set name = excluded.name, name_norm = excluded.name_norm,
                             substance_codes = excluded.substance_codes, route_codes = excluded.route_codes,
                             dose_form_code = excluded.dose_form_code""",
                        [(g["Identifier"], g["Generic Name"], norm(g["Generic Name"]),
                          split_plus(g["Substance Identifier"]), split_plus(g["Route of Administration"]),
                          g["Dose Form"] or None) for g in generics if g["Identifier"]])

        # --- large masters: COPY into temp, then upsert
        copy_into_temp(cur, "tmp_suppliers", ["code", "name"],
                       [(s["Identifier"], s["Supplier Name"]) for s in suppliers if s["Identifier"]])
        cur.execute("""insert into drug_suppliers (code, name) select code, name from tmp_suppliers
                       on conflict (code) do update set name = excluded.name""")

        copy_into_temp(cur, "tmp_products", ["code", "name", "name_norm"],
                       [(p["Identifier"], p["Product Name"], norm(p["Product Name"]))
                        for p in products if p["Identifier"]])
        cur.execute("""insert into drug_products (code, name, name_norm)
                       select code, name, name_norm from tmp_products
                       on conflict (code) do update set name = excluded.name, name_norm = excluded.name_norm""")

        cols = ["cdci_code", "brand_name", "product_code", "base_name", "base_norm", "strength_text",
                "strength_mg", "total_mg", "form_text", "is_oral", "generic_code", "supplier_code",
                "cdci_updated_on"]
        copy_into_temp(cur, "tmp_brands", cols,
                       [tuple(None if r[c] is None else str(r[c]) for c in cols) for r in rows])
        cur.execute(f"""
            insert into drug_brands (cdci_code, brand_name, product_code, base_name, base_norm, strength_text,
                                     strength_mg, total_mg, form_text, is_oral, generic_code, supplier_code,
                                     cdci_updated_on, source, review_status, is_active, release_id)
            select cdci_code, brand_name, product_code, base_name, base_norm, coalesce(strength_text, ''),
                   strength_mg::numeric, total_mg::numeric, coalesce(form_text, ''), is_oral::boolean,
                   generic_code, supplier_code, to_date(cdci_updated_on, 'YYYYMMDD'),
                   'cdci', 'unreviewed', true, {release_id}
            from tmp_brands
            on conflict (cdci_code) do update set
              brand_name = excluded.brand_name, product_code = excluded.product_code,
              base_name = excluded.base_name, base_norm = excluded.base_norm,
              strength_text = excluded.strength_text, strength_mg = excluded.strength_mg,
              total_mg = excluded.total_mg, form_text = excluded.form_text, is_oral = excluded.is_oral,
              generic_code = excluded.generic_code, supplier_code = excluded.supplier_code,
              cdci_updated_on = excluded.cdci_updated_on, is_active = true,
              release_id = excluded.release_id, updated_at = now()""")
        cur.execute("""update drug_brands set is_active = false, updated_at = now()
                       where source = 'cdci' and is_active
                         and cdci_code not in (select cdci_code from tmp_brands)""")
        deactivated = cur.rowcount
        cur.execute("select count(*) from drug_brands where source = 'cdci' and is_active")
        active = cur.fetchone()[0]

    print(f"Release {args.release_date} (id {release_id}): {active} active CDCI brands, {deactivated} deactivated.")


if __name__ == "__main__":
    main()
