import shutil
import uuid
from pathlib import Path
from time import time

from .models import Job, JobPublic, JobStatus


class JobStore:
    def __init__(self, download_dir: Path, ttl_seconds: int) -> None:
        self.download_dir = download_dir
        self.ttl_seconds = ttl_seconds
        self.jobs: dict[str, Job] = {}
        self.download_dir.mkdir(parents=True, exist_ok=True)

    def create(self, url: str, client_ip: str) -> Job:
        job_id = uuid.uuid4().hex[:16]
        job = Job(job_id=job_id, url=url, client_ip=client_ip, ttl_seconds=self.ttl_seconds)
        self.jobs[job_id] = job
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        return job

    def get(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        if job.expires_at and time() > job.expires_at and job.status != JobStatus.expired:
            self.expire(job)
        return job

    def job_dir(self, job_id: str) -> Path:
        return self.download_dir / job_id

    def expire(self, job: Job) -> None:
        job.status = JobStatus.expired
        job.file_path = None
        job.filename = None
        job.touch()
        shutil.rmtree(self.job_dir(job.job_id), ignore_errors=True)

    def cleanup(self) -> int:
        removed = 0
        now = time()
        for job in list(self.jobs.values()):
            if job.expires_at and now > job.expires_at:
                self.expire(job)
                removed += 1
        for path in self.download_dir.iterdir():
            if path.is_dir() and path.name not in self.jobs:
                shutil.rmtree(path, ignore_errors=True)
        return removed

    def list_public(self) -> list[JobPublic]:
        return [job.public() for job in sorted(self.jobs.values(), key=lambda item: item.created_at, reverse=True)]

    def stats(self) -> dict[str, int]:
        running = {JobStatus.queued, JobStatus.parsing, JobStatus.downloading, JobStatus.merging}
        return {
            "jobs_total": len(self.jobs),
            "jobs_running": sum(1 for job in self.jobs.values() if job.status in running),
            "jobs_completed": sum(1 for job in self.jobs.values() if job.status == JobStatus.completed),
            "jobs_failed": sum(1 for job in self.jobs.values() if job.status == JobStatus.failed),
            "storage_bytes": self.storage_bytes(),
        }

    def storage_bytes(self) -> int:
        total = 0
        if not self.download_dir.exists():
            return total
        for path in self.download_dir.rglob("*"):
            if path.is_file():
                total += path.stat().st_size
        return total
