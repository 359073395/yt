import asyncio
import json

from app.config import Settings
from app.downloader import DownloadRejected, Downloader
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


def test_tiktok_oembed_restores_canonical_author_url(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    monkeypatch.setattr(
        downloader,
        "_fetch_tiktok_oembed",
        lambda _url: {
            "author_url": "https://www.tiktok.com/@cisun_",
            "author_unique_id": "cisun_",
            "embed_product_id": "7678218577157115156",
        },
    )

    resolved = asyncio.run(
        downloader._canonicalize_tiktok_url(
            "https://www.tiktok.com/@_/video/7678218577157115156",
        ),
    )

    assert resolved == "https://www.tiktok.com/@cisun_/video/7678218577157115156"


def test_inspect_uses_canonical_tiktok_url(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    commands = []
    monkeypatch.setattr(
        downloader,
        "_fetch_tiktok_oembed",
        lambda _url: {
            "author_unique_id": "cisun_",
            "embed_product_id": "7678218577157115156",
        },
    )

    async def fake_capture(command, *_args, **_kwargs):
        commands.append(command)
        return json.dumps(INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)
    result = asyncio.run(
        downloader.inspect("https://www.tiktok.com/@_/video/7678218577157115156"),
    )

    expected = "https://www.tiktok.com/@cisun_/video/7678218577157115156"
    assert commands[0][-1] == expected
    assert "--impersonate" not in commands[0]
    extractor_args = commands[0][commands[0].index("--extractor-args") + 1]
    assert extractor_args.startswith("tiktok:app_info=7")
    assert result.url == expected
    assert downloader._cached_metadata(expected, None) == INFO


def test_tiktok_retries_another_browser_fingerprint(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    targets = []
    monkeypatch.setattr(
        downloader,
        "_fetch_tiktok_oembed",
        lambda _url: {
            "author_unique_id": "cisun_",
            "embed_product_id": "7678218577157115156",
        },
    )

    async def fake_capture(command, *_args, **_kwargs):
        target = command[command.index("--impersonate") + 1] if "--impersonate" in command else None
        targets.append(target)
        if len(targets) == 1:
            raise DownloadRejected("Unable to extract universal data for rehydration")
        return json.dumps(INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)
    asyncio.run(downloader.inspect("https://www.tiktok.com/@_/video/7678218577157115156"))

    assert targets == [None, "Edge-101:Windows-10"]


def test_non_tiktok_url_skips_oembed(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)

    def unexpected_fetch(_url):
        raise AssertionError("oEmbed should not be requested")

    monkeypatch.setattr(downloader, "_fetch_tiktok_oembed", unexpected_fetch)

    assert asyncio.run(downloader._canonicalize_tiktok_url("https://example.com/video")) == "https://example.com/video"


def test_download_command_is_allowlisted(tmp_path):
    downloader, store = make_downloader(tmp_path)
    payload = JobCreateRequest(url="https://example.com/video", format_id="137", subtitle_language="zh-CN")
    job = store.create(payload.url, "127.0.0.1", payload)

    command = downloader._download_command(job, None)

    assert "137+bestaudio/137" in command
    assert "--embed-subs" in command
    assert command[-1] == payload.url


def test_download_command_can_reuse_inspection_json(tmp_path):
    downloader, store = make_downloader(tmp_path)
    payload = JobCreateRequest(url="https://www.tiktok.com/@cisun_/video/7678218577157115156")
    job = store.create(payload.url, "127.0.0.1", payload)
    info_path = store.job_dir(job.job_id) / ".yt-info.json"

    command = downloader._download_command(job, None, info_path=info_path)

    assert command[-2:] == ["--load-info-json", str(info_path)]
    assert payload.url not in command


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
