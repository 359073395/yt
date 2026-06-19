from time import sleep

from app.models import JobStatus
from app.store import JobStore


def test_store_creates_and_expires_job(tmp_path):
    store = JobStore(tmp_path, ttl_seconds=1)
    job = store.create("https://example.com/video", "127.0.0.1")

    assert store.get(job.job_id) is job
    assert store.job_dir(job.job_id).exists()

    sleep(1.1)
    expired = store.get(job.job_id)
    assert expired is not None
    assert expired.status == JobStatus.expired
    assert not store.job_dir(job.job_id).exists()
