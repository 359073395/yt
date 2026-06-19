import pytest
from fastapi import HTTPException

from app.security import RateLimiter, validate_public_url


def test_validate_public_url_accepts_https():
    assert validate_public_url("https://example.com/video") == "https://example.com/video"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/video",
        "not a url",
        "http://localhost/video",
        "http://127.0.0.1/video",
        "http://10.0.0.1/video",
    ],
)
def test_validate_public_url_rejects_unsafe_urls(url):
    with pytest.raises(HTTPException):
        validate_public_url(url)


def test_rate_limiter_rejects_after_limit():
    limiter = RateLimiter(2)
    limiter.check("1.2.3.4")
    limiter.check("1.2.3.4")
    with pytest.raises(HTTPException) as exc:
        limiter.check("1.2.3.4")
    assert exc.value.status_code == 429
