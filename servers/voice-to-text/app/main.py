from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, Query, UploadFile

from .service import get_model, get_settings, transcribe_bytes

app = FastAPI(title="Standalone Whisper Service", version="1.0.0")


@app.on_event("startup")
def warmup() -> None:
    # Model preloading keeps first request latency predictable.
    get_model()


@app.get("/health")
def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "model": settings.whisper_model_size,
        "device": settings.whisper_device,
        "compute_type": settings.whisper_compute_type,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    task: str = Query(default="transcribe", pattern="^(transcribe|translate)$"),
    language: str | None = Query(default=None),
    initial_prompt: str | None = Query(default=None),
    vad_filter: bool | None = Query(default=None),
) -> dict:
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        result = transcribe_bytes(
            audio_bytes,
            task=task,
            language=language,
            initial_prompt=initial_prompt,
            vad_filter=vad_filter,
        )
        return result.model_dump()
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc