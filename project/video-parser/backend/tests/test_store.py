from time import sleep

from app.models import JobStatus
from app.store import JobStore


def test_store_creates_and_expires_job(tmp_path):
    store = JobStore(tmp_path, ttl_seconds=1)
    job = store.create("https://example.com/video", "127.0.0.1")
    job.status = JobStatus.completed
    store.save(job)

    assert store.get(job.job_id) is job
    assert store.job_dir(job.job_id).exists()

    sleep(1.1)
    expired = store.get(job.job_id)
    assert expired is not None
    assert expired.status == JobStatus.expired
    assert not store.job_dir(job.job_id).exists()


def test_store_restores_history_after_restart(tmp_path):
    database = tmp_path / "video-parser.sqlite3"
    downloads = tmp_path / "downloads"
    first = JobStore(downloads, ttl_seconds=60, database_path=database)
    job = first.create("https://example.com/video", "127.0.0.1")
    job.title = "Persistent title"
    job.status = JobStatus.completed
    job.touch()
    first.save(job)

    restored = JobStore(downloads, ttl_seconds=60, database_path=database).get(job.job_id)

    assert restored is not None
    assert restored.title == "Persistent title"
    assert restored.status == JobStatus.completed
