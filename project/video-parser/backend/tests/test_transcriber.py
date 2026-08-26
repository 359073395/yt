from types import SimpleNamespace

import pytest

from app.config import Settings
from app.models import TranscriptFormat
from app.transcriber import TranscriptSegment, Transcriber, render_transcript


def test_render_transcript_supports_txt_srt_and_vtt():
    segments = [TranscriptSegment(1.25, 3.5, "第一句话"), TranscriptSegment(4, 5, "Second line")]

    assert render_transcript(segments, TranscriptFormat.txt) == "第一句话\nSecond line\n"
    assert "00:00:01,250 --> 00:00:03,500" in render_transcript(segments, TranscriptFormat.srt)
    assert render_transcript(segments, TranscriptFormat.vtt).startswith("WEBVTT\n\n00:00:01.250")


@pytest.mark.asyncio
async def test_transcriber_writes_file_with_lazy_fake_model(tmp_path, monkeypatch):
    class FakeModel:
        def transcribe(self, *_args, **_kwargs):
            return iter([SimpleNamespace(start=0, end=1.5, text="  测试 文案  ")]), SimpleNamespace(language="zh")

    transcriber = Transcriber(Settings(download_dir=tmp_path, whisper_cache_dir=tmp_path / "models"))
    transcriber._model = FakeModel()
    monkeypatch.setattr(Transcriber, "available", property(lambda _self: True))
    source = tmp_path / "source.mp3"
    source.write_bytes(b"fake-media")

    output = await transcriber.transcribe(source, tmp_path / "result.srt", TranscriptFormat.srt, "zh")

    assert output.exists()
    assert "测试 文案" in output.read_text(encoding="utf-8")
