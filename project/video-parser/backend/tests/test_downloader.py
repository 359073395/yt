import asyncio
import json

from app.config import Settings
from app.downloader import DownloadRejected, Downloader
from app.models import CollectionInspectResponse, CollectionItem, JobCreateRequest, JobStatus, MediaType
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


def test_tiktok_public_stream_failure_is_reported_as_skipped():
    message = Downloader._safe_error(
        RuntimeError("ERROR: [TikTok] 123: Unexpected response from webpage request")
    )

    assert "TikTok" in message
    assert "已跳过" in message

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

DOUYIN_SEC_UID = "MS4wLjABAAAA5sbHNLYP00fNurvgupe9AnOBQwXfAGyZL3XihK-7CbQ"
DOUYIN_VIDEO_ID = "6710574475324280067"


def douyin_aweme(images=None):
    return {
        "aweme_id": DOUYIN_VIDEO_ID,
        "aweme_type": 68 if images else 0,
        "images": images or [],
        "desc": "Douyin fixture",
        "author": {"nickname": "Fixture creator"},
        "video": {
            "width": 1080,
            "height": 1920,
            "duration": 12_000,
            "cover": {"url_list": ["https://p3-sign.douyinpic.com/cover.jpeg"]},
            "play_addr": {
                "url_list": ["https://v3-web.douyinvod.com/video/original"],
                "width": 1080,
                "height": 1920,
                "data_size": 3_000_000,
            },
            "bit_rate": [
                {
                    "gear_name": "720p",
                    "bit_rate": 800_000,
                    "play_addr": {
                        "url_list": ["https://v3-web.douyinvod.com/video/720p"],
                        "width": 720,
                        "height": 1280,
                    },
                },
                {
                    "gear_name": "1080p",
                    "bit_rate": 1_600_000,
                    "play_addr": {
                        "url_list": ["https://v3-web.douyinvod.com/video/1080p"],
                        "width": 1080,
                        "height": 1920,
                    },
                },
            ],
        },
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


def test_douyin_share_profile_short_link_uses_public_session(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    captured = {}
    monkeypatch.setattr(
        downloader,
        "_resolve_douyin_url",
        lambda _url: f"https://www.iesdouyin.com/share/user/{DOUYIN_SEC_UID}?sec_uid={DOUYIN_SEC_UID}",
    )

    async def fake_posts(sec_uid, max_items, profile_url):
        captured.update({
            "sec_uid": sec_uid,
            "max_items": max_items,
            "profile_url": profile_url,
        })
        return ([{
            "aweme_id": "7678266474595665907",
            "desc": "Fixture",
            "author": {"sec_uid": sec_uid, "nickname": "Fixture Douyin Creator"},
            "video": {
                "duration": 1000,
                "play_addr": {"url_list": ["https://v3-dy-o.zjcdn.com/fixture.mp4"]},
                "cover": {"url_list": ["https://p3.douyinpic.com/fixture.jpg"]},
            },
        }], False, 1)

    monkeypatch.setattr(downloader.douyin_public, "profile_posts", fake_posts)
    source = "https://v.douyin.com/qybx95SkFnQ/"
    result = asyncio.run(downloader.inspect_collection(source, 50))

    assert result.extractor == "DouyinPublic"
    assert captured["profile_url"] == f"https://www.douyin.com/user/{DOUYIN_SEC_UID}"
    assert captured["sec_uid"] == DOUYIN_SEC_UID
    assert captured["max_items"] == 50


def test_douyin_batch_rejects_single_video_with_specific_message(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    monkeypatch.setattr(
        downloader,
        "_resolve_douyin_url",
        lambda _url: "https://www.douyin.com/video/7678266474595665907",
    )

    try:
        asyncio.run(downloader.inspect_collection("https://v.douyin.com/fixture/", 20))
    except DownloadRejected as exc:
        assert "单条解析" in str(exc)
    else:
        raise AssertionError("A Douyin single-video short link was accepted as a profile")


def test_douyin_cookie_file_is_converted_for_browser(tmp_path):
    cookie_file = tmp_path / "cookies.txt"
    cookie_file.write_text(
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tsecret\n"
        ".example.com\tTRUE\t/\tTRUE\t1893456000\tignored\tvalue\n",
        encoding="utf-8",
    )

    cookies = Downloader._browser_cookies(cookie_file)

    assert cookies == [{
        "name": "sessionid",
        "value": "secret",
        "domain": ".douyin.com",
        "path": "/",
        "secure": True,
        "expires": 1893456000,
    }]


def test_douyin_aweme_info_excludes_photo_posts_and_lists_qualities(tmp_path):
    downloader, _ = make_downloader(tmp_path)

    assert downloader._douyin_aweme_info(douyin_aweme(images=[{"url_list": ["https://example.com/a.jpeg"]}])) is None

    info = downloader._douyin_aweme_info(douyin_aweme())

    assert info is not None
    assert info["id"] == DOUYIN_VIDEO_ID
    assert info["title"] == "Douyin fixture"
    assert [item["format_id"] for item in info["formats"]] == [
        "douyin-1080p",
        "douyin-720p",
        "douyin-original",
    ]
    assert info["formats"][0]["url"].endswith("/1080p")


def test_douyin_profile_scan_retries_one_empty_browser_session(tmp_path, monkeypatch):
    downloader, _ = make_downloader(tmp_path)
    attempts = []

    async def fake_scan(source_url, *_args):
        attempts.append(source_url)
        if len(attempts) == 1:
            raise DownloadRejected("抖音主页没有返回公开视频；请稍后重试。")
        return CollectionInspectResponse(
            source_url=source_url,
            title="Fixture Douyin Creator",
            extractor="DouyinProfile",
            items=[CollectionItem(url=f"https://www.douyin.com/video/{DOUYIN_VIDEO_ID}", title="Fixture")],
        )

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(downloader, "_scan_douyin_profile_browser", fake_scan)
    monkeypatch.setattr("app.downloader.asyncio.sleep", no_sleep)
    source = f"https://www.douyin.com/user/{DOUYIN_SEC_UID}"

    result = asyncio.run(downloader._inspect_douyin_collection(source, 20, None))

    assert len(attempts) == 2
    assert len(result.items) == 1


def test_douyin_batch_download_reuses_profile_metadata(tmp_path, monkeypatch):
    downloader, store = make_downloader(tmp_path)
    url = f"https://www.douyin.com/video/{DOUYIN_VIDEO_ID}"
    info = downloader._douyin_aweme_info(douyin_aweme())
    assert info is not None
    downloader._remember_metadata(url, None, info)
    payload = JobCreateRequest(url=url, format_id="douyin-720p")
    job = store.create(url, "127.0.0.1", payload)
    streamed = {}

    async def unexpected_browser(*_args):
        raise AssertionError("cached profile metadata should avoid a second Douyin browser")

    async def fake_stream(current_job, media_url, output_path, headers):
        streamed.update({"url": media_url, "headers": headers})
        output_path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"x" * 1000)
        current_job.downloaded_bytes = output_path.stat().st_size

    monkeypatch.setattr(downloader, "_capture_douyin_browser_info", unexpected_browser)
    monkeypatch.setattr(downloader, "_stream_douyin_media", fake_stream)

    asyncio.run(downloader._download_douyin_browser(job))

    assert streamed["url"].endswith("/720p")
    assert streamed["headers"]["Referer"] == "https://www.douyin.com/"
    assert job.status == JobStatus.completed
    assert job.filename.endswith(".mp4")


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


def test_tiktok_download_streams_fresh_embed_media_without_ytdlp(tmp_path, monkeypatch):
    downloader, store = make_downloader(tmp_path)
    info = downloader._tiktok_info_from_embed_html(tiktok_embed_html(), TIKTOK_URL, TIKTOK_ID)
    payload = JobCreateRequest(url=TIKTOK_URL, format_id="embed-0", format_has_audio=True)
    job = store.create(TIKTOK_URL, "127.0.0.1", payload)
    streamed = {}

    async def canonical(url):
        return url

    def fresh_embed(_url):
        return info

    async def fake_stream(current_job, media_url, output_path, headers):
        streamed.update({"url": media_url, "headers": headers})
        output_path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"x" * 1000)
        current_job.downloaded_bytes = output_path.stat().st_size

    async def unexpected_capture(*_args, **_kwargs):
        raise AssertionError("yt-dlp should not run when fresh TikTok Embed data is available")

    monkeypatch.setattr(downloader, "_canonicalize_tiktok_url", canonical)
    monkeypatch.setattr(downloader, "_fetch_tiktok_embed_info", fresh_embed)
    monkeypatch.setattr(downloader, "_stream_tiktok_media", fake_stream)
    monkeypatch.setattr(downloader, "_capture_metadata", unexpected_capture)

    asyncio.run(downloader._download(job))

    assert streamed["url"] == "https://v16.tiktokcdn.com/video/test.mp4"
    assert streamed["headers"]["Referer"] == f"https://www.tiktok.com/embed/v2/{TIKTOK_ID}"
    assert job.status == JobStatus.completed
    assert job.filename.endswith(".mp4")


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


def test_batch_quality_ceiling_builds_safe_selector(tmp_path):
    downloader, store = make_downloader(tmp_path)
    payload = JobCreateRequest(url="https://example.com/video", format_id="max-1080")
    job = store.create(payload.url, "127.0.0.1", payload)

    command = downloader._download_command(job, None)

    assert command[command.index("--format") + 1] == "bv*[height<=1080]+ba/b[height<=1080]/b"


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


def test_cookie_platform_detects_supported_hosts():
    assert Downloader._cookie_platform("https://v.douyin.com/example/") == "douyin"
    assert Downloader._cookie_platform("https://www.tiktok.com/@creator/video/123") == "tiktok"
    assert Downloader._cookie_platform("https://youtu.be/example") == "youtube"
    assert Downloader._cookie_platform("https://example.com/video") is None


def test_subtitle_cues_parse_vtt_json3_and_ttml():
    vtt = b"WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <b>world</b>\n"
    json3 = b'{"events":[{"tStartMs":500,"dDurationMs":1000,"segs":[{"utf8":"Json text"}]}]}'
    ttml = b'<tt><body><div><p begin="00:00:03.000" end="00:00:04.000">XML text</p></div></body></tt>'

    assert Downloader._subtitle_cues(vtt, "vtt")[0].text == "Hello world"
    assert Downloader._subtitle_cues(json3, "json3")[0].start == 0.5
    assert Downloader._subtitle_cues(ttml, "ttml")[0].text == "XML text"


def test_subtitle_languages_prioritize_common_chinese_and_english():
    languages = {f"lang-{index:03d}" for index in range(150)} | {"zh-Hans", "en", "id"}

    ordered = Downloader._ordered_subtitle_languages(languages)

    assert ordered[:3] == ["zh-Hans", "en", "id"]
    assert len(ordered) == 120
