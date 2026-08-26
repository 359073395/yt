from urllib.parse import parse_qs, urlsplit

import pytest

from app.assets import RemoteAssetError, signed_asset_url, verify_asset_token


def test_signed_asset_token_round_trip(monkeypatch):
    monkeypatch.setattr(
        "app.security.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("8.8.8.8", 0))],
    )
    source_url = "https://cdn.example.com/path/cover.jpg?token=abc"
    signed = signed_asset_url(source_url, "cover", "test-secret", download=False)
    query = parse_qs(urlsplit(signed).query)

    restored = verify_asset_token(
        "cover",
        query["source"][0],
        int(query["expires"][0]),
        query["signature"][0],
        "test-secret",
    )

    assert restored == source_url
    assert query["download"] == ["0"]


def test_signed_asset_token_rejects_tampering():
    signed = signed_asset_url("https://cdn.example.com/subtitle.vtt", "subtitle", "test-secret")
    query = parse_qs(urlsplit(signed).query)

    with pytest.raises(RemoteAssetError, match="签名"):
        verify_asset_token(
            "subtitle",
            query["source"][0] + "x",
            int(query["expires"][0]),
            query["signature"][0],
            "test-secret",
        )


def test_signed_asset_url_requires_https():
    with pytest.raises(RemoteAssetError):
        signed_asset_url("http://example.com/cover.jpg", "cover", "test-secret")
