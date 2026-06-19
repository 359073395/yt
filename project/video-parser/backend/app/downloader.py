import asyncio
from pathlib import Path
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from .config import Settings
from .models import Job, JobStatus
from .store import JobStore


class DownloadRejected(Exception):
    pass


class Downloader:
    def __init__(self, settings: Settings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.semaphore = asyncio.Semaphore(settings.max_concurrent_downloads)

    async def run(self, job: Job) -> None:
        async with self.semaphore:
            try:
                await asyncio.to_thread(self._download_sync, job)
            except Exception as exc:  # noqa: BLE001
                job.status = JobStatus.failed
                job.error = self._safe_error(exc)
                job.touch()

    def _download_sync(self, job: Job) -> None:
        job_dir = self.store.job_dir(job.job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        outtmpl = str(job_dir / "%(title).80s-%(id)s.%(ext)s")

        base_opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "socket_timeout": self.settings.request_timeout_seconds,
            "restrictfilenames": True,
            "cachedir": False,
        }

        job.status = JobStatus.parsing
        job.progress = 3
        job.touch()

        with YoutubeDL(base_opts) as ydl:
            info = ydl.extract_info(job.url, download=False)
        if not isinstance(info, dict):
            raise DownloadRejected("无法解析该链接。")
        if info.get("_type") == "playlist":
            raise DownloadRejected("第一版仅支持单个视频链接，不支持播放列表。")

        job.update_from_info(info)
        self._enforce_limits(job)

        def progress_hook(data: dict[str, Any]) -> None:
            status = data.get("status")
            if status == "downloading":
                job.status = JobStatus.downloading
                downloaded = data.get("downloaded_bytes") or 0
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                job.downloaded_bytes = int(downloaded)
                job.total_bytes = int(total) if total else job.total_bytes
                if total:
                    job.progress = min(94, 10 + (downloaded / total) * 78)
                job.touch()
            elif status == "finished":
                job.status = JobStatus.merging
                job.progress = 94
                job.touch()

        download_opts = {
            **base_opts,
            "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
            "merge_output_format": "mp4",
            "outtmpl": outtmpl,
            "max_filesize": self.settings.max_file_size_bytes,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [lambda _: self._mark_merging(job)],
        }

        try:
            with YoutubeDL(download_opts) as ydl:
                result = ydl.extract_info(job.url, download=True)
        except DownloadError as exc:
            raise DownloadRejected(str(exc)) from exc

        if isinstance(result, dict):
            job.update_from_info(result)

        file_path = self._find_output_file(job_dir)
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
        job.status = JobStatus.completed
        job.touch()

    def _mark_merging(self, job: Job) -> None:
        job.status = JobStatus.merging
        job.progress = max(job.progress, 94)
        job.touch()

    def _enforce_limits(self, job: Job) -> None:
        if job.duration and job.duration > self.settings.max_duration_seconds:
            minutes = self.settings.max_duration_seconds // 60
            raise DownloadRejected(f"视频时长超过 {minutes} 分钟上限。")
        if job.size_bytes and job.size_bytes > self.settings.max_file_size_bytes:
            raise DownloadRejected(f"文件超过 {self.settings.max_file_size_mb} MB 上限。")

    @staticmethod
    def _find_output_file(job_dir: Path) -> Path | None:
        files = [p for p in job_dir.iterdir() if p.is_file() and not p.name.endswith(".part")]
        if not files:
            return None
        return max(files, key=lambda p: p.stat().st_mtime)

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        message = str(exc).strip()
        if "Unsupported URL" in message:
            return "yt-dlp 暂不支持该链接或平台。"
        if "Invalid argument" in message:
            return "该链接暂时无法解析，请确认平台受 yt-dlp 支持。"
        if "File is larger than max-filesize" in message:
            return "文件超过站点下载大小上限。"
        return message[-400:] or "任务失败，请稍后重试。"
