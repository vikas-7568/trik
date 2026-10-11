"""Contract test: contract/openapi.yaml is the single source of truth for endpoints.

Fails when:
  1. the backend has a route that is not in the contract (someone invented an endpoint), or
  2. the contract has a non-planned route the backend does not implement, or
  3. the frontend calls a path that is not in the contract.
"""
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = yaml.safe_load((ROOT / "contract" / "openapi.yaml").read_text(encoding="utf-8"))
IGNORED = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}
METHODS = {"get", "post", "put", "patch", "delete"}


def norm_path(p: str) -> str:
    return re.sub(r"\{[^}]+\}", "{}", p.rstrip("/") or "/")


def contract_routes(include_planned: bool) -> set[tuple[str, str]]:
    out = set()
    for path, ops in CONTRACT["paths"].items():
        for m, op in ops.items():
            if m in METHODS and (include_planned or op.get("x-trikmed-status") != "planned"):
                out.add((m.upper(), norm_path(path)))
    return out


def backend_routes() -> set[tuple[str, str]]:
    from main import app
    out = set()
    for r in app.routes:
        if getattr(r, "methods", None) and r.path not in IGNORED:
            out |= {(m, norm_path(r.path)) for m in r.methods if m not in ("HEAD", "OPTIONS")}
    return out


def test_backend_has_no_endpoint_outside_contract():
    extra = backend_routes() - contract_routes(include_planned=True)
    assert not extra, f"Endpoints in code but not in contract/openapi.yaml: {sorted(extra)}"


def test_backend_implements_every_agreed_endpoint():
    missing = contract_routes(include_planned=False) - backend_routes()
    assert not missing, f"Contract endpoints not implemented: {sorted(missing)}"


def frontend_calls() -> set[tuple[str, str, str]]:
    calls = set()
    src = ROOT / "frontend"
    for f in src.rglob("*"):
        if f.suffix not in {".js", ".jsx", ".ts", ".tsx"} or "node_modules" in f.parts or ".next" in f.parts:
            continue
        text = f.read_text(encoding="utf-8", errors="ignore")
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)                    # block comments
        text = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("//"))
        for m in re.finditer(r"api\.(get|post|put|patch|delete|upload)\(\s*[`'\"]([^`'\"]+)", text):
            method = "POST" if m.group(1) == "upload" else m.group(1).upper()
            path = re.sub(r"\$\{[^}]+\}", "{}", m.group(2).split("?")[0])
            calls.add((method, norm_path(path), str(f.relative_to(ROOT))))
    return calls


@pytest.mark.skipif(not (ROOT / "frontend").exists(), reason="no frontend/ folder in this checkout")
def test_frontend_calls_only_contract_endpoints():
    allowed = contract_routes(include_planned=True)
    bad = sorted(c for c in frontend_calls() if (c[0], c[1]) not in allowed)
    assert not bad, f"Frontend calls endpoints not in contract: {bad}"
