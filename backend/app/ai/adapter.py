from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Protocol, TypeVar
import httpx
from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class Transcript(BaseModel):
    text: str
    language: str = "hi-IN"
    confidence: float = 1.0
    duration_seconds: float = 0.0


class SpeechClient(Protocol):
    def transcribe(self, audio: bytes, filename: str = "audio.wav", language_hint: str | None = None) -> Transcript: ...


class LLMClient(Protocol):
    def complete(self, system: str, user: str, schema: type[T]) -> T: ...


class AIError(RuntimeError):
    """Base class for AI-provider failures. Routes catch this and show the doctor a safe,
    honest message instead of ever returning a fabricated prescription (Fix Guide Fix 2)."""


class AIUnavailableError(AIError):
    """Provider not configured, unreachable, rate-limited, or returned a non-200 response."""


class AIOutputError(AIError):
    """Provider answered, but the output is not valid JSON / does not match our schema."""


# ── De-identification Layer (Section 12) ──────────────────────────────────────

class DeIdentifier:
    @staticmethod
    def scrub_text(text: str, patient_name: str | None = None, doctor_name: str | None = None) -> str:
        scrubbed = text
        if patient_name and len(patient_name.strip()) > 1:
            scrubbed = re.sub(re.escape(patient_name.strip()), "[PATIENT_NAME]", scrubbed, flags=re.IGNORECASE)
        if doctor_name and len(doctor_name.strip()) > 1:
            scrubbed = re.sub(re.escape(doctor_name.strip()), "[DOCTOR_NAME]", scrubbed, flags=re.IGNORECASE)
        # Scrub 10-digit Indian phone numbers
        scrubbed = re.sub(r"\b[6-9]\d{9}\b", "[PHONE_NUMBER]", scrubbed)
        return scrubbed


INDIAN_CLINICAL_PROMPT = (
    "Indian clinical OPD consultation dictation with common medicines: "
    "Dolo 650, Crocin 650, Calpol 500, Augmentin 625, Azithral 500, Pan-D, Pantocid 40, "
    "Telma 40, Glycomet 500, Montair-LC, Allegra 120, Combiflam, Meftal-Spas, Voveran, "
    "O2, Taxim-O, Clavam 625, Ascoril-D, Becosules, Shelcal 500, Supradyn. "
    "Preserve symptoms, medicine brand names, dosages (mg/ml), frequencies (1-0-1, 1-0-0), "
    "timings (after food), and investigations."
)


# ── Groq Whisper Speech Provider ──────────────────────────────────────────────

class GroqWhisperSpeechClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "").strip()

    def transcribe(self, audio: bytes, filename: str = "audio.wav", language_hint: str | None = None) -> Transcript:
        if not self.api_key:
            raise AIUnavailableError("Groq speech provider not configured")

        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = {
            "model": "whisper-large-v3-turbo",
            "temperature": "0.0",
            "response_format": "json",
            "prompt": INDIAN_CLINICAL_PROMPT,
        }
        if language_hint:
            data["language"] = language_hint.split("-")[0]  # e.g. 'hi' for 'hi-IN'

        mime_type = mimetypes.guess_type(filename)[0] or "audio/wav"
        files = {"file": (filename, audio, mime_type)}

        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.post(url, headers=headers, data=data, files=files)
        except httpx.HTTPError as e:
            raise AIUnavailableError("Groq speech provider unreachable") from e
        if resp.status_code != 200:
            logger.warning("speech_call_failed provider=groq status=%s", resp.status_code)
            raise AIUnavailableError(f"Groq speech provider returned {resp.status_code}")

        res_json = resp.json()
        return Transcript(
            text=res_json.get("text", "").strip(),
            language=language_hint or "hi-IN",
            confidence=0.95
        )


# ── OpenAI speech + structured prescription providers ────────────────────────

class OpenAITranscriptionClient:
    """Server-side OpenAI transcription with prompt biasing."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "").strip()

    def transcribe(self, audio: bytes, filename: str = "audio.wav", language_hint: str | None = None) -> Transcript:
        if not self.api_key:
            raise AIUnavailableError("OpenAI speech provider not configured")

        data: dict[str, str] = {
            "model": os.getenv("OPENAI_TRANSCRIPTION_MODEL", "whisper-1"),
            "prompt": INDIAN_CLINICAL_PROMPT,
        }
        if language_hint:
            data["language"] = language_hint.split("-")[0]

        mime_type = mimetypes.guess_type(filename)[0] or "audio/webm"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers=headers,
                    data=data,
                    files={"file": (filename, audio, mime_type)},
                )
        except httpx.HTTPError as e:
            raise AIUnavailableError("OpenAI speech provider unreachable") from e
        if resp.status_code != 200:
            logger.warning("speech_call_failed provider=openai status=%s", resp.status_code)
            raise AIUnavailableError(f"OpenAI speech provider returned {resp.status_code}")
        result = resp.json()
        text = result.get("text", "").strip()
        if not text:
            raise AIOutputError("No speech was detected. Please speak closer to the microphone and try again.")
        return Transcript(text=text, language=language_hint or "en-IN", confidence=0.95)


class OpenAILLMClient:
    """Standard OpenAI Chat Completions with JSON Object structuring."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "").strip()

    def complete(self, system: str, user: str, schema: type[T]) -> T:
        if not self.api_key:
            raise AIUnavailableError("LLM provider not configured")

        payload = {
            "model": os.getenv("OPENAI_LLM_MODEL", "gpt-4o-mini"),
            "messages": [
                {"role": "system", "content": f"{system}\n\nYou must respond strictly with valid JSON conforming to the schema."},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        try:
            with httpx.Client(timeout=45.0) as client:
                resp = client.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
        except httpx.HTTPError as e:
            raise AIUnavailableError("LLM provider unreachable") from e
        if resp.status_code != 200:
            logger.warning("llm_call_failed provider=openai status=%s", resp.status_code)
            raise AIUnavailableError(f"LLM provider returned {resp.status_code}")
        try:
            content = resp.json()["choices"][0]["message"]["content"]
            return schema.model_validate(json.loads(content))
        except (KeyError, IndexError, ValueError, ValidationError) as e:
            raise AIOutputError("LLM output did not match the prescription schema") from e


# ── Google Gemini LLM Provider ────────────────────────────────────────────────

class GeminiLLMClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY", "").strip()

    def complete(self, system: str, user: str, schema: type[T]) -> T:
        if not self.api_key:
            raise AIUnavailableError("Gemini LLM provider not configured")

        models_to_try = [
            os.getenv("GEMINI_MODEL", "gemini-flash-latest"),
            "gemini-flash-latest",
            "gemini-3.8-flash",
            "gemini-3.1-flash-lite",
        ]

        json_schema = json.dumps(schema.model_json_schema(), indent=2)
        system_prompt = f"{system}\n\nYou must respond strictly with a valid JSON object adhering to this JSON Schema:\n{json_schema}"
        payload = {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"parts": [{"text": user}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.1
            }
        }

        last_error: Exception | None = None
        for model_name in models_to_try:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={self.api_key}"
                with httpx.Client(timeout=30.0) as client:
                    resp = client.post(url, json=payload)
            except httpx.HTTPError as e:
                logger.warning("llm_call_failed provider=gemini model=%s unreachable", model_name)
                last_error = e
                continue
            if resp.status_code != 200:
                logger.warning("llm_call_failed provider=gemini model=%s status=%s", model_name, resp.status_code)
                last_error = AIUnavailableError(f"Gemini model {model_name} returned {resp.status_code}")
                continue
            try:
                res_data = resp.json()
                raw_text = res_data["candidates"][0]["content"]["parts"][0]["text"]
                parsed_json = json.loads(raw_text)
                # Sanitize null list fields — Gemini sometimes returns null instead of []
                list_fields = ["symptoms","medicines","investigations","instruction_tags","advice","warnings","extraction_warnings","follow_up"]
                for field in list_fields:
                    if parsed_json.get(field) is None:
                        parsed_json[field] = []
                return schema.model_validate(parsed_json)
            except (KeyError, IndexError, ValueError, ValidationError) as e:
                logger.warning("llm_output_invalid provider=gemini model=%s", model_name)
                last_error = AIOutputError(f"Gemini model {model_name} output did not match the schema")

        raise AIUnavailableError("All Gemini models failed") from last_error


# ── Self-hosted Whisper (default speech provider) ─────────────────────────────

class FasterWhisperSpeechClient:
    """Local ASR adapter; model selection belongs in FASTER_WHISPER_MODEL."""
    def transcribe(self, audio: bytes, filename: str = "audio.wav", language_hint: str | None = None) -> Transcript:
        from app.ai.whisper_service import whisper_service
        suffix = Path(filename).suffix or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(audio)
            temp_path = handle.name
        try:
            text = whisper_service.transcribe_audio(temp_path)
            if not text:
                raise RuntimeError("No speech was detected. Please speak closer to the microphone and try again.")
            return Transcript(text=text, language=(language_hint or "hi-IN"), confidence=0.9)
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def get_speech_client() -> SpeechClient:
    provider = os.getenv("AI_SPEECH_PROVIDER", "local").lower()
    # Explicit local / faster-whisper: no cloud key needed
    if provider in ("local", "faster-whisper", "faster_whisper"):
        return FasterWhisperSpeechClient()
    # Groq Whisper (cloud)
    if provider == "groq" and os.getenv("GROQ_API_KEY"):
        return GroqWhisperSpeechClient()
    # OpenAI Whisper (cloud)
    if provider == "openai" and os.getenv("OPENAI_API_KEY"):
        return OpenAITranscriptionClient()
    # Auto-detect cloud keys when provider is unset/unknown
    if os.getenv("GROQ_API_KEY"):
        return GroqWhisperSpeechClient()
    if os.getenv("OPENAI_API_KEY"):
        return OpenAITranscriptionClient()
    # Default: local faster-whisper (never use stub in a real voice request)
    return FasterWhisperSpeechClient()


def get_llm_client() -> LLMClient:
    provider = os.getenv("AI_LLM_PROVIDER", "").lower()
    if provider == "stub":
        # Explicit, APP_ENV-gated opt-in only — never reachable in production, and the
        # stub class itself lives in tests/fakes.py, not in this production package.
        if os.getenv("APP_ENV", "production") == "production":
            raise RuntimeError("Stub LLM is not allowed when APP_ENV=production")
        from tests.fakes import LocalStubLLMClient
        return LocalStubLLMClient()
    if provider == "gemini":
        return GeminiLLMClient()
    if provider == "openai":
        return OpenAILLMClient()
    raise AIUnavailableError(f"Unknown AI_LLM_PROVIDER: {provider!r}")
