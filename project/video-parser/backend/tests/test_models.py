import pytest
from pydantic import ValidationError

from app.models import BatchJobCreateRequest, JobCreateRequest, MediaType, TranscriptMode


def test_batch_request_normalizes_and_deduplicates_urls():
    payload = BatchJobCreateRequest(
        urls=[
            " https://example.com/video/1 ",
            "https://example.com/video/1",
            "https://example.com/video/2",
        ],
    )

    assert payload.urls == ["https://example.com/video/1", "https://example.com/video/2"]


def test_batch_request_rejects_more_than_fifty_urls():
    with pytest.raises(ValidationError):
        BatchJobCreateRequest(urls=[f"https://example.com/video/{index}" for index in range(51)])


def test_transcript_job_uses_automatic_fallback_by_default():
    payload = JobCreateRequest(url="https://example.com/video", media_type=MediaType.transcript)

    assert payload.transcript_mode == TranscriptMode.auto
