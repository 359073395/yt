from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import secrets
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime
from xml.etree import ElementTree
from contextlib import asynccontextmanager, nullcontext, suppress
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

import httpx

from .assets import RemoteAssetError, fetch_remote_asset, signed_asset_url
from .config import Settings
from .cookies import CookieStore
from .models import (
    CollectionInspectResponse,
    CollectionItem,
    FormatOption,
    Job,
    JobStatus,
    MediaType,
    ParseResponse,
    SubtitleOption,
    TranscriptFormat,
    TranscriptMode,
)
from .store import JobStore
from .transcriber import TranscriptSegment, Transcriber, TranscriptionUnavailable, clean_text, render_transcript


logger = logging.getLogger(__name__)


class DownloadRejected(Exception):
    pass


class Downloader:
    PROGRESS_PREFIX = "YL_PROGRESS|"
    TIKTOK_OEMBED_MAX_BYTES = 256 * 1024
    TIKTOK_EMBED_MAX_BYTES = 2 * 1024 * 1024
    METADATA_CACHE_TTL_SECONDS = 10 * 60
    TIKTOK_IMPERSONATE_TARGETS: tuple[str | None, ...] = (
        None,
        "Edge-101:Windows-10",
        "Safari-26.0:Ios-26.0",
        "Firefox-144:Macos-26",
        "Safari-18.4:Ios-18.4",
    )
    BROWSER_USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    )

    def __init__(self, settings: Settings, store: JobStore, cookies: CookieStore | None = None) -> None:
        self.settings = settings
        self.store = store
        self.cookies = cookies
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_downloads)
        self.douyin_browser_semaphore = asyncio.Semaphore(1)
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.metadata_cache: dict[tuple[str, str | None, int | None], tuple[float, dict[str, Any]]] = {}
        self.douyin_video_profiles: dict[str, str] = {}
        self.transcriber = Transcriber(settings)

    @asynccontextmanager
    async def _chromium_browser(self, chromium: str):
        from playwright.async_api import async_playwright

        playwright: Any = None
        browser: Any = None
        try:
            logger.info("downloader chromium_starting binary=%s", chromium)
            playwright = await asyncio.wait_for(async_playwright().start(), timeout=10)
            browser = await asyncio.wait_for(
                playwright.chromium.launch(
                    executable_path=chromium,
                    headless=True,
                    args=[
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        "--disable-extensions",
                        "--disable-background-networking",
                        "--disable-sync",
                        "--no-first-run",
                        "--renderer-process-limit=2",
                    ],
                ),
                timeout=20,
            )
            logger.info("downloader chromium_ready version=%s", browser.version)
        except TimeoutError as exc:
            logger.warning("downloader chromium_timeout", exc_info=True)
            raise DownloadRejected("服务器浏览器启动超时，请重启影链工坊后重试。") from exc
        except Exception as exc:  # noqa: BLE001
            logger.warning("downloader chromium_failed error=%s", str(exc)[:240], exc_info=True)
            raise DownloadRejected("服务器浏览器启动失败，请重启影链工坊后重试。") from exc

        try:
            yield browser
        finally:
            if browser:
                with suppress(Exception):
                    await asyncio.wait_for(browser.close(), timeout=5)
            if playwright:
                with suppress(Exception):
                    await asyncio.wait_for(playwright.stop(), timeout=5)

    async def inspect(self, url: str, cookie_profile: str | None = None, user_id: int | None = None) -> ParseResponse:
        async with self.semaphore:
            resolved_url = await self._canonicalize_tiktok_url(url)
            with tempfile.TemporaryDirectory(prefix=".inspect-", dir=self.settings.download_dir) as temporary:
                work_dir = Path(temporary)
                context = self.cookies.materialize(
                    cookie_profile,
                    work_dir,
                    owner_id=user_id,
                    platform=self._cookie_platform(resolved_url),
                ) if self.cookies else nullcontext(None)
                with context as cookie_file:
                    if self._is_douyin_url(resolved_url):
                        info = self._cached_metadata(resolved_url, cookie_profile, user_id)
                        if info is None:
                            info, _ = await self._capture_douyin_browser_info(resolved_url, cookie_file)
                        output = json.dumps(info, ensure_ascii=False)
                    else:
                        output, _ = await self._capture_metadata(resolved_url, cookie_file)
            try:
                info = json.loads(output)
            except json.JSONDecodeError as exc:
                raise DownloadRejected("解析器返回了无效数据，请更新引擎后重试。") from exc
            if not isinstance(info, dict) or info.get("_type") == "playlist":
                raise DownloadRejected("当前仅支持单个视频链接，不支持播放列表。")
            self._remember_metadata(resolved_url, cookie_profile, info, user_id)
            return self._parse_response(resolved_url, info)

    async def inspect_collection(
        self,
        url: str,
        max_items: int,
        cookie_profile: str | None = None,
        user_id: int | None = None,
    ) -> CollectionInspectResponse:
        async with self.semaphore:
            with tempfile.TemporaryDirectory(prefix=".collection-", dir=self.settings.download_dir) as temporary:
                work_dir = Path(temporary)
                context = self.cookies.materialize(
                    cookie_profile,
                    work_dir,
                    owner_id=user_id,
                    platform=self._cookie_platform(url),
                ) if self.cookies else nullcontext(None)
                with context as cookie_file:
                    if self._is_douyin_url(url):
                        return await self._inspect_douyin_collection(url, max_items, cookie_file)
                    output = await self._capture_collection(url, max_items, cookie_file)
        try:
            info = json.loads(output)
        except json.JSONDecodeError as exc:
            raise DownloadRejected("主页解析器返回了无效数据，请更新引擎后重试。") from exc
        return self._collection_response(url, info, max_items)

    async def _inspect_douyin_collection(
        self,
        source_url: str,
        max_items: int,
        cookie_file: Path | None,
    ) -> CollectionInspectResponse:
        sec_uid = self._douyin_sec_uid(source_url)
        resolved_url = source_url if sec_uid else await asyncio.to_thread(self._resolve_douyin_url, source_url)
        sec_uid = sec_uid or self._douyin_sec_uid(resolved_url)
        if not sec_uid:
            path = urlsplit(resolved_url).path
            if re.search(r"/(?:video|note)/\d+", path):
                raise DownloadRejected("这是抖音单个作品链接，请切换到“单条解析”。")
            raise DownloadRejected("没有从该抖音链接识别出创作者主页，请复制作者主页分享链接后重试。")
        canonical_url = f"https://www.douyin.com/user/{sec_uid}"
        last_error: DownloadRejected | None = None
        for attempt in range(2):
            try:
                async with self.douyin_browser_semaphore:
                    return await asyncio.wait_for(
                        self._scan_douyin_profile_browser(
                            source_url,
                            canonical_url,
                            sec_uid,
                            max_items,
                            cookie_file,
                        ),
                        timeout=self.settings.metadata_timeout_seconds + 15,
                    )
            except TimeoutError:
                last_error = DownloadRejected("抖音主页扫描超时，请稍后重试；若多次出现，请上传有效的抖音 Cookie。")
                logger.warning("douyin profile_scan_timeout source=%s", urlsplit(source_url).netloc)
                raise last_error
            except DownloadRejected as exc:
                last_error = exc
                if "没有返回公开视频" not in str(exc):
                    raise
            if attempt == 0:
                await asyncio.sleep(2)
        assert last_error is not None
        raise last_error

    def _resolve_douyin_url(self, url: str) -> str:
        resolved = ""
        last_error: OSError | None = None
        for method in ("HEAD", "GET"):
            request = Request(
                url,
                method=method,
                headers={"User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"},
            )
            try:
                with urlopen(request, timeout=min(self.settings.request_timeout_seconds, 20)) as response:  # noqa: S310
                    resolved = response.url
                break
            except OSError as exc:
                last_error = exc
        if not resolved:
            raise DownloadRejected("抖音短链接展开失败，请稍后重试。") from last_error
        if not self._is_douyin_url(resolved):
            raise DownloadRejected("抖音短链接跳转到了非抖音站点，已拒绝继续扫描。")
        return resolved

    @staticmethod
    def _douyin_sec_uid(url: str) -> str | None:
        parsed = urlsplit(url)
        match = re.search(r"/(?:share/)?user/(MS4wLjABAAAA[A-Za-z0-9_-]+)", parsed.path)
        if match:
            return match.group(1)
        query = parse_qs(parsed.query)
        for name in ("sec_uid", "sec_user_id"):
            candidate = (query.get(name) or [""])[0]
            if re.fullmatch(r"MS4wLjABAAAA[A-Za-z0-9_-]+", candidate):
                return candidate
        return None

    async def _scan_douyin_profile_browser(
        self,
        source_url: str,
        canonical_url: str,
        sec_uid: str,
        max_items: int,
        cookie_file: Path | None,
    ) -> CollectionInspectResponse:
        chromium = self.settings.chromium_path.strip() or shutil.which("chromium") or shutil.which("chromium-browser")
        if not chromium:
            raise DownloadRejected("服务器缺少抖音主页扫描组件，请更新影链工坊后重试。")
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise DownloadRejected("服务器缺少抖音主页扫描组件，请更新影链工坊后重试。") from exc

        items: dict[str, CollectionItem] = {}
        api_payloads: list[dict[str, Any]] = []
        response_tasks: set[asyncio.Task[None]] = set()
        has_more = False
        total_count: int | None = None
        profile_title = "抖音创作者主页"

        def add_item(item: CollectionItem) -> None:
            if item.url not in items and len(items) < max_items:
                items[item.url] = item
                video_id = self._douyin_video_id(item.url)
                if video_id:
                    self.douyin_video_profiles[video_id] = sec_uid
                    if len(self.douyin_video_profiles) > 1_000:
                        self.douyin_video_profiles.pop(next(iter(self.douyin_video_profiles)))

        def consume_payload(payload: dict[str, Any]) -> None:
            nonlocal has_more, total_count, profile_title
            has_more = has_more or bool(payload.get("has_more"))
            raw_items = payload.get("aweme_list")
            if not isinstance(raw_items, list):
                return
            for aweme in raw_items:
                if len(items) >= max_items or not isinstance(aweme, dict):
                    continue
                info = self._douyin_aweme_info(aweme)
                if info is None:
                    continue
                video_id = str(info["id"])
                video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
                author = aweme.get("author") if isinstance(aweme.get("author"), dict) else {}
                nickname = str(author.get("nickname") or "").strip()
                if nickname:
                    profile_title = nickname
                author_total = author.get("aweme_count")
                if isinstance(author_total, int):
                    total_count = author_total
                cover = video.get("cover") if isinstance(video.get("cover"), dict) else {}
                cover_urls = cover.get("url_list") if isinstance(cover.get("url_list"), list) else []
                thumbnail = next((value for value in cover_urls if isinstance(value, str) and value.startswith("https://")), None)
                duration = video.get("duration")
                video_url = f"https://www.douyin.com/video/{video_id}"
                add_item(CollectionItem(
                    url=video_url,
                    title=str(info["title"]),
                    thumbnail=thumbnail,
                    thumbnail_proxy_url=self._signed_asset(thumbnail, "cover", download=False),
                    duration=float(duration) / 1000 if isinstance(duration, (int, float)) else None,
                    uploader=nickname or None,
                ))
                self._remember_metadata(video_url, None, info)

        async with self._chromium_browser(chromium) as browser:
            context: Any = None
            try:
                context = await browser.new_context(
                    locale="zh-CN",
                    user_agent=self.BROWSER_USER_AGENT,
                    viewport={"width": 1280, "height": 900},
                )
                browser_cookies = self._browser_cookies(cookie_file)
                if browser_cookies:
                    await context.add_cookies(browser_cookies)
                page = await context.new_page()
                page.set_default_timeout(self.settings.metadata_timeout_seconds * 1000)

                async def capture_response(response: Any) -> None:
                    if "/aweme/v1/web/aweme/post/" not in response.url:
                        return
                    try:
                        payload = await asyncio.wait_for(response.json(), timeout=4)
                    except (Exception, asyncio.CancelledError):  # noqa: BLE001
                        return
                    if isinstance(payload, dict):
                        api_payloads.append(payload)

                def schedule_response(response: Any) -> None:
                    task = asyncio.create_task(capture_response(response))
                    response_tasks.add(task)
                    task.add_done_callback(response_tasks.discard)

                page.on("response", schedule_response)
                try:
                    await page.goto(
                        canonical_url,
                        wait_until="domcontentloaded",
                        timeout=min(self.settings.metadata_timeout_seconds * 1000, 25_000),
                    )
                except Exception:  # noqa: BLE001
                    # Douyin can keep a document request open after enough DOM has rendered.
                    # Continue with visible links instead of turning that into a hard failure.
                    pass
                unchanged_rounds = 0
                previous_count = -1
                for _ in range(14):
                    await page.wait_for_timeout(900)
                    for payload in api_payloads:
                        consume_payload(payload)
                    api_payloads.clear()
                    dom_entries = await page.locator('[data-e2e="user-post-list"] a[href*="/video/"]').evaluate_all(
                        """anchors => anchors.map(anchor => ({
                          href: anchor.href,
                          title: (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.innerText || anchor.textContent || '').trim(),
                          thumbnail: anchor.querySelector('img')?.src || null,
                        }))""",
                    )
                    for entry in dom_entries:
                        if len(items) >= max_items or not isinstance(entry, dict):
                            continue
                        match = re.search(r"https?://(?:www\.)?douyin\.com/video/(\d{15,24})", str(entry.get("href") or ""))
                        if not match:
                            continue
                        video_id = match.group(1)
                        thumbnail = entry.get("thumbnail")
                        if not isinstance(thumbnail, str) or not thumbnail.startswith("https://"):
                            thumbnail = None
                        title = str(entry.get("title") or "").strip() or f"抖音视频 {video_id}"
                        add_item(CollectionItem(
                            url=f"https://www.douyin.com/video/{video_id}",
                            title=title[:300],
                            thumbnail=thumbnail,
                            thumbnail_proxy_url=self._signed_asset(thumbnail, "cover", download=False),
                        ))
                    if len(items) >= max_items:
                        break
                    if len(items) == previous_count:
                        unchanged_rounds += 1
                    else:
                        unchanged_rounds = 0
                    # A busy host may need several seconds before the creator
                    # grid or post API appears.  Do not mistake a still-loading
                    # profile for an empty/private one; once any item exists,
                    # three unchanged rounds are enough to finish quickly.
                    if unchanged_rounds >= (3 if items else 8):
                        break
                    previous_count = len(items)
                    await page.mouse.wheel(0, 6000)
                page_title = (await page.title()).removesuffix(" - 抖音").strip()
                if page_title:
                    profile_title = page_title
                if response_tasks:
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(*response_tasks, return_exceptions=True),
                            timeout=5,
                        )
                    except TimeoutError:
                        for task in response_tasks:
                            task.cancel()
                for payload in api_payloads:
                    consume_payload(payload)
            finally:
                if context:
                    with suppress(Exception):
                        await asyncio.wait_for(context.close(), timeout=5)

        if not items:
            cookie_hint = "请在页面右上角“平台登录”中扫码，或导入抖音 cookies.txt。" if not cookie_file else "当前抖音 Cookie 已失效，请重新扫码或导出并覆盖。"
            raise DownloadRejected(f"抖音主页没有返回公开视频；{cookie_hint}")
        return CollectionInspectResponse(
            source_url=source_url,
            title=profile_title,
            extractor="DouyinProfile",
            total_count=total_count,
            items=list(items.values()),
            truncated=len(items) >= max_items or has_more or bool(total_count and total_count > len(items)),
        )

    def _douyin_aweme_info(self, aweme: dict[str, Any]) -> dict[str, Any] | None:
        # Photo posts also expose a synthetic ``video.play_addr`` for page
        # playback.  It is not a downloadable video, so creator batches stay
        # limited to actual video works.
        if aweme.get("images"):
            return None
        video_id = str(aweme.get("aweme_id") or "")
        if not re.fullmatch(r"\d{15,24}", video_id):
            return None
        video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
        formats: list[dict[str, Any]] = []
        seen_urls: set[str] = set()

        def add_format(play_addr: Any, format_id: str, note: str, bitrate: Any = None) -> None:
            if not isinstance(play_addr, dict):
                return
            url_list = play_addr.get("url_list") if isinstance(play_addr.get("url_list"), list) else []
            media_url = next(
                (value for value in url_list if isinstance(value, str) and self._is_douyin_media_url(value)),
                None,
            )
            if not media_url or media_url in seen_urls:
                return
            seen_urls.add(media_url)
            width = self._as_int(play_addr.get("width")) or self._as_int(video.get("width"))
            height = self._as_int(play_addr.get("height")) or self._as_int(video.get("height"))
            formats.append({
                "format_id": format_id,
                "format_note": note or (f"{height}p" if height else "原始画质"),
                "url": media_url,
                "ext": "mp4",
                "protocol": "https",
                "width": width,
                "height": height,
                "tbr": self._as_int(bitrate),
                "filesize": self._as_int(play_addr.get("data_size")),
                "vcodec": "h264",
                "acodec": "aac",
                "http_headers": {"Referer": "https://www.douyin.com/", "User-Agent": self.BROWSER_USER_AGENT},
            })

        raw_bit_rates = video.get("bit_rate") if isinstance(video.get("bit_rate"), list) else []
        sorted_bit_rates = sorted(
            (item for item in raw_bit_rates if isinstance(item, dict)),
            key=lambda item: self._as_int(item.get("bit_rate")) or 0,
            reverse=True,
        )
        for index, item in enumerate(sorted_bit_rates):
            gear_name = str(item.get("gear_name") or item.get("quality_type") or f"quality-{index + 1}")
            add_format(item.get("play_addr"), f"douyin-{gear_name}", gear_name, item.get("bit_rate"))
        add_format(video.get("play_addr"), "douyin-original", "原始画质")
        if not formats:
            return None

        cover = video.get("cover") if isinstance(video.get("cover"), dict) else {}
        cover_urls = cover.get("url_list") if isinstance(cover.get("url_list"), list) else []
        thumbnail = next(
            (value for value in cover_urls if isinstance(value, str) and value.startswith("https://")),
            None,
        )
        author = aweme.get("author") if isinstance(aweme.get("author"), dict) else {}
        duration_ms = video.get("duration")
        return {
            "_type": "video",
            "id": video_id,
            "title": str(aweme.get("desc") or f"抖音视频 {video_id}"),
            "description": str(aweme.get("desc") or ""),
            "extractor": "DouyinProfile",
            "extractor_key": "DouyinProfile",
            "webpage_url": f"https://www.douyin.com/video/{video_id}",
            "original_url": f"https://www.douyin.com/video/{video_id}",
            "duration": float(duration_ms) / 1000 if isinstance(duration_ms, (int, float)) else None,
            "thumbnail": thumbnail,
            "uploader": str(author.get("nickname") or "") or None,
            "formats": formats,
            "subtitles": {},
        }

    @staticmethod
    def _browser_cookies(cookie_file: Path | None) -> list[dict[str, Any]]:
        if not cookie_file:
            return []
        cookies: list[dict[str, Any]] = []
        for raw_line in cookie_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line
            if line.startswith("#HttpOnly_"):
                line = line.removeprefix("#HttpOnly_")
            elif not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 7:
                continue
            domain, _, path, secure, expires, name, value = fields[:7]
            normalized_domain = domain.lstrip(".").lower()
            if normalized_domain != "douyin.com" and not normalized_domain.endswith(".douyin.com"):
                continue
            item: dict[str, Any] = {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path or "/",
                "secure": secure.upper() == "TRUE",
            }
            try:
                expiry = int(expires)
            except ValueError:
                expiry = 0
            if expiry > 0:
                item["expires"] = expiry
            cookies.append(item)
        return cookies

    async def _capture_douyin_browser_info(
        self,
        source_url: str,
        cookie_file: Path | None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        last_error: DownloadRejected | None = None
        for attempt in range(2):
            try:
                async with self.douyin_browser_semaphore:
                    return await asyncio.wait_for(
                        self._capture_douyin_browser_info_once(source_url, cookie_file),
                        timeout=self.settings.metadata_timeout_seconds + 15,
                    )
            except TimeoutError:
                last_error = DownloadRejected("抖音作品页加载超时，请在“平台登录”中更新抖音 Cookie 后重试。")
                logger.warning("douyin video_scan_timeout source=%s", urlsplit(source_url).netloc)
                raise last_error
            except DownloadRejected as exc:
                last_error = exc
                if attempt or "没有返回可下载的视频" not in str(exc):
                    raise
            await asyncio.sleep(2)
        assert last_error is not None
        raise last_error

    async def _capture_douyin_browser_info_once(
        self,
        source_url: str,
        cookie_file: Path | None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        resolved_url = source_url
        video_id = self._douyin_video_id(resolved_url)
        if not video_id:
            resolved_url = await asyncio.to_thread(self._resolve_douyin_url, source_url)
            video_id = self._douyin_video_id(resolved_url)
        if not video_id:
            if self._douyin_sec_uid(resolved_url):
                raise DownloadRejected("这是抖音创作者主页，请切换到“批量下载”。")
            raise DownloadRejected("没有从该抖音链接识别出视频作品。")

        chromium = self.settings.chromium_path.strip() or shutil.which("chromium") or shutil.which("chromium-browser")
        if not chromium:
            raise DownloadRejected("服务器缺少抖音视频解析组件，请更新影链工坊后重试。")
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise DownloadRejected("服务器缺少抖音视频解析组件，请更新影链工坊后重试。") from exc

        media_url = ""
        video_meta: dict[str, Any] = {}
        title = ""
        description = ""
        thumbnail: str | None = None
        browser_cookies: list[dict[str, Any]] = []
        async with self._chromium_browser(chromium) as browser:
            context: Any = None
            try:
                context = await browser.new_context(
                    locale="zh-CN",
                    user_agent=self.BROWSER_USER_AGENT,
                    viewport={"width": 1280, "height": 900},
                )
                supplied_cookies = self._browser_cookies(cookie_file)
                if supplied_cookies:
                    await context.add_cookies(supplied_cookies)
                page = await context.new_page()
                profile_uid = self.douyin_video_profiles.get(video_id)
                warmup_url = (
                    f"https://www.douyin.com/user/{profile_uid}"
                    if profile_uid
                    else "https://www.douyin.com/"
                )
                try:
                    await page.goto(warmup_url, wait_until="commit", timeout=12_000)
                except Exception:  # noqa: BLE001
                    pass
                await page.wait_for_timeout(2_500 if profile_uid else 1_800)
                try:
                    await page.goto(
                        f"https://www.douyin.com/video/{video_id}",
                        wait_until="commit",
                        timeout=12_000,
                    )
                except Exception:  # noqa: BLE001
                    pass

                for _ in range(30):
                    try:
                        if await page.locator("video").count():
                            candidate = await page.locator("video").first.evaluate(
                                """video => ({
                                  currentSrc: video.currentSrc,
                                  poster: video.poster,
                                  width: video.videoWidth,
                                  height: video.videoHeight,
                                  duration: video.duration,
                                })""",
                            )
                            if isinstance(candidate, dict):
                                video_meta = candidate
                                current_src = str(candidate.get("currentSrc") or "")
                                if self._is_douyin_media_url(current_src):
                                    media_url = current_src
                                    break
                    except Exception:  # noqa: BLE001
                        pass
                    await page.wait_for_timeout(500)

                title = (await page.title()).removesuffix(" - 抖音").strip()
                try:
                    description = str(
                        await page.locator('meta[name="description"]').get_attribute("content") or ""
                    ).strip()
                except Exception:  # noqa: BLE001
                    description = ""
                poster = video_meta.get("poster")
                if isinstance(poster, str) and poster.startswith("https://"):
                    thumbnail = poster
                if not thumbnail:
                    try:
                        open_graph_image = await page.locator('meta[property="og:image"]').get_attribute("content")
                    except Exception:  # noqa: BLE001
                        open_graph_image = None
                    if isinstance(open_graph_image, str) and open_graph_image.startswith("https://"):
                        thumbnail = open_graph_image
                browser_cookies = await context.cookies()
            finally:
                if context:
                    with suppress(Exception):
                        await asyncio.wait_for(context.close(), timeout=5)

        if not media_url:
            cookie_hint = "请在页面右上角“平台登录”中扫码，或导入抖音 cookies.txt。" if not cookie_file else "当前抖音 Cookie 已失效，请重新扫码或导出并覆盖。"
            raise DownloadRejected(f"抖音作品页没有返回可下载的视频；{cookie_hint}")

        width = self._as_int(video_meta.get("width"))
        height = self._as_int(video_meta.get("height"))
        raw_duration = video_meta.get("duration")
        duration = float(raw_duration) if isinstance(raw_duration, (int, float)) and math.isfinite(raw_duration) and raw_duration > 0 else None
        headers = {"Referer": "https://www.douyin.com/", "User-Agent": self.BROWSER_USER_AGENT}
        info = {
            "_type": "video",
            "id": video_id,
            "title": title or description[:160] or f"抖音视频 {video_id}",
            "description": description,
            "extractor": "DouyinBrowser",
            "extractor_key": "DouyinBrowser",
            "webpage_url": f"https://www.douyin.com/video/{video_id}",
            "original_url": source_url,
            "duration": duration,
            "thumbnail": thumbnail,
            "formats": [{
                "format_id": "douyin-browser",
                "format_note": "原始画质",
                "url": media_url,
                "ext": "mp4",
                "protocol": "https",
                "width": width,
                "height": height,
                "vcodec": "h264",
                "acodec": "aac",
                "http_headers": headers,
            }],
            "subtitles": {},
        }
        return info, browser_cookies

    async def _download_douyin_browser(self, job: Job) -> None:
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        context = self.cookies.materialize(
            job.cookie_profile,
            job_dir,
            owner_id=job.user_id,
            platform="douyin",
        ) if self.cookies else nullcontext(None)
        with context as cookie_file:
            job.status = JobStatus.parsing
            job.progress = 2
            job.touch()
            self.store.save(job)
            info = self._cached_metadata(job.url, job.cookie_profile, job.user_id) or self._cached_metadata(job.url, None)
            if info is None:
                info, _ = await self._capture_douyin_browser_info(job.url, cookie_file)
            job.update_from_info(info)
            self._enforce_limits(job)
            self.store.save(job)

            formats = info.get("formats")
            available = [item for item in formats if isinstance(item, dict)] if isinstance(formats, list) else []
            selected = next(
                (item for item in available if job.format_id != "best" and item.get("format_id") == job.format_id),
                available[0] if available else {},
            )
            media_url = str(selected.get("url") or "")
            if not self._is_douyin_media_url(media_url):
                raise DownloadRejected("抖音作品没有返回安全的媒体地址。")
            video_id = str(info.get("id") or self._douyin_video_id(job.url) or "video")
            filename_stem = self._safe_filename(str(info.get("title") or "douyin-video"), video_id)
            video_path = job_dir / f"{filename_stem}.mp4"
            headers = selected.get("http_headers") if isinstance(selected.get("http_headers"), dict) else {}
            await self._stream_douyin_media(job, media_url, video_path, headers)

            output_path = video_path
            if job.media_type in {MediaType.audio, MediaType.transcript}:
                output_path = job_dir / f"{filename_stem}.{job.audio_format}"
                await self._extract_audio(job, video_path, output_path)
                video_path.unlink(missing_ok=True)

            output_path = await self._prepare_output(job, info, output_path, output_path, cookie_file)

        self._complete_job(job, output_path)

    async def _download_tiktok_embed(self, job: Job, info: dict[str, Any]) -> None:
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        job.status = JobStatus.parsing
        job.progress = 2
        job.update_from_info(info)
        job.touch()
        self._enforce_limits(job)
        self.store.save(job)

        formats = info.get("formats")
        available = [item for item in formats if isinstance(item, dict)] if isinstance(formats, list) else []
        selected = next(
            (item for item in available if job.format_id != "best" and item.get("format_id") == job.format_id),
            available[0] if available else {},
        )
        media_url = str(selected.get("url") or "")
        if not self._is_tiktok_media_url(media_url):
            raise DownloadRejected("TikTok 作品没有返回安全的媒体地址。")
        video_id = str(info.get("id") or self._tiktok_video_id(job.url) or "video")
        filename_stem = self._safe_filename(str(info.get("title") or "tiktok-video"), video_id)
        video_path = job_dir / f"{filename_stem}.mp4"
        headers = selected.get("http_headers") if isinstance(selected.get("http_headers"), dict) else {}
        await self._stream_tiktok_media(job, media_url, video_path, headers)

        output_path = video_path
        if job.media_type in {MediaType.audio, MediaType.transcript}:
            output_path = job_dir / f"{filename_stem}.{job.audio_format}"
            await self._extract_audio(job, video_path, output_path)
            video_path.unlink(missing_ok=True)
        output_path = await self._prepare_output(job, info, output_path, output_path, None)
        self._complete_job(job, output_path)

    async def _stream_douyin_media(
        self,
        job: Job,
        media_url: str,
        output_path: Path,
        headers: dict[str, Any],
    ) -> None:
        await self._stream_direct_media(
            job,
            media_url,
            output_path,
            headers,
            platform="抖音",
            default_referer="https://www.douyin.com/",
        )

    async def _stream_tiktok_media(
        self,
        job: Job,
        media_url: str,
        output_path: Path,
        headers: dict[str, Any],
    ) -> None:
        await self._stream_direct_media(
            job,
            media_url,
            output_path,
            headers,
            platform="TikTok",
            default_referer="https://www.tiktok.com/",
        )

    async def _stream_direct_media(
        self,
        job: Job,
        media_url: str,
        output_path: Path,
        headers: dict[str, Any],
        *,
        platform: str,
        default_referer: str,
    ) -> None:
        safe_headers = {
            "User-Agent": str(headers.get("User-Agent") or self.BROWSER_USER_AGENT),
            "Referer": str(headers.get("Referer") or default_referer),
            "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.5",
        }
        timeout = httpx.Timeout(connect=self.settings.request_timeout_seconds, read=60, write=60, pool=10)
        job.status = JobStatus.downloading
        job.progress = 5
        job.touch()
        self.store.save(job)
        started = monotonic()
        last_saved = started
        async with httpx.AsyncClient(headers=safe_headers, follow_redirects=True, timeout=timeout) as client:
            async with client.stream("GET", media_url) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    raise DownloadRejected(
                        f"{platform} 媒体地址已失效（HTTP {response.status_code}），请重新解析后重试。"
                    ) from exc
                content_type = response.headers.get("content-type", "").lower()
                if content_type and not (content_type.startswith("video/") or "octet-stream" in content_type):
                    raise DownloadRejected(f"{platform} 媒体服务器返回了非视频内容。")
                total = self._as_int(response.headers.get("content-length"))
                if total and total > self.settings.max_file_size_bytes:
                    raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")
                job.total_bytes = total
                downloaded = 0
                with output_path.open("wb") as output:
                    async for chunk in response.aiter_bytes(256 * 1024):
                        if not chunk:
                            continue
                        downloaded += len(chunk)
                        if downloaded > self.settings.max_file_size_bytes:
                            raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")
                        output.write(chunk)
                        now = monotonic()
                        if now - last_saved >= 0.5:
                            elapsed = max(now - started, 0.001)
                            job.downloaded_bytes = downloaded
                            job.speed = downloaded / elapsed
                            job.progress = min(94, (downloaded / total * 90 + 5) if total else 50)
                            job.touch()
                            self.store.save(job)
                            last_saved = now
                job.downloaded_bytes = downloaded
                job.total_bytes = total or downloaded

    async def _extract_audio(self, job: Job, source: Path, output: Path) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise DownloadRejected("服务器缺少 FFmpeg，无法提取音频。")
        job.status = JobStatus.merging
        job.progress = 96
        job.touch()
        self.store.save(job)
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-vn",
            str(output),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.processes[job.job_id] = process
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise DownloadRejected("音频转换超时。") from exc
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip()
            raise DownloadRejected(message[-800:] or "音频转换失败。")

    async def _prepare_output(
        self,
        job: Job,
        info: dict[str, Any],
        primary_path: Path,
        transcript_source: Path,
        cookie_file: Path | None,
    ) -> Path:
        del cookie_file  # Reserved for extractors whose subtitle tracks require authenticated requests.
        job_dir = self.store.job_dir(job.job_id)
        stem = primary_path.stem[:110]
        artifacts: list[Path] = []
        transcript_path: Path | None = None
        if job.transcript_mode != TranscriptMode.none:
            transcript_path = await self._create_transcript(job, info, transcript_source, job_dir / f"{stem}.{job.transcript_format.value}")

        if job.media_type == MediaType.transcript:
            primary_path.unlink(missing_ok=True)
            if not transcript_path:
                raise DownloadRejected("文案任务没有生成字幕或转写文件。")
            artifacts.append(transcript_path)
        else:
            artifacts.append(primary_path)
            if transcript_path:
                artifacts.append(transcript_path)

        if job.include_description:
            description_path = job_dir / f"{stem}-文案.txt"
            description_path.write_text(self._description_text(info), encoding="utf-8")
            artifacts.append(description_path)

        if job.include_thumbnail and info.get("thumbnail"):
            try:
                cover = await asyncio.to_thread(fetch_remote_asset, str(info["thumbnail"]), "cover")
            except RemoteAssetError:
                pass
            else:
                cover_path = job_dir / f"{stem}-封面.{cover.filename.rsplit('.', 1)[-1]}"
                cover_path.write_bytes(cover.data)
                artifacts.append(cover_path)

        unique_artifacts = list(dict.fromkeys(path for path in artifacts if path.is_file()))
        if len(unique_artifacts) == 1:
            return unique_artifacts[0]
        if not unique_artifacts:
            raise DownloadRejected("任务完成但没有生成可下载文件。")

        job.status = JobStatus.merging
        job.progress = 99
        job.touch()
        self.store.save(job)
        archive = job_dir / f"{stem}-影链工坊.zip"
        with zipfile.ZipFile(archive, "w") as package:
            for artifact in unique_artifacts:
                compress_type = zipfile.ZIP_DEFLATED if artifact.suffix.lower() in {".txt", ".srt", ".vtt", ".json", ".xml"} else zipfile.ZIP_STORED
                package.write(artifact, arcname=artifact.name, compress_type=compress_type, compresslevel=6 if compress_type == zipfile.ZIP_DEFLATED else None)
        for artifact in unique_artifacts:
            artifact.unlink(missing_ok=True)
        return archive

    async def _create_transcript(
        self,
        job: Job,
        info: dict[str, Any],
        source_path: Path,
        output_path: Path,
    ) -> Path:
        mode = job.transcript_mode
        if mode in {TranscriptMode.native, TranscriptMode.auto}:
            try:
                return await self._native_transcript(info, job, output_path)
            except DownloadRejected:
                if mode == TranscriptMode.native:
                    raise
        if mode not in {TranscriptMode.ai, TranscriptMode.auto}:
            raise DownloadRejected("没有可用的文案提取方式。")
        if not self.transcriber.available:
            raise DownloadRejected("服务器未启用 AI 语音转写，请改选平台原生字幕。")
        job.status = JobStatus.transcribing
        job.progress = 97
        job.speed = None
        job.eta = None
        job.touch()
        self.store.save(job)
        try:
            return await self.transcriber.transcribe(
                source_path,
                output_path,
                job.transcript_format,
                job.transcript_language,
            )
        except TranscriptionUnavailable as exc:
            raise DownloadRejected(str(exc)) from exc

    async def _native_transcript(self, info: dict[str, Any], job: Job, output_path: Path) -> Path:
        explicit = info.get("subtitles") if isinstance(info.get("subtitles"), dict) else {}
        automatic = info.get("automatic_captions") if isinstance(info.get("automatic_captions"), dict) else {}
        languages = list(dict.fromkeys([*explicit.keys(), *automatic.keys()]))
        requested = job.subtitle_language or job.transcript_language
        language = requested if requested in languages else self._preferred_language(languages)
        if not language:
            raise DownloadRejected("该视频没有平台原生字幕，可改选 AI 语音转写。")
        tracks = explicit.get(language) or automatic.get(language)
        track = self._preferred_subtitle_track(tracks)
        if not track:
            raise DownloadRejected("平台字幕地址不可用，可改选 AI 语音转写。")
        try:
            asset = await asyncio.to_thread(fetch_remote_asset, str(track["url"]), "subtitle")
        except RemoteAssetError as exc:
            raise DownloadRejected("平台字幕读取失败，可改选 AI 语音转写。") from exc
        extension = str(track.get("ext") or asset.filename.rsplit(".", 1)[-1]).lower()
        cues = self._subtitle_cues(asset.data, extension)
        if not cues:
            raise DownloadRejected("平台字幕内容为空，可改选 AI 语音转写。")
        output_path.write_text(render_transcript(cues, job.transcript_format), encoding="utf-8")
        return output_path

    @staticmethod
    def _description_text(info: dict[str, Any]) -> str:
        title = clean_text(str(info.get("title") or "未命名视频"))
        uploader = clean_text(str(info.get("uploader") or info.get("channel") or ""))
        description = str(info.get("description") or "").strip()
        webpage = str(info.get("webpage_url") or info.get("original_url") or "").strip()
        lines = [f"标题：{title}"]
        if uploader:
            lines.append(f"作者：{uploader}")
        if webpage:
            lines.append(f"来源：{webpage}")
        lines.extend([f"导出时间：{datetime.now().astimezone().isoformat(timespec='seconds')}", "", description or "（作品没有公开描述文案）"])
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _preferred_language(languages: list[Any]) -> str | None:
        valid = [str(item) for item in languages if re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", str(item))]
        for prefix in ("zh-Hans", "zh-CN", "zh", "en", "en-US"):
            match = next((item for item in valid if item.lower() == prefix.lower()), None)
            if match:
                return match
        return valid[0] if valid else None

    @classmethod
    def _subtitle_cues(cls, data: bytes, extension: str) -> list[TranscriptSegment]:
        text = data.decode("utf-8-sig", errors="replace")
        if extension in {"json", "json3"}:
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                return []
            cues: list[TranscriptSegment] = []
            for event in payload.get("events", []) if isinstance(payload, dict) else []:
                if not isinstance(event, dict):
                    continue
                words = "".join(str(item.get("utf8") or "") for item in event.get("segs", []) if isinstance(item, dict))
                caption = clean_text(words)
                if caption:
                    start = float(event.get("tStartMs") or 0) / 1000
                    duration = float(event.get("dDurationMs") or 2000) / 1000
                    cues.append(TranscriptSegment(start, start + max(duration, 0.1), caption))
            return cues
        if extension in {"ttml", "xml"}:
            try:
                root = ElementTree.fromstring(text)
            except ElementTree.ParseError:
                return []
            cues = []
            for node in root.iter():
                if node.tag.rsplit("}", 1)[-1] != "p":
                    continue
                caption = clean_text("".join(node.itertext()))
                start = cls._subtitle_time(node.attrib.get("begin"))
                end = cls._subtitle_time(node.attrib.get("end"))
                if caption and start is not None:
                    cues.append(TranscriptSegment(start, end if end is not None and end > start else start + 2, caption))
            return cues

        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        cues = []
        index = 0
        while index < len(lines):
            if "-->" not in lines[index]:
                index += 1
                continue
            start_raw, end_raw = [part.strip().split(" ", 1)[0] for part in lines[index].split("-->", 1)]
            start = cls._subtitle_time(start_raw)
            end = cls._subtitle_time(end_raw)
            index += 1
            caption_lines: list[str] = []
            while index < len(lines) and lines[index].strip():
                caption_lines.append(lines[index])
                index += 1
            caption = clean_text(re.sub(r"<[^>]+>", "", " ".join(caption_lines)))
            if caption and start is not None:
                cues.append(TranscriptSegment(start, end if end is not None and end > start else start + 2, caption))
            index += 1
        return cues

    @staticmethod
    def _subtitle_time(value: Any) -> float | None:
        if not isinstance(value, str):
            return None
        raw = value.strip().replace(",", ".")
        match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)", raw)
        if match:
            return int(match.group(1) or 0) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s)", raw)
        if match:
            amount = float(match.group(1))
            return amount / 1000 if match.group(2) == "ms" else amount
        return None

    def _complete_job(self, job: Job, file_path: Path) -> None:
        if not file_path.is_file() or file_path.stat().st_size <= 0:
            raise DownloadRejected("下载完成但未找到有效输出文件。")
        if file_path.stat().st_size > self.settings.max_file_size_bytes:
            file_path.unlink(missing_ok=True)
            raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")
        job.file_path = file_path
        job.filename = file_path.name
        job.size_bytes = file_path.stat().st_size
        job.downloaded_bytes = job.size_bytes
        job.total_bytes = job.size_bytes
        job.progress = 100
        job.speed = None
        job.eta = 0
        job.status = JobStatus.completed
        job.touch()
        job.expires_at = job.updated_at + self.settings.job_ttl_seconds
        self.store.save(job)

    @staticmethod
    def _safe_filename(title: str, media_id: str) -> str:
        cleaned = re.sub(r"[^\w\u3400-\u9fff.-]+", "_", title, flags=re.UNICODE).strip("._")
        return f"{(cleaned or 'douyin-video')[:90]}-{media_id}"

    async def run(self, job: Job) -> None:
        task = asyncio.current_task()
        if task:
            self.tasks[job.job_id] = task
        try:
            async with self.semaphore:
                if job.status == JobStatus.cancelled:
                    return
                await self._download(job)
        except asyncio.CancelledError:
            if job.status != JobStatus.cancelled:
                job.status = JobStatus.cancelled
                job.error = "任务已取消。"
                job.touch()
                self.store.save(job)
            shutil.rmtree(self.store.job_dir(job.job_id), ignore_errors=True)
        except Exception as exc:  # noqa: BLE001
            if job.status != JobStatus.cancelled:
                job.status = JobStatus.failed
                job.error = self._safe_error(exc)
                job.touch()
                self.store.save(job)
                shutil.rmtree(self.store.job_dir(job.job_id), ignore_errors=True)
        finally:
            self.processes.pop(job.job_id, None)
            if self.tasks.get(job.job_id) is task:
                self.tasks.pop(job.job_id, None)

    async def cancel(self, job: Job) -> None:
        if job.status not in {JobStatus.queued, JobStatus.parsing, JobStatus.downloading, JobStatus.merging, JobStatus.transcribing}:
            raise DownloadRejected("该任务当前不能取消。")
        job.status = JobStatus.cancelled
        job.error = "任务已取消。"
        job.speed = None
        job.eta = None
        job.touch()
        self.store.save(job)
        process = self.processes.get(job.job_id)
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
        task = self.tasks.get(job.job_id)
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()
            await task
        shutil.rmtree(self.store.job_dir(job.job_id), ignore_errors=True)

    async def _download(self, job: Job) -> None:
        if self._is_douyin_url(job.url):
            await self._download_douyin_browser(job)
            return
        cached_info = self._cached_metadata(job.url, job.cookie_profile, job.user_id)
        resolved_url = await self._canonicalize_tiktok_url(job.url)
        if resolved_url != job.url:
            job.url = resolved_url
            job.touch()
            self.store.save(job)
        if self._is_tiktok_url(job.url):
            try:
                embed_info = await asyncio.to_thread(self._fetch_tiktok_embed_info, job.url)
            except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
                pass
            else:
                self._remember_metadata(job.url, job.cookie_profile, embed_info, job.user_id)
                await self._download_tiktok_embed(job, embed_info)
                return
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        context = self.cookies.materialize(
            job.cookie_profile,
            job_dir,
            owner_id=job.user_id,
            platform=self._cookie_platform(job.url),
        ) if self.cookies else nullcontext(None)
        with context as cookie_file:
            job.status = JobStatus.parsing
            job.progress = 2
            job.touch()
            self.store.save(job)

            info = cached_info or self._cached_metadata(job.url, job.cookie_profile, job.user_id)
            impersonate_target = None
            if info is None:
                output, impersonate_target = await self._capture_metadata(job.url, cookie_file, job.job_id)
                info = json.loads(output)
            if not isinstance(info, dict) or info.get("_type") == "playlist":
                raise DownloadRejected("当前仅支持单个视频链接，不支持播放列表。")
            job.update_from_info(info)
            self._enforce_limits(job)
            self.store.save(job)

            info_path = job_dir / ".yt-info.json"
            info_path.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
            command = self._download_command(job, cookie_file, impersonate_target, info_path)
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            self.processes[job.job_id] = process
            errors: list[str] = []
            assert process.stdout is not None
            while line_bytes := await process.stdout.readline():
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if self._consume_progress(job, line):
                    self.store.save(job)
                elif line.startswith("[Merger]") or line.startswith("[VideoConvertor]") or line.startswith("[ExtractAudio]"):
                    job.status = JobStatus.merging
                    job.progress = max(job.progress, 96)
                    job.touch()
                    self.store.save(job)
                elif line and ("ERROR:" in line or "WARNING:" in line):
                    errors.append(line)
                    errors = errors[-8:]
            returncode = await process.wait()
            if job.status == JobStatus.cancelled:
                return
            if returncode != 0:
                raise DownloadRejected("\n".join(errors) or f"yt-dlp 退出码 {returncode}")

        file_path = self._find_output_file(job_dir, job.media_type)
        if not file_path:
            raise DownloadRejected("下载完成但未找到输出文件。")
        if file_path.stat().st_size > self.settings.max_file_size_bytes:
            file_path.unlink(missing_ok=True)
            raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")

        output_path = await self._prepare_output(job, info, file_path, file_path, None)
        self._complete_job(job, output_path)

    async def _run_capture(self, command: list[str], timeout: int, job_id: str | None = None) -> str:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if job_id:
            self.processes[job_id] = process
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise DownloadRejected("解析超时，请检查网络、Cookie 或稍后重试。") from exc
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip()
            raise DownloadRejected(message[-1600:] or f"yt-dlp 退出码 {process.returncode}")
        return stdout.decode("utf-8", errors="replace").strip()

    async def _capture_metadata(
        self,
        url: str,
        cookie_file: Path | None,
        job_id: str | None = None,
    ) -> tuple[str, str | None]:
        is_tiktok = self._is_tiktok_url(url)
        if is_tiktok:
            try:
                info = await asyncio.to_thread(self._fetch_tiktok_embed_info, url)
            except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
                pass
            else:
                return json.dumps(info, ensure_ascii=False), None

        targets = self.TIKTOK_IMPERSONATE_TARGETS if is_tiktok else (None,)
        for index, target in enumerate(targets):
            command = [
                *self._base_command(cookie_file, url, target),
                "--dump-single-json",
                "--skip-download",
                url,
            ]
            try:
                output = await self._run_capture(command, self.settings.metadata_timeout_seconds, job_id)
            except DownloadRejected as exc:
                can_retry = index < len(targets) - 1 and self._is_tiktok_rehydration_error(str(exc))
                if not can_retry:
                    raise
            else:
                return output, target
        raise DownloadRejected("TikTok 未返回视频数据，请稍后重试。")

    async def _capture_collection(self, url: str, max_items: int, cookie_file: Path | None) -> str:
        is_tiktok = self._is_tiktok_url(url)
        targets = self.TIKTOK_IMPERSONATE_TARGETS if is_tiktok else (None,)
        for index, target in enumerate(targets):
            command = [
                *self._base_command(cookie_file, url, target, allow_playlist=True),
                "--flat-playlist",
                "--playlist-end",
                str(max_items + 1),
                "--dump-single-json",
                "--skip-download",
                url,
            ]
            try:
                output = await self._run_capture(command, self.settings.metadata_timeout_seconds)
            except DownloadRejected:
                can_retry = index < len(targets) - 1 and is_tiktok
                if not can_retry:
                    raise
            else:
                return output
        raise DownloadRejected("TikTok 主页未返回视频列表，请稍后重试或上传 Cookie。")

    async def _canonicalize_tiktok_url(self, url: str) -> str:
        if not self._is_tiktok_url(url):
            return url
        try:
            metadata = await asyncio.to_thread(self._fetch_tiktok_oembed, url)
        except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
            return url
        return self._tiktok_url_from_oembed(metadata) or url

    def _fetch_tiktok_oembed(self, url: str) -> dict[str, Any]:
        endpoint = f"https://www.tiktok.com/oembed?{urlencode({'url': url})}"
        request = Request(
            endpoint,
            headers={
                "Accept": "application/json",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
                ),
            },
        )
        with urlopen(request, timeout=min(self.settings.request_timeout_seconds, 20)) as response:  # noqa: S310
            payload = response.read(self.TIKTOK_OEMBED_MAX_BYTES + 1)
        if len(payload) > self.TIKTOK_OEMBED_MAX_BYTES:
            raise ValueError("TikTok oEmbed response is too large")
        metadata = json.loads(payload)
        if not isinstance(metadata, dict):
            raise ValueError("TikTok oEmbed response is invalid")
        return metadata

    def _fetch_tiktok_embed_info(self, url: str) -> dict[str, Any]:
        video_id = self._tiktok_video_id(url)
        if not video_id:
            raise ValueError("TikTok URL does not contain a video ID")
        embed_url = f"https://www.tiktok.com/embed/v2/{video_id}"
        request = Request(
            embed_url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
                ),
            },
        )
        with urlopen(request, timeout=min(self.settings.request_timeout_seconds, 20)) as response:  # noqa: S310
            payload = response.read(self.TIKTOK_EMBED_MAX_BYTES + 1)
        if len(payload) > self.TIKTOK_EMBED_MAX_BYTES:
            raise ValueError("TikTok embed response is too large")
        return self._tiktok_info_from_embed_html(payload.decode("utf-8"), url, video_id)

    @classmethod
    def _tiktok_info_from_embed_html(cls, html: str, webpage_url: str, video_id: str) -> dict[str, Any]:
        match = re.search(
            r'<script[^>]+\bid=["\']__FRONTITY_CONNECT_STATE__["\'][^>]*>(.*?)</script>',
            html,
            flags=re.DOTALL,
        )
        if not match:
            raise ValueError("TikTok embed state is missing")
        state = json.loads(match.group(1))
        if not isinstance(state, dict) or not isinstance(state.get("source"), dict):
            raise ValueError("TikTok embed state is invalid")
        entries = state["source"].get("data")
        if not isinstance(entries, dict):
            raise ValueError("TikTok embed source data is invalid")
        entry = entries.get(f"/embed/v2/{video_id}")
        if not isinstance(entry, dict):
            entry = next(
                (
                    value for value in entries.values()
                    if isinstance(value, dict) and isinstance(value.get("videoData"), dict)
                ),
                None,
            )
        video_data = entry.get("videoData") if isinstance(entry, dict) else None
        item = video_data.get("itemInfos") if isinstance(video_data, dict) else None
        if not isinstance(item, dict) or str(item.get("id") or "") != video_id:
            raise ValueError("TikTok embed video data is invalid")

        video = item.get("video")
        video_meta = video.get("videoMeta") if isinstance(video, dict) else None
        urls = video.get("urls") if isinstance(video, dict) else None
        if not isinstance(video_meta, dict) or not isinstance(urls, list):
            raise ValueError("TikTok embed video source is missing")

        embed_url = f"https://www.tiktok.com/embed/v2/{video_id}"
        headers = {
            "Referer": embed_url,
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
            ),
        }
        media_url = next(
            (candidate for candidate in urls[:5] if isinstance(candidate, str) and cls._is_tiktok_media_url(candidate)),
            None,
        )
        if not media_url:
            raise ValueError("TikTok embed media URL is invalid")
        formats = [{
            "format_id": "embed-0",
            "format_note": "原始画质",
            "url": media_url,
            "ext": "mp4",
            "protocol": "https",
            "width": cls._as_int(video_meta.get("width")),
            "height": cls._as_int(video_meta.get("height")),
            "vcodec": "h264",
            "acodec": "aac",
            "http_headers": headers,
        }]

        author = video_data.get("authorInfos") if isinstance(video_data, dict) else {}
        covers = item.get("coversOrigin") or item.get("covers") or []
        thumbnail = covers[0] if isinstance(covers, list) and covers else None
        return {
            "_type": "video",
            "id": video_id,
            "title": str(item.get("text") or f"TikTok {video_id}"),
            "description": str(item.get("text") or ""),
            "extractor": "TikTokEmbed",
            "extractor_key": "TikTokEmbed",
            "webpage_url": webpage_url,
            "original_url": webpage_url,
            "duration": cls._as_int(video_meta.get("duration")),
            "timestamp": cls._as_int(item.get("createTime")),
            "thumbnail": thumbnail,
            "uploader": author.get("uniqueId") if isinstance(author, dict) else None,
            "uploader_id": author.get("userId") if isinstance(author, dict) else None,
            "formats": formats,
            "subtitles": {},
        }

    @staticmethod
    def _tiktok_url_from_oembed(metadata: dict[str, Any]) -> str | None:
        video_id = str(metadata.get("embed_product_id") or "")
        if not re.fullmatch(r"\d{10,24}", video_id):
            return None

        username = str(metadata.get("author_unique_id") or "").removeprefix("@")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
            author_url = str(metadata.get("author_url") or "")
            try:
                author = urlsplit(author_url)
            except ValueError:
                return None
            hostname = (author.hostname or "").lower().rstrip(".")
            if hostname != "tiktok.com" and not hostname.endswith(".tiktok.com"):
                return None
            match = re.fullmatch(r"/@([A-Za-z0-9._-]{1,64})/?", author.path)
            if not match:
                return None
            username = match.group(1)
        return f"https://www.tiktok.com/@{username}/video/{video_id}"

    def _base_command(
        self,
        cookie_file: Path | None,
        url: str | None = None,
        impersonate_target: str | None = None,
        *,
        allow_playlist: bool = False,
    ) -> list[str]:
        command = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-warnings",
            "--socket-timeout",
            str(self.settings.request_timeout_seconds),
        ]
        if not allow_playlist:
            command.append("--no-playlist")
        if shutil.which("deno"):
            command.extend(["--js-runtimes", "deno"])
        if url and self._is_tiktok_url(url):
            command.extend(["--extractor-args", f"tiktok:app_info={self._new_tiktok_iid()}"])
            if impersonate_target:
                command.extend(["--impersonate", impersonate_target])
        if cookie_file:
            command.extend(["--cookies", str(cookie_file)])
        return command

    def _download_command(
        self,
        job: Job,
        cookie_file: Path | None,
        impersonate_target: str | None = None,
        info_path: Path | None = None,
    ) -> list[str]:
        outtmpl = str(self.store.job_dir(job.job_id) / "%(title).120B-%(id)s.%(ext)s")
        command = [
            *self._base_command(cookie_file, job.url, impersonate_target),
            "--newline",
            "--progress",
            "--progress-template",
            "download:YL_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--restrict-filenames",
            "--no-overwrites",
            "--continue",
            "--max-filesize",
            f"{self.settings.max_file_size_mb}M",
            "--output",
            outtmpl,
        ]
        if job.media_type in {MediaType.audio, MediaType.transcript}:
            command.extend(["--format", "bestaudio/best", "--extract-audio", "--audio-format", job.audio_format])
        else:
            if job.format_id == "best":
                selector = "bv*+ba/b"
            elif job.format_has_audio:
                selector = job.format_id
            else:
                selector = f"{job.format_id}+bestaudio/{job.format_id}"
            command.extend(["--format", selector, "--merge-output-format", "mp4"])
            if job.subtitle_language:
                command.extend([
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    job.subtitle_language,
                    "--embed-subs",
                ])
        if info_path:
            command.extend(["--load-info-json", str(info_path)])
        else:
            command.append(job.url)
        return command

    def _consume_progress(self, job: Job, line: str) -> bool:
        if not line.startswith(self.PROGRESS_PREFIX):
            return False
        parts = line.removeprefix(self.PROGRESS_PREFIX).split("|")
        while len(parts) < 5:
            parts.append("")
        downloaded = self._number(parts[0]) or 0
        total = self._number(parts[1]) or self._number(parts[2])
        speed = self._number(parts[3])
        eta = self._number(parts[4])
        job.status = JobStatus.downloading
        job.downloaded_bytes = int(downloaded)
        job.total_bytes = int(total) if total else job.total_bytes
        job.speed = speed
        job.eta = int(eta) if eta is not None else None
        job.progress = min(95, 5 + (downloaded / total) * 90) if total else max(job.progress, 8)
        job.touch()
        return True

    @staticmethod
    def _is_tiktok_url(url: str) -> bool:
        try:
            hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
        except ValueError:
            return False
        return hostname == "tiktok.com" or hostname.endswith(".tiktok.com")

    @staticmethod
    def _cookie_platform(url: str) -> str | None:
        try:
            hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
        except ValueError:
            return None
        mappings = {
            "douyin": ("douyin.com",),
            "tiktok": ("tiktok.com",),
            "youtube": ("youtube.com", "youtu.be"),
            "bilibili": ("bilibili.com",),
            "instagram": ("instagram.com",),
            "facebook": ("facebook.com", "fb.watch"),
            "twitter": ("twitter.com", "x.com"),
        }
        for platform, domains in mappings.items():
            if any(hostname == domain or hostname.endswith(f".{domain}") for domain in domains):
                return platform
        return None

    @staticmethod
    def _is_douyin_url(url: str) -> bool:
        try:
            hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
        except ValueError:
            return False
        return (
            hostname == "douyin.com"
            or hostname.endswith(".douyin.com")
            or hostname == "iesdouyin.com"
            or hostname.endswith(".iesdouyin.com")
        )

    @staticmethod
    def _douyin_video_id(url: str) -> str | None:
        try:
            path = urlsplit(url).path
        except ValueError:
            return None
        match = re.search(r"/video/(\d{15,24})(?:/|$)", path)
        return match.group(1) if match else None

    @staticmethod
    def _is_douyin_media_url(url: str) -> bool:
        try:
            parsed = urlsplit(url)
        except ValueError:
            return False
        hostname = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or parsed.path.endswith("/uuu_265.mp4"):
            return False
        allowed_suffixes = (
            ".douyinvod.com",
            ".douyinstatic.com",
            ".zjcdn.com",
            ".bytevcloud.com",
            ".ibytedtos.com",
            ".pstatp.com",
        )
        return any(hostname.endswith(suffix) for suffix in allowed_suffixes)

    @staticmethod
    def _tiktok_video_id(url: str) -> str | None:
        try:
            path = urlsplit(url).path
        except ValueError:
            return None
        match = re.search(r"/(?:video|v1|v2)/(\d{10,24})(?:/|$)", path)
        return match.group(1) if match else None

    @staticmethod
    def _is_tiktok_media_url(url: str) -> bool:
        try:
            parsed = urlsplit(url)
        except ValueError:
            return False
        hostname = (parsed.hostname or "").lower().rstrip(".")
        allowed_suffixes = (
            ".tiktok.com",
            ".tiktokcdn.com",
            ".tiktokcdn-us.com",
            ".tiktokv.com",
            ".byteoversea.com",
            ".ibytedtos.com",
        )
        return parsed.scheme == "https" and any(hostname.endswith(suffix) for suffix in allowed_suffixes)

    @staticmethod
    def _is_tiktok_rehydration_error(message: str) -> bool:
        return "universal data for rehydration" in message.lower()

    @staticmethod
    def _new_tiktok_iid() -> str:
        return str(7_250_000_000_000_000_000 + secrets.randbelow(75_099_899_999_994_578))

    def _remember_metadata(
        self,
        url: str,
        cookie_profile: str | None,
        info: dict[str, Any],
        user_id: int | None = None,
    ) -> None:
        now = monotonic()
        stale = [
            key for key, (created_at, _) in self.metadata_cache.items()
            if now - created_at > self.METADATA_CACHE_TTL_SECONDS
        ]
        for key in stale:
            self.metadata_cache.pop(key, None)
        self.metadata_cache[(url, cookie_profile, user_id)] = (now, info)

    def _cached_metadata(
        self,
        url: str,
        cookie_profile: str | None,
        user_id: int | None = None,
    ) -> dict[str, Any] | None:
        key = (url, cookie_profile, user_id)
        cached = self.metadata_cache.get(key)
        if not cached:
            return None
        created_at, info = cached
        if monotonic() - created_at > self.METADATA_CACHE_TTL_SECONDS:
            self.metadata_cache.pop(key, None)
            return None
        return info

    @staticmethod
    def _number(value: str) -> float | None:
        try:
            number = float(value)
            return number if number >= 0 else None
        except (TypeError, ValueError):
            return None

    def _enforce_limits(self, job: Job) -> None:
        if job.duration and job.duration > self.settings.max_duration_seconds:
            minutes = self.settings.max_duration_seconds // 60
            raise DownloadRejected(f"视频时长超过 {minutes} 分钟上限。")
        if job.size_bytes and job.size_bytes > self.settings.max_file_size_bytes:
            raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")

    @staticmethod
    def _find_output_file(job_dir: Path, media_type: MediaType) -> Path | None:
        audio_exts = {".mp3", ".m4a", ".opus", ".wav", ".flac", ".aac", ".ogg"}
        ignored = {".part", ".ytdl", ".srt", ".vtt", ".ass", ".lrc", ".json", ".jpg", ".jpeg", ".png", ".webp", ".txt"}
        files = [path for path in job_dir.iterdir() if path.is_file() and not path.name.startswith(".") and path.suffix.lower() not in ignored]
        if media_type in {MediaType.audio, MediaType.transcript}:
            audio = [path for path in files if path.suffix.lower() in audio_exts]
            files = audio or files
        if not files:
            return None
        return max(files, key=lambda path: path.stat().st_mtime)

    def _parse_response(self, url: str, info: dict[str, Any]) -> ParseResponse:
        seen: set[str] = set()
        candidates: list[FormatOption] = []
        for item in info.get("formats") or []:
            format_id = str(item.get("format_id") or "")
            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", format_id) or format_id in seen:
                continue
            vcodec = item.get("vcodec")
            acodec = item.get("acodec")
            has_video = bool(vcodec and vcodec != "none")
            has_audio = bool(acodec and acodec != "none")
            if not has_video:
                continue
            width = self._as_int(item.get("width"))
            height = self._as_int(item.get("height"))
            fps = self._number(str(item.get("fps") or ""))
            ext = item.get("ext")
            resolution = item.get("resolution") or (f"{width}×{height}" if width and height else f"{height}p" if height else None)
            details = [resolution or "视频", str(ext or "未知格式").upper()]
            if fps:
                details.append(f"{int(fps)}fps")
            format_note = str(item.get("format_note") or "").strip()
            if format_note and format_note.lower() not in {part.lower() for part in details}:
                details.append(format_note)
            details.append("含音频" if has_audio else "自动合并音频")
            candidates.append(
                FormatOption(
                    format_id=format_id,
                    label=" · ".join(details),
                    ext=ext,
                    resolution=resolution,
                    width=width,
                    height=height,
                    fps=fps,
                    filesize=self._as_int(item.get("filesize") or item.get("filesize_approx")),
                    vcodec=vcodec,
                    acodec=acodec,
                    has_video=True,
                    has_audio=has_audio,
                )
            )
            seen.add(format_id)
        candidates.sort(key=lambda item: (item.height or 0, item.fps or 0, item.filesize or 0), reverse=True)
        candidates = candidates[:40]
        formats = candidates if len(candidates) == 1 else [
            FormatOption(format_id="best", label="自动选择最佳画质", has_video=True, has_audio=True),
            *candidates,
        ]
        if not formats:
            formats = [FormatOption(format_id="best", label="自动选择最佳画质", has_video=True, has_audio=True)]

        subtitles: list[SubtitleOption] = []
        explicit = info.get("subtitles") or {}
        automatic = info.get("automatic_captions") or {}
        for language in self._ordered_subtitle_languages(set(explicit) | set(automatic)):
            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,32}", str(language)):
                continue
            is_automatic = language not in explicit
            tracks = automatic.get(language) if is_automatic else explicit.get(language)
            track = self._preferred_subtitle_track(tracks)
            subtitles.append(
                SubtitleOption(
                    language=str(language),
                    label=str(language),
                    automatic=is_automatic,
                    ext=str(track.get("ext")) if track and track.get("ext") else None,
                    download_url=self._signed_asset(track.get("url"), "subtitle", download=True) if track else None,
                )
            )
        thumbnail = info.get("thumbnail")
        return ParseResponse(
            url=url,
            title=str(info.get("title") or "未命名视频"),
            extractor=info.get("extractor_key") or info.get("extractor"),
            platform=info.get("extractor_key") or info.get("extractor"),
            thumbnail=thumbnail,
            thumbnail_proxy_url=self._signed_asset(thumbnail, "cover", download=False),
            thumbnail_download_url=self._signed_asset(thumbnail, "cover", download=True),
            duration=info.get("duration"),
            uploader=info.get("uploader") or info.get("channel"),
            description=(str(info.get("description"))[:500] if info.get("description") else None),
            formats=formats,
            subtitles=subtitles,
            subtitle_note=None if subtitles else "该视频未提供可下载字幕",
            ai_transcription_available=self.transcriber.available,
        )

    def _collection_response(
        self,
        source_url: str,
        info: Any,
        max_items: int,
    ) -> CollectionInspectResponse:
        if not isinstance(info, dict):
            raise DownloadRejected("该链接没有返回可识别的视频主页。")
        raw_entries = info.get("entries")
        if not isinstance(raw_entries, list):
            raise DownloadRejected("这不是可批量扫描的主页、频道或播放列表链接。")

        items: list[CollectionItem] = []
        seen: set[str] = set()
        for entry in raw_entries:
            if len(items) >= max_items or not isinstance(entry, dict):
                continue
            item_url = self._collection_entry_url(entry, info)
            if not item_url or item_url in seen:
                continue
            seen.add(item_url)
            thumbnail = self._collection_thumbnail(entry)
            items.append(
                CollectionItem(
                    url=item_url,
                    title=str(entry.get("title") or entry.get("id") or "未命名视频"),
                    thumbnail=thumbnail,
                    thumbnail_proxy_url=self._signed_asset(thumbnail, "cover", download=False),
                    duration=self._number(str(entry.get("duration") or "")),
                    uploader=entry.get("uploader") or entry.get("channel"),
                )
            )
        if not items:
            raise DownloadRejected("没有从这个主页中找到可下载的视频；私密主页可能需要 Cookie。")

        total_count = self._as_int(info.get("playlist_count") or info.get("n_entries"))
        discovered_more = len(raw_entries) > len(items)
        truncated = discovered_more or bool(total_count and total_count > len(items))
        return CollectionInspectResponse(
            source_url=source_url,
            title=str(info.get("title") or info.get("playlist_title") or info.get("uploader") or "视频主页"),
            extractor=info.get("extractor_key") or info.get("extractor"),
            total_count=total_count,
            items=items,
            truncated=truncated,
        )

    @staticmethod
    def _collection_entry_url(entry: dict[str, Any], collection: dict[str, Any]) -> str | None:
        for key in ("webpage_url", "original_url", "url"):
            candidate = entry.get(key)
            if isinstance(candidate, str) and candidate.lower().startswith(("https://", "http://")):
                return candidate

        video_id = str(entry.get("id") or "").strip()
        extractor = str(entry.get("extractor_key") or collection.get("extractor_key") or "").lower()
        if not video_id:
            return None
        if "youtube" in extractor and re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id):
            return f"https://www.youtube.com/watch?v={video_id}"
        if "bilibili" in extractor and re.fullmatch(r"(?:BV[A-Za-z0-9]+|av\d+)", video_id, flags=re.IGNORECASE):
            return f"https://www.bilibili.com/video/{video_id}"
        if "tiktok" in extractor and re.fullmatch(r"\d{10,24}", video_id):
            uploader = str(entry.get("uploader_id") or entry.get("uploader") or "_").removeprefix("@")
            if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", uploader):
                return f"https://www.tiktok.com/@{uploader}/video/{video_id}"
        return None

    @staticmethod
    def _collection_thumbnail(entry: dict[str, Any]) -> str | None:
        thumbnail = entry.get("thumbnail")
        if isinstance(thumbnail, str):
            return thumbnail
        thumbnails = entry.get("thumbnails")
        if not isinstance(thumbnails, list):
            return None
        for item in reversed(thumbnails):
            if isinstance(item, dict) and isinstance(item.get("url"), str):
                return item["url"]
        return None

    def _signed_asset(self, source_url: Any, kind: str, *, download: bool) -> str | None:
        if not isinstance(source_url, str):
            return None
        try:
            return signed_asset_url(source_url, kind, self.settings.auth_secret, download=download)
        except RemoteAssetError:
            return None

    @staticmethod
    def _preferred_subtitle_track(tracks: Any) -> dict[str, Any] | None:
        if not isinstance(tracks, list):
            return None
        supported = {"vtt": 0, "srt": 1, "ass": 2, "ttml": 3, "json3": 4}
        candidates = [
            item for item in tracks
            if isinstance(item, dict)
            and isinstance(item.get("url"), str)
            and str(item.get("url")).lower().startswith("https://")
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda item: supported.get(str(item.get("ext") or "").lower(), 99))

    @staticmethod
    def _ordered_subtitle_languages(languages: set[Any]) -> list[str]:
        valid = sorted(
            (str(item) for item in languages if re.fullmatch(r"[a-zA-Z0-9_.-]{1,32}", str(item))),
            key=str.lower,
        )
        preferred_prefixes = ("zh-hans", "zh-cn", "zh", "zh-hant", "zh-tw", "en", "en-us", "en-gb", "id", "ja", "ko")
        preferred: list[str] = []
        for target in preferred_prefixes:
            preferred.extend(item for item in valid if item.lower() == target and item not in preferred)
        return [*preferred, *(item for item in valid if item not in preferred)][:120]

    @staticmethod
    def _as_int(value: Any) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def engine_version() -> str:
        try:
            return version("yt-dlp")
        except PackageNotFoundError:
            return "unknown"

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        message = str(exc).strip()
        lower = message.lower()
        if "unsupported url" in lower:
            return "yt-dlp 暂不支持该链接或平台。"
        if "sign in" in lower or "cookies" in lower or "login" in lower:
            return "平台要求登录验证，请在页面右上角“平台登录”中扫码或更新对应平台 Cookie。"
        if "larger than max-filesize" in lower:
            return "文件超过站点下载大小上限。"
        if "requested format is not available" in lower:
            return "所选清晰度已经失效，请重新解析并选择格式。"
        if "universal data for rehydration" in lower:
            return "TikTok 未返回视频数据，请确认链接可公开播放，或在“平台登录”中更新 TikTok Cookie。"
        cleaned = re.sub(r"/[^\s]*/\.cookies\.txt", "[cookie]", message)
        return cleaned[-800:] or "任务失败，请稍后重试。"
