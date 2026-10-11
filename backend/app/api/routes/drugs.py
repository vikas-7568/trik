from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.api.dependencies.auth import require_clinic_user
from app.services.drug_validator import drug_validator

router = APIRouter(prefix="/drugs", tags=["Drugs"], dependencies=[Depends(require_clinic_user)])


@router.get("/search")
def search_drugs(q: str = Query(..., min_length=2, max_length=60),
                 limit: int = Query(15, ge=1, le=30)) -> dict[str, Any]:
    """Typeahead for the doctor's manual medicine search (CDCI). A medicine picked here is the
    doctor's own choice: the frontend marks it source='search', doctor_confirmed=True."""
    if drug_validator.matcher is None:
        return {"results": [], "error": "drug_reference_not_loaded"}
    return {"results": drug_validator.matcher.search(q, limit)}
