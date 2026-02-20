from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from typing import Any

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class WhisperSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    whisper_model_size: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    whisper_beam_size: int = 5
    whisper_vad_filter: bool = True


class SegmentDTO(BaseModel):
    id: int
    start: float
    end: float
    text: str


class TranscriptionResult(BaseModel):
    language: str
    language_probability: float
    duration: float
    text: str
    segments: list[SegmentDTO]


@lru_cache(maxsize=1)
def get_settings() -> WhisperSettings:
    return WhisperSettings()


@lru_cache(maxsize=1)
def _ensure_windows_ctranslate2_dirs() -> None:
    # Some Windows wheels expect these folders before DLL registration.
    if not sys.platform.startswith("win"):
        return

    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    (site_packages / "_rocm_sdk_core" / "bin").mkdir(parents=True, exist_ok=True)
    (site_packages / "_rocm_sdk_libraries_custom" / "bin").mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_model() -> Any:
    settings = get_settings()
    _ensure_windows_ctranslate2_dirs()

    from faster_whisper import WhisperModel

    return WhisperModel(
        settings.whisper_model_size,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
    )


def transcribe_bytes(
    audio_bytes: bytes,
    *,
    task: str = "transcribe",
    language: str | None = None,
    initial_prompt: str | None = None,
    vad_filter: bool | None = None,
) -> TranscriptionResult:
    settings = get_settings()
    model = get_model()

    effective_vad_filter = settings.whisper_vad_filter if vad_filter is None else vad_filter

    temp_path: Path | None = None
    try:
        # On Windows the file must be closed before the model can reopen it.
        with NamedTemporaryFile(suffix=".bin", delete=False) as temp:
            temp.write(audio_bytes)
            temp.flush()
            temp_path = Path(temp.name)

        segments, info = model.transcribe(
            str(temp_path),
            task=task,
            language=language,
            initial_prompt=initial_prompt,
            beam_size=settings.whisper_beam_size,
            vad_filter=effective_vad_filter,
        )

        segment_list: list[SegmentDTO] = []
        full_text_parts: list[str] = []
        for idx, seg in enumerate(segments):
            text = seg.text.strip()
            full_text_parts.append(text)
            segment_list.append(
                SegmentDTO(
                    id=idx,
                    start=seg.start,
                    end=seg.end,
                    text=text,
                )
            )
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    return TranscriptionResult(
        language=info.language,
        language_probability=info.language_probability,
        duration=info.duration,
        text=" ".join(part for part in full_text_parts if part).strip(),
        segments=segment_list,
    )
