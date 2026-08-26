from __future__ import annotations

import asyncio
import json
import re
import secrets
import shutil
import sys
import tempfile
from contextlib import nullcontext
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from .config import Settings
from .cookies import CookieStore
from .models import FormatOption, Job, JobStatus, MediaType, ParseResponse, SubtitleOption
from .store import JobStore


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

    def __init__(self, settings: Settings, store: JobStore, cookies: CookieStore | None = None) -> None:
        self.settings = settings
        self.store = store
        self.cookies = cookies
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_downloads)
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.metadata_cache: dict[tuple[str, str | None], tuple[float, dict[str, Any]]] = {}

    async def inspect(self, url: str, cookie_profile: str | None = None) -> ParseResponse:
        async with self.semaphore:
            resolved_url = await self._canonicalize_tiktok_url(url)
            with tempfile.TemporaryDirectory(prefix=".inspect-", dir=self.settings.download_dir) as temporary:
                work_dir = Path(temporary)
                context = self.cookies.materialize(cookie_profile, work_dir) if self.cookies else nullcontext(None)
                with context as cookie_file:
                    output, _ = await self._capture_metadata(resolved_url, cookie_file)
            try:
                info = json.loads(output)
            except json.JSONDecodeError as exc:
                raise DownloadRejected("解析器返回了无效数据，请更新引擎后重试。") from exc
            if not isinstance(info, dict) or info.get("_type") == "playlist":
                raise DownloadRejected("当前仅支持单个视频链接，不支持播放列表。")
            self._remember_metadata(resolved_url, cookie_profile, info)
            return self._parse_response(resolved_url, info)

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
        if job.status not in {JobStatus.queued, JobStatus.parsing, JobStatus.downloading, JobStatus.merging}:
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
        cached_info = self._cached_metadata(job.url, job.cookie_profile)
        resolved_url = await self._canonicalize_tiktok_url(job.url)
        if resolved_url != job.url:
            job.url = resolved_url
            job.touch()
            self.store.save(job)
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        context = self.cookies.materialize(job.cookie_profile, job_dir) if self.cookies else nullcontext(None)
        with context as cookie_file:
            job.status = JobStatus.parsing
            job.progress = 2
            job.touch()
            self.store.save(job)

            info = cached_info or self._cached_metadata(job.url, job.cookie_profile)
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

        job.file_path = file_path
        job.filename = file_path.name
        job.size_bytes = file_path.stat().st_size
        job.downloaded_bytes = job.size_bytes
        job.total_bytes = job.size_bytes
        job.progress = 100
        job.speed = None
        job.eta = 0
        job.status = JobStatus.completed
        job.expires_at = job.updated_at + self.settings.job_ttl_seconds
        job.touch()
        job.expires_at = job.updated_at + self.settings.job_ttl_seconds
        self.store.save(job)

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
        formats = []
        for index, media_url in enumerate(urls[:5]):
            if not isinstance(media_url, str) or not cls._is_tiktok_media_url(media_url):
                continue
            formats.append({
                "format_id": f"embed-{index}",
                "format_note": "TikTok 官方嵌入源",
                "url": media_url,
                "ext": "mp4",
                "protocol": "https",
                "width": cls._as_int(video_meta.get("width")),
                "height": cls._as_int(video_meta.get("height")),
                "vcodec": "h264",
                "acodec": "aac",
                "http_headers": headers,
            })
        if not formats:
            raise ValueError("TikTok embed media URL is invalid")

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
    ) -> list[str]:
        command = [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--no-playlist",
            "--no-warnings",
            "--socket-timeout",
            str(self.settings.request_timeout_seconds),
        ]
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
        if job.media_type == MediaType.audio:
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

    def _remember_metadata(self, url: str, cookie_profile: str | None, info: dict[str, Any]) -> None:
        now = monotonic()
        stale = [
            key for key, (created_at, _) in self.metadata_cache.items()
            if now - created_at > self.METADATA_CACHE_TTL_SECONDS
        ]
        for key in stale:
            self.metadata_cache.pop(key, None)
        self.metadata_cache[(url, cookie_profile)] = (now, info)

    def _cached_metadata(self, url: str, cookie_profile: str | None) -> dict[str, Any] | None:
        cached = self.metadata_cache.get((url, cookie_profile))
        if not cached:
            return None
        created_at, info = cached
        if monotonic() - created_at > self.METADATA_CACHE_TTL_SECONDS:
            self.metadata_cache.pop((url, cookie_profile), None)
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
        if media_type == MediaType.audio:
            audio = [path for path in files if path.suffix.lower() in audio_exts]
            files = audio or files
        if not files:
            return None
        return max(files, key=lambda path: path.stat().st_mtime)

    def _parse_response(self, url: str, info: dict[str, Any]) -> ParseResponse:
        formats: list[FormatOption] = [
            FormatOption(format_id="best", label="自动选择最佳画质", has_video=True, has_audio=True)
        ]
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
            height = self._as_int(item.get("height"))
            fps = self._number(str(item.get("fps") or ""))
            ext = item.get("ext")
            resolution = item.get("resolution") or (f"{height}p" if height else None)
            details = [resolution or "视频", str(ext or "未知格式")]
            if fps:
                details.append(f"{int(fps)}fps")
            details.append("含音频" if has_audio else "自动合并音频")
            candidates.append(
                FormatOption(
                    format_id=format_id,
                    label=" · ".join(details),
                    ext=ext,
                    resolution=resolution,
                    width=self._as_int(item.get("width")),
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
        formats.extend(candidates[:40])

        subtitles: list[SubtitleOption] = []
        explicit = info.get("subtitles") or {}
        automatic = info.get("automatic_captions") or {}
        for language in sorted(set(explicit) | set(automatic))[:80]:
            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,32}", str(language)):
                continue
            is_automatic = language not in explicit
            subtitles.append(SubtitleOption(language=str(language), label=str(language), automatic=is_automatic))
        return ParseResponse(
            url=url,
            title=str(info.get("title") or "未命名视频"),
            extractor=info.get("extractor_key") or info.get("extractor"),
            platform=info.get("extractor_key") or info.get("extractor"),
            thumbnail=info.get("thumbnail"),
            duration=info.get("duration"),
            uploader=info.get("uploader") or info.get("channel"),
            description=(str(info.get("description"))[:500] if info.get("description") else None),
            formats=formats,
            subtitles=subtitles,
        )

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
            return "平台要求登录验证，请让管理员更新 Cookie 配置后重试。"
        if "larger than max-filesize" in lower:
            return "文件超过站点下载大小上限。"
        if "requested format is not available" in lower:
            return "所选清晰度已经失效，请重新解析并选择格式。"
        if "universal data for rehydration" in lower:
            return "TikTok 未返回视频数据，请确认链接是可公开播放的视频，或让管理员更新 TikTok Cookie 后重试。"
        cleaned = re.sub(r"/[^\s]*/\.cookies\.txt", "[cookie]", message)
        return cleaned[-800:] or "任务失败，请稍后重试。"
