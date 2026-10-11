from __future__ import annotations

from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI

# Local development runs uvicorn directly, which does not load .env itself.
# Load it before importing routes so ASR/LLM provider configuration is available.
load_dotenv(Path(__file__).with_name(".env"))

from app.api.routes import (
    ai,
    drugs,
    analytics,
    appointments,
    auth,
    clinic,
    health,
    missed_calls,
    mr,
    patients,
    portal,
    prescriptions,
    public,
    qr,
    queue,
    reminders,
    staff,
    whatsapp,
)
from app.middleware.cors import configure_cors


app = FastAPI(title="TrikMed API", version="0.1.0")

configure_cors(app)

for router in (
    health.router,
    ai.router,
    drugs.router,
    auth.router,
    public.router,
    staff.router,
    patients.router,
    queue.router,
    appointments.router,
    clinic.router,
    portal.router,
    mr.router,
    qr.router,
    analytics.router,
    prescriptions.router,
    reminders.router,
    missed_calls.router,
    whatsapp.router,
):
    app.include_router(router)
