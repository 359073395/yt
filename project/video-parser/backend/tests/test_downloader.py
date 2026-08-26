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
    "subtitles": {"zh-CN": [{"ext": "vtt", "url": "https://example.com/zh-CN.vtt"}]},
    "automatic_captions": {"en": [{"ext": "vtt", "url": "https://example.com/en.vtt"}]},
}

TIKTOK_ID = "7678218577157115156"
TIKTOK_URL = f"https://www.tiktok.com/@cisun_/video/{TIKTOK_ID}"

COLLECTION_INFO = {
    "_type": "playlist",
    "title": "Fixture Channel",
    "extractor_key": "YoutubeTab",
    "playlist_count": 3,
    "entries": [
        {
            "id": "abc123XYZ_0",
            "title": "First video",
            "url": "https://www.youtube.com/watch?v=abc123XYZ_0",
            "thumbnail": "https://example.com/first.jpg",
            "duration": 30,
            "channel": "Fixture Channel",
        },
        {
            "id": "def456XYZ_1",
            "title": "Second video",
            "url": "https://www.youtube.com/watch?v=def456XYZ_1",
            "duration": 45,
        },
        {
            "id": "ghi789XYZ_2",
            "title": "Third video",
            "url": "https://www.youtube.com/watch?v=ghi789XYZ_2",
        },
    ],
}


def tiktok_embed_html():
    state = {
        "source": {
            "data": {
                f"/embed/v2/{TIKTOK_ID}": {
                    "videoData": {
                        "itemInfos": {
                            "id": TIKTOK_ID,
                            "text": "TikTok fixture",
                            "createTime": "1787724578",
                            "coversOrigin": ["https://p16-common-sign.tiktokcdn.com/cover.jpeg"],
                            "video": {
                                "urls": ["https://v16.tiktokcdn.com/video/test.mp4"],
                                "videoMeta": {"width": 576, "height": 1024, "duration": 10},
                            },
                        },
                        "authorInfos": {"uniqueId": "cisun_", "userId": "7328567436838487045"},
                    },
                },
            },
        },
    }
    return f'<script id="__FRONTITY_CONNECT_STATE__" type="application/json">{json.dumps(state)}</script>'


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
    assert result.thumbnail_proxy_url.startswith("/api/assets/cover?")
    assert all(item.download_url.startswith("/api/assets/subtitle?") for item in result.subtitles)


def test_collection_inspect_returns_profile_videos_without_downloading(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    commands = []

    async def fake_capture(command, *_args, **_kwargs):
        commands.append(command)
        return json.dumps(COLLECTION_INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)
    result = asyncio.run(downloader.inspect_collection("https://www.youtube.com/@fixture/videos", 2))

    assert result.title == "Fixture Channel"
    assert [item.title for item in result.items] == ["First video", "Second video"]
    assert result.items[0].thumbnail_proxy_url.startswith("/api/assets/cover?")
    assert result.truncated is True
    assert "--flat-playlist" in commands[0]
    assert commands[0][commands[0].index("--playlist-end") + 1] == "3"
    assert "--no-playlist" not in commands[0]
    assert "--skip-download" in commands[0]


def test_collection_inspect_rejects_single_video_link(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)

    async def fake_capture(*_args, **_kwargs):
        return json.dumps(INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)

    try:
        asyncio.run(downloader.inspect_collection("https://example.com/video", 20))
    except DownloadRejected as exc:
        assert "主页" in str(exc) or "播放列表" in str(exc)
    else:
        raise AssertionError("A single video URL was accepted as a collection")


def test_tiktok_collection_retries_with_browser_impersonation(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    targets = []

    async def fake_capture(command, *_args, **_kwargs):
        target = command[command.index("--impersonate") + 1] if "--impersonate" in command else None
        targets.append(target)
        if target is None:
            raise DownloadRejected("Unable to extract secondary user ID")
        return json.dumps(COLLECTION_INFO)

    monkeypatch.setattr(downloader, "_run_capture", fake_capture)
    result = asyncio.run(downloader.inspect_collection("https://www.tiktok.com/@corgibobaa", 2))

    assert len(result.items) == 2
    assert targets == [None, "Edge-101:Windows-10"]


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


def test_tiktok_embed_state_provides_direct_download_info(tmp_path):
    downloader, _ = make_downloader(tmp_path)

    info = downloader._tiktok_info_from_embed_html(tiktok_embed_html(), TIKTOK_URL, TIKTOK_ID)

    assert info["id"] == TIKTOK_ID
    assert info["title"] == "TikTok fixture"
    assert info["uploader"] == "cisun_"
    assert info["formats"][0]["url"] == "https://v16.tiktokcdn.com/video/test.mp4"
    assert info["formats"][0]["acodec"] == "aac"
    assert info["formats"][0]["format_note"] == "原始画质"


def test_tiktok_embed_rejects_untrusted_media_host(tmp_path):
    downloader, _ = make_downloader(tmp_path)
    html = tiktok_embed_html().replace("https://v16.tiktokcdn.com/video/test.mp4", "https://example.com/test.mp4")

    try:
        downloader._tiktok_info_from_embed_html(html, TIKTOK_URL, TIKTOK_ID)
    except ValueError as exc:
        assert "media URL" in str(exc)
    else:
        raise AssertionError("Untrusted TikTok media URL was accepted")


def test_tiktok_inspect_prefers_official_embed_source(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    info = downloader._tiktok_info_from_embed_html(tiktok_embed_html(), TIKTOK_URL, TIKTOK_ID)
    monkeypatch.setattr(downloader, "_fetch_tiktok_oembed", lambda _url: {})
    monkeypatch.setattr(downloader, "_fetch_tiktok_embed_info", lambda _url: info)

    async def unexpected_capture(*_args, **_kwargs):
        raise AssertionError("yt-dlp should not run when TikTok Embed succeeds")

    monkeypatch.setattr(downloader, "_run_capture", unexpected_capture)
    result = asyncio.run(downloader.inspect(TIKTOK_URL))

    assert result.platform == "TikTokEmbed"
    assert [item.format_id for item in result.formats] == ["embed-0"]
    assert result.formats[0].label == "576×1024 · MP4 · 原始画质 · 含音频"
    assert result.subtitle_note == "该视频未提供可下载字幕"


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
    monkeypatch.setattr(downloader, "_fetch_tiktok_embed_info", lambda _url: (_ for _ in ()).throw(ValueError()))

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
    monkeypatch.setattr(downloader, "_fetch_tiktok_embed_info", lambda _url: (_ for _ in ()).throw(ValueError()))

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
