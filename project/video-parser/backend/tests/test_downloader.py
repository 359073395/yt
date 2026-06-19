import asyncio
from pathlib import Path

from app.config import Settings
from app.downloader import Downloader
from app.models import JobStatus
from app.store import JobStore


class FakeYoutubeDL:
    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def extract_info(self, _url, download=False):
        info = {
            "title": "Fake Video",
            "extractor_key": "TikTok",
            "duration": 12,
            "filesize_approx": 1024,
        }
        if download:
            for hook in self.opts.get("progress_hooks", []):
                hook({"status": "downloading", "downloaded_bytes": 512, "total_bytes": 1024})
                hook({"status": "finished"})
            outtmpl = self.opts["outtmpl"]
            job_dir = Path(outtmpl.split("%", 1)[0])
            (job_dir / "fake-video.mp4").write_bytes(b"fake video")
        return info


def test_downloader_completes_with_mocked_ytdlp(tmp_path, monkeypatch):
    monkeypatch.setattr("app.downloader.YoutubeDL", FakeYoutubeDL)
    settings = Settings(download_dir=tmp_path, max_concurrent_downloads=1)
    store = JobStore(tmp_path, ttl_seconds=60)
    job = store.create("https://example.com/video", "127.0.0.1")

    asyncio.run(Downloader(settings, store).run(job))

    assert job.status == JobStatus.completed
    assert job.title == "Fake Video"
    assert job.platform == "TikTok"
    assert job.file_path is not None
    assert job.file_path.exists()
    assert job.public().download_url == f"/api/jobs/{job.job_id}/download"
