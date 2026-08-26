from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import tempfile
from contextlib import nullcontext
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from .config import Settings
from .cookies import CookieStore
from .models import FormatOption, Job, JobStatus, MediaType, ParseResponse, SubtitleOption
from .store import JobStore


class DownloadRejected(Exception):
    pass


class Downloader:
    PROGRESS_PREFIX = "YL_PROGRESS|"

    def __init__(self, settings: Settings, store: JobStore, cookies: CookieStore | None = None) -> None:
        self.settings = settings
        self.store = store
        self.cookies = cookies
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_downloads)
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}

    async def inspect(self, url: str, cookie_profile: str | None = None) -> ParseResponse:
        async with self.semaphore:
            with tempfile.TemporaryDirectory(prefix=".inspect-", dir=self.settings.download_dir) as temporary:
                work_dir = Path(temporary)
                context = self.cookies.materialize(cookie_profile, work_dir) if self.cookies else nullcontext(None)
                with context as cookie_file:
                    command = [*self._base_command(cookie_file), "--dump-single-json", "--skip-download", url]
                    output = await self._run_capture(command, self.settings.metadata_timeout_seconds)
            try:
                info = json.loads(output)
            except json.JSONDecodeError as exc:
                raise DownloadRejected("解析器返回了无效数据，请更新引擎后重试。") from exc
            if not isinstance(info, dict) or info.get("_type") == "playlist":
                raise DownloadRejected("当前仅支持单个视频链接，不支持播放列表。")
            return self._parse_response(url, info)

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
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        context = self.cookies.materialize(job.cookie_profile, job_dir) if self.cookies else nullcontext(None)
        with context as cookie_file:
            job.status = JobStatus.parsing
            job.progress = 2
            job.touch()
            self.store.save(job)

            inspect_command = [*self._base_command(cookie_file), "--dump-single-json", "--skip-download", job.url]
            output = await self._run_capture(inspect_command, self.settings.metadata_timeout_seconds, job.job_id)
            info = json.loads(output)
            if not isinstance(info, dict) or info.get("_type") == "playlist":
                raise DownloadRejected("当前仅支持单个视频链接，不支持播放列表。")
            job.update_from_info(info)
            self._enforce_limits(job)
            self.store.save(job)

            command = self._download_command(job, cookie_file)
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

    def _base_command(self, cookie_file: Path | None) -> list[str]:
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
        if cookie_file:
            command.extend(["--cookies", str(cookie_file)])
        return command

    def _download_command(self, job: Job, cookie_file: Path | None) -> list[str]:
        outtmpl = str(self.store.job_dir(job.job_id) / "%(title).120B-%(id)s.%(ext)s")
        command = [
            *self._base_command(cookie_file),
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
        cleaned = re.sub(r"/[^\s]*/\.cookies\.txt", "[cookie]", message)
        return cleaned[-800:] or "任务失败，请稍后重试。"
