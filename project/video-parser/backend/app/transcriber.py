from __future__ import annotations

import asyncio
import html
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .config import Settings
from .models import TranscriptFormat


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str


class TranscriptionUnavailable(RuntimeError):
    pass


class Transcriber:
    """Lazy CPU-friendly faster-whisper wrapper.

    The model is loaded only for an AI transcript job. Model files live in the
    persistent cache directory instead of the read-only container filesystem.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any | None = None
        self._lock = asyncio.Lock()
        self._sync_lock = threading.Lock()

    @property
    def available(self) -> bool:
        if not self.settings.transcription_enabled:
            return False
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    async def transcribe(
        self,
        media_path: Path,
        output_path: Path,
        output_format: TranscriptFormat,
        language: str | None = None,
    ) -> Path:
        if not self.available:
            raise TranscriptionUnavailable("服务器未启用 AI 语音转写。")
        async with self._lock:
            segments = await asyncio.to_thread(self._transcribe_sync, media_path, language)
        if not segments:
            raise TranscriptionUnavailable("视频中没有识别出可导出的语音。")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(render_transcript(segments, output_format), encoding="utf-8")
        return output_path

    def _load_model(self):  # noqa: ANN201
        if self._model is None:
            from faster_whisper import WhisperModel

            self.settings.whisper_cache_dir.mkdir(parents=True, exist_ok=True)
            self._model = WhisperModel(
                self.settings.whisper_model,
                device=self.settings.whisper_device,
                compute_type=self.settings.whisper_compute_type,
                cpu_threads=self.settings.whisper_cpu_threads,
                download_root=str(self.settings.whisper_cache_dir),
            )
        return self._model

    def _transcribe_sync(self, media_path: Path, language: str | None) -> list[TranscriptSegment]:
        with self._sync_lock:
            model = self._load_model()
            raw_segments, _ = model.transcribe(
                str(media_path),
                language=None if not language or language == "auto" else language,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=True,
            )
            segments: list[TranscriptSegment] = []
            for item in raw_segments:
                text = clean_text(str(item.text or ""))
                if text:
                    segments.append(TranscriptSegment(float(item.start), float(item.end), text))
            return segments


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def render_transcript(segments: Iterable[TranscriptSegment], output_format: TranscriptFormat) -> str:
    items = list(segments)
    if output_format == TranscriptFormat.txt:
        return "\n".join(item.text for item in items) + "\n"
    if output_format == TranscriptFormat.vtt:
        blocks = ["WEBVTT", ""]
        for item in items:
            blocks.extend([f"{_timestamp(item.start, vtt=True)} --> {_timestamp(item.end, vtt=True)}", item.text, ""])
        return "\n".join(blocks)
    blocks: list[str] = []
    for index, item in enumerate(items, 1):
        blocks.extend([str(index), f"{_timestamp(item.start)} --> {_timestamp(item.end)}", item.text, ""])
    return "\n".join(blocks)


def _timestamp(seconds: float, *, vtt: bool = False) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    separator = "." if vtt else ","
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"
