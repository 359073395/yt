import shutil
import sqlite3
import uuid
from pathlib import Path
from time import time

from .models import Job, JobCreateRequest, JobPublic, JobStatus, MediaType, TranscriptFormat, TranscriptMode


class JobStore:
    def __init__(self, download_dir: Path, ttl_seconds: int, database_path: Path | None = None) -> None:
        self.download_dir = download_dir
        self.ttl_seconds = ttl_seconds
        self.database_path = database_path or (download_dir / ".jobs.sqlite3")
        self.jobs: dict[str, Job] = {}
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._load()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS download_jobs (
                    job_id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    client_ip TEXT NOT NULL,
                    user_id INTEGER,
                    status TEXT NOT NULL,
                    title TEXT,
                    extractor TEXT,
                    platform TEXT,
                    thumbnail TEXT,
                    duration REAL,
                    size_bytes INTEGER,
                    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER,
                    progress REAL NOT NULL DEFAULT 0,
                    speed REAL,
                    eta INTEGER,
                    media_type TEXT NOT NULL DEFAULT 'video',
                    format_id TEXT NOT NULL DEFAULT 'best',
                    format_has_audio INTEGER NOT NULL DEFAULT 0,
                    audio_format TEXT NOT NULL DEFAULT 'mp3',
                    subtitle_language TEXT,
                    cookie_profile TEXT,
                    filename TEXT,
                    file_path TEXT,
                    error TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    expires_at REAL
                )
                """
            )
            self._ensure_column(conn, "transcript_mode", "TEXT NOT NULL DEFAULT 'none'")
            self._ensure_column(conn, "transcript_format", "TEXT NOT NULL DEFAULT 'srt'")
            self._ensure_column(conn, "transcript_language", "TEXT")
            self._ensure_column(conn, "include_description", "INTEGER NOT NULL DEFAULT 0")
            self._ensure_column(conn, "include_thumbnail", "INTEGER NOT NULL DEFAULT 0")

    @staticmethod
    def _ensure_column(conn: sqlite3.Connection, column: str, definition: str) -> None:
        columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(download_jobs)").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE download_jobs ADD COLUMN {column} {definition}")

    def _load(self) -> None:
        active = (
            JobStatus.queued.value,
            JobStatus.parsing.value,
            JobStatus.downloading.value,
            JobStatus.merging.value,
            JobStatus.transcribing.value,
        )
        interrupted_at = time()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE download_jobs
                SET status = ?, error = ?, progress = 0, speed = NULL, eta = NULL, updated_at = ?
                WHERE status IN (?, ?, ?, ?, ?)
                """,
                (
                    JobStatus.failed.value,
                    "服务更新或重启中断了任务，请点击重试。",
                    interrupted_at,
                    *active,
                ),
            )
            rows = conn.execute("SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT 500").fetchall()
        for row in rows:
            job = self._from_row(row)
            self.jobs[job.job_id] = job

    def _from_row(self, row: sqlite3.Row) -> Job:
        job = Job(
            job_id=str(row["job_id"]),
            url=str(row["url"]),
            client_ip=str(row["client_ip"]),
            ttl_seconds=self.ttl_seconds,
            user_id=row["user_id"],
            media_type=MediaType(str(row["media_type"])),
            format_id=str(row["format_id"]),
            format_has_audio=bool(row["format_has_audio"]),
            audio_format=str(row["audio_format"]),
            subtitle_language=row["subtitle_language"],
            transcript_mode=TranscriptMode(str(row["transcript_mode"])),
            transcript_format=TranscriptFormat(str(row["transcript_format"])),
            transcript_language=row["transcript_language"],
            include_description=bool(row["include_description"]),
            include_thumbnail=bool(row["include_thumbnail"]),
            cookie_profile=row["cookie_profile"],
            created_at=float(row["created_at"]),
            persist=self.save,
        )
        job.status = JobStatus(str(row["status"]))
        for name in ("title", "extractor", "platform", "thumbnail", "duration", "size_bytes", "total_bytes", "speed", "eta", "filename", "error", "expires_at"):
            setattr(job, name, row[name])
        job.downloaded_bytes = int(row["downloaded_bytes"] or 0)
        job.progress = float(row["progress"] or 0)
        job.updated_at = float(row["updated_at"])
        job.file_path = Path(row["file_path"]) if row["file_path"] else None
        return job

    def create(
        self,
        url: str,
        client_ip: str,
        payload: JobCreateRequest | None = None,
        user_id: int | None = None,
    ) -> Job:
        payload = payload or JobCreateRequest(url=url)
        job_id = uuid.uuid4().hex
        job = Job(
            job_id=job_id,
            url=url,
            client_ip=client_ip,
            ttl_seconds=self.ttl_seconds,
            user_id=user_id,
            media_type=payload.media_type,
            format_id=payload.format_id,
            format_has_audio=payload.format_has_audio,
            audio_format=payload.audio_format,
            subtitle_language=payload.subtitle_language,
            transcript_mode=payload.transcript_mode,
            transcript_format=payload.transcript_format,
            transcript_language=payload.transcript_language,
            include_description=payload.include_description,
            include_thumbnail=payload.include_thumbnail,
            cookie_profile=payload.cookie_profile,
            persist=self.save,
        )
        self.jobs[job_id] = job
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        self.save(job)
        return job

    def save(self, job: Job) -> None:
        values = (
            job.job_id, job.url, job.client_ip, job.user_id, job.status.value, job.title, job.extractor,
            job.platform, job.thumbnail, job.duration, job.size_bytes, job.downloaded_bytes, job.total_bytes,
            job.progress, job.speed, job.eta, job.media_type.value, job.format_id, int(job.format_has_audio),
            job.audio_format, job.subtitle_language, job.transcript_mode.value, job.transcript_format.value,
            job.transcript_language, int(job.include_description), int(job.include_thumbnail), job.cookie_profile, job.filename,
            str(job.file_path) if job.file_path else None, job.error, job.created_at, job.updated_at, job.expires_at,
        )
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO download_jobs (
                    job_id,url,client_ip,user_id,status,title,extractor,platform,thumbnail,duration,size_bytes,
                    downloaded_bytes,total_bytes,progress,speed,eta,media_type,format_id,format_has_audio,
                    audio_format,subtitle_language,transcript_mode,transcript_format,transcript_language,
                    include_description,include_thumbnail,cookie_profile,filename,file_path,error,created_at,updated_at,expires_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(job_id) DO UPDATE SET
                    status=excluded.status,title=excluded.title,extractor=excluded.extractor,platform=excluded.platform,
                    thumbnail=excluded.thumbnail,duration=excluded.duration,size_bytes=excluded.size_bytes,
                    downloaded_bytes=excluded.downloaded_bytes,total_bytes=excluded.total_bytes,progress=excluded.progress,
                    speed=excluded.speed,eta=excluded.eta,transcript_mode=excluded.transcript_mode,
                    transcript_format=excluded.transcript_format,transcript_language=excluded.transcript_language,
                    include_description=excluded.include_description,include_thumbnail=excluded.include_thumbnail,
                    filename=excluded.filename,file_path=excluded.file_path,
                    error=excluded.error,updated_at=excluded.updated_at,expires_at=excluded.expires_at
                """,
                values,
            )

    def get(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        if job.expires_at and time() > job.expires_at and job.status == JobStatus.completed:
            self.expire(job)
        return job

    def job_dir(self, job_id: str) -> Path:
        return self.download_dir / job_id

    def is_owner(self, job: Job, user_id: int | None, client_ip: str) -> bool:
        return (user_id is not None and job.user_id == user_id) or (user_id is None and job.user_id is None and job.client_ip == client_ip)

    def retry(self, job: Job) -> Job:
        shutil.rmtree(self.job_dir(job.job_id), ignore_errors=True)
        self.job_dir(job.job_id).mkdir(parents=True, exist_ok=True)
        job.status = JobStatus.queued
        job.progress = 0
        job.downloaded_bytes = 0
        job.total_bytes = None
        job.speed = None
        job.eta = None
        job.file_path = None
        job.filename = None
        job.error = None
        job.expires_at = time() + self.ttl_seconds
        job.touch()
        self.save(job)
        return job

    def expire(self, job: Job) -> None:
        job.status = JobStatus.expired
        job.file_path = None
        job.filename = None
        job.touch()
        shutil.rmtree(self.job_dir(job.job_id), ignore_errors=True)
        self.save(job)

    def cleanup(self) -> int:
        removed = 0
        now = time()
        for job in list(self.jobs.values()):
            if job.expires_at and now > job.expires_at and job.status == JobStatus.completed:
                self.expire(job)
                removed += 1
        for path in self.download_dir.iterdir():
            if path.is_dir() and not path.name.startswith(".") and path.name not in self.jobs:
                shutil.rmtree(path, ignore_errors=True)
        cutoff = now - 30 * 86400
        stale = [job_id for job_id, job in self.jobs.items() if job.updated_at < cutoff and job.status in {JobStatus.expired, JobStatus.failed, JobStatus.cancelled}]
        if stale:
            with self.connect() as conn:
                conn.executemany("DELETE FROM download_jobs WHERE job_id = ?", [(job_id,) for job_id in stale])
            for job_id in stale:
                self.jobs.pop(job_id, None)
        return removed

    def list_public(self) -> list[JobPublic]:
        return [job.public() for job in sorted(self.jobs.values(), key=lambda item: item.created_at, reverse=True)]

    def list_for(self, user_id: int | None, client_ip: str, limit: int = 50) -> list[JobPublic]:
        jobs = [job for job in self.jobs.values() if self.is_owner(job, user_id, client_ip)]
        return [job.public() for job in sorted(jobs, key=lambda item: item.created_at, reverse=True)[:limit]]

    def stats(self) -> dict[str, int]:
        running = {JobStatus.queued, JobStatus.parsing, JobStatus.downloading, JobStatus.merging, JobStatus.transcribing}
        return {
            "jobs_total": len(self.jobs),
            "jobs_running": sum(1 for job in self.jobs.values() if job.status in running),
            "jobs_completed": sum(1 for job in self.jobs.values() if job.status == JobStatus.completed),
            "jobs_failed": sum(1 for job in self.jobs.values() if job.status in {JobStatus.failed, JobStatus.cancelled}),
            "storage_bytes": self.storage_bytes(),
        }

    def storage_bytes(self) -> int:
        total = 0
        if not self.download_dir.exists():
            return total
        for path in self.download_dir.rglob("*"):
            if path.is_file() and path != self.database_path:
                total += path.stat().st_size
        return total
