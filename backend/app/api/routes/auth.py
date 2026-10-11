from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.dependencies.auth import (
    auth_response,
    get_current_user,
    require_clinic_user,
    require_portal_user,
    require_staff_admin,
    store,
)
from app.api.routes._helpers import clinic_payload, next_token, queue_row, queue_sort_token
from app.core.security import hash_password, verify_password
from app.schemas.api import (
    ClinicRequest,
    DemoRequest,
    LoginRequest,
    MRBlockBody,
    MRCreateBody,
    MRUpdateBody,
    PermissionsRequest,
    SignupRequest,
    StaffCreateRequest,
    StaffLoginRequest,
    StaffUpdateRequest,
    WalkInRequest,
)
from app.utils.phone import normalize_phone, require_valid_phone
from app.utils.time import now_iso
from app.utils.users import public_user


router = APIRouter(tags=["Authentication"])


@router.post("/auth/login")
def login(payload: LoginRequest) -> dict[str, Any]:
    user = store.find_user_by_email(payload.email)
    if not user or not verify_password(payload.password, user.get("password_hash", "")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not user.get("is_active", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Clinic account is pending admin approval")

    if payload.role == "clinic" and user.get("role") != "clinic":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="This is not a clinic account")

    if payload.role == "admin" and user.get("role") == "clinic":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="This is not an admin portal account")

    try:
        store.update_user(user["id"], {"last_login": now_iso()})
    except Exception:
        pass
    return auth_response(store.get_user(user["id"]))


@router.post("/auth/staff-login")
def staff_login(payload: StaffLoginRequest) -> dict[str, Any]:
    phone = require_valid_phone(payload.phone)
    user = store.find_staff_by_phone(payload.clinic_id, phone)
    if not user or not verify_password(payload.pin, user.get("pin_hash", "")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid clinic ID, phone, or PIN")
    if not user.get("is_active", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Staff account is inactive")

    store.update_user(user["id"], {"last_login": now_iso()})
    store.add_activity(user["clinic_id"], user["id"], user["name"], user["clinic_role"], "Logged in")
    return auth_response(store.get_user(user["id"]))


@router.post("/auth/signup")
def signup(payload: SignupRequest) -> dict[str, Any]:
    if store.find_user_by_email(payload.email):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Email is already registered")
    phone = require_valid_phone(payload.phone)

    clinic_id = f"CLN-{uuid4().hex[:6].upper()}"
    clinic_name = payload.clinic_name or "New Clinic"
    doctor_name = payload.doctor_name or clinic_name
    store.add_clinic(
        {
            "id": clinic_id,
            "clinic_name": clinic_name,
            "doctor_name": doctor_name,
            "contact_phone": phone,
            "created_at": now_iso(),
            "status": "pending_approval",
            "submittedDate": now_iso(),
            "onboarding_notes": "Self-signup pending admin approval",
        }
    )
    try:
        user = store.add_user(
            {
                "id": f"USR-{uuid4().hex[:8].upper()}",
                "email": payload.email.lower(),
                "name": doctor_name,
                "role": "clinic",
                "clinic_role": "doctor_owner",
                "clinic_id": clinic_id,
                "phone": phone,
                "password_hash": hash_password(payload.password),
                "custom_permissions": {},
                "is_active": False,
                "created_at": now_iso(),
                "last_login": "Never",
            }
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc))
    return {
        "success": True,
        "status": "pending_approval",
        "message": "Signup received. Your clinic login will work after admin approval.",
        "clinic": store.get_clinic(clinic_id),
        "user": public_user(user),
    }


@router.post("/auth/logout")
def logout() -> dict[str, bool]:
    return {"success": True}


@router.get("/auth/me")
def me(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return public_user(current_user)


@router.post("/auth/forgot-password")
def forgot_password() -> dict[str, bool]:
    return {"success": True}


@router.post("/auth/reset-password")
def reset_password() -> dict[str, bool]:
    return {"success": True}


@router.post("/dev/demo-login")
def dev_demo_login(payload: dict[str, Any]) -> dict[str, Any]:
    """DEV-ONLY shortcut login — bypasses password, issues a real token.

    Only available when TRIKMED_DEV_SHORTCUTS env var is explicitly set to 'true'.
    Accepts {"user_id": "USR-..."} and returns the same shape as /auth/login.
    """
    import os as _os
    if _os.getenv("TRIKMED_DEV_SHORTCUTS", "false").strip().lower() != "true":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Dev shortcuts are disabled")

    user_id = payload.get("user_id", "")
    if not user_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="user_id is required")

    user = store.get_user(user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")
    if not user.get("is_active", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="User is inactive")

    try:
        store.update_user(user_id, {"last_login": now_iso()})
    except Exception:
        pass
    return auth_response(store.get_user(user_id))

