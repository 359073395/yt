import pytest

from app import main


@pytest.mark.asyncio
async def test_health_does_not_spawn_component_processes(monkeypatch):
    async def unexpected_probe(*_args):
        raise AssertionError("the liveness endpoint must not spawn subprocesses")

    def unexpected_native_import(_transcriber):
        raise AssertionError("the liveness endpoint must not load faster-whisper")

    monkeypatch.setattr(main, "binary_version", unexpected_probe)
    monkeypatch.setattr(type(main.downloader.transcriber), "available", property(unexpected_native_import))
    monkeypatch.setattr(main, "find_spec", lambda _name: object())

    response = await main.health()

    assert response["status"] == "ok"
    assert response["version"] == "2.5.0"
    assert set(response["components"]) == {"yt_dlp", "deno", "ffmpeg", "chromium", "douyin_public_session", "transcription"}
    assert response["components"]["transcription"] == "available"


@pytest.mark.asyncio
async def test_diagnostics_reports_component_versions(monkeypatch):
    async def fake_version(binary, *_args):
        return f"{binary}-test-version"

    monkeypatch.setattr(main, "binary_version", fake_version)

    response = await main.diagnostics()

    assert response["components"]["deno"] == "deno-test-version"
    assert response["components"]["ffmpeg"] == "ffmpeg-test-version"
    assert response["components"]["chromium"].endswith("-test-version")
    assert response["components"]["douyin_public_session"] == "available"
