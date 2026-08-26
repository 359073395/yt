import asyncio
import json

from app.config import Settings
from app.downloader import Downloader
from app.models import JobCreateRequest, JobStatus, MediaType
from app.store import JobStore


INFO = {
    "title": "Fake Video",
    "extractor_key": "YouTube",
    "duration": 12,
    "thumbnail": "https://example.com/thumb.jpg",
    "formats": [
        {"format_id": "137", "ext": "mp4", "height": 1080, "fps": 30, "vcodec": "avc1", "acodec": "none", "filesize": 1024},
        {"format_id": "18", "ext": "mp4", "height": 360, "vcodec": "avc1", "acodec": "mp4a", "filesize": 512},
    ],
    "subtitles": {"zh-CN": [{"ext": "vtt"}]},
    "automatic_captions": {"en": [{"ext": "vtt"}]},
}


def make_downloader(tmp_path):
    settings = Settings(download_dir=tmp_path / "downloads", database_path=tmp_path / "data.sqlite3", max_concurrent_downloads=1)
    store = JobStore(settings.download_dir, ttl_seconds=60, database_path=settings.database_path)
    return Downloader(settings, store), store


def test_inspect_returns_selectable_formats(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)

    async def fake_capture(*_args, **_kwargs):
        return json.dumps(INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)
    result = asyncio.run(downloader.inspect("https://example.com/video"))

    assert result.title == "Fake Video"
    assert [item.format_id for item in result.formats] == ["best", "137", "18"]
    assert result.formats[1].has_audio is False
    assert {item.language for item in result.subtitles} == {"zh-CN", "en"}


def test_download_command_is_allowlisted(tmp_path):
    downloader, store = make_downloader(tmp_path)
    payload = JobCreateRequest(url="https://example.com/video", format_id="137", subtitle_language="zh-CN")
    job = store.create(payload.url, "127.0.0.1", payload)

    command = downloader._download_command(job, None)

    assert "137+bestaudio/137" in command
    assert "--embed-subs" in command
    assert command[-1] == payload.url


def test_progress_updates_speed_and_eta(tmp_path):
    downloader, store = make_downloader(tmp_path)
    job = store.create("https://example.com/video", "127.0.0.1")

    consumed = downloader._consume_progress(job, "YL_PROGRESS|512|1024|NA|128|4")

    assert consumed is True
    assert job.status == JobStatus.downloading
    assert job.progress == 50
    assert job.speed == 128
    assert job.eta == 4


def test_audio_command_uses_selected_codec(tmp_path):
    downloader, store = make_downloader(tmp_path)
    payload = JobCreateRequest(url="https://example.com/video", media_type=MediaType.audio, audio_format="flac")
    job = store.create(payload.url, "127.0.0.1", payload)

    command = downloader._download_command(job, None)

    assert command[command.index("--audio-format") + 1] == "flac"
    assert "--extract-audio" in command


def test_queued_job_can_be_cancelled_without_starting(tmp_path):
    async def scenario():
        downloader, store = make_downloader(tmp_path)
        job = store.create("https://example.com/video", "127.0.0.1")
        await downloader.semaphore.acquire()
        task = asyncio.create_task(downloader.run(job))
        await asyncio.sleep(0)
        await downloader.cancel(job)
        downloader.semaphore.release()
        await task
        assert job.status == JobStatus.cancelled

    asyncio.run(scenario())
