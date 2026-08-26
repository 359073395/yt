import pytest

from app import main


@pytest.mark.asyncio
async def test_health_does_not_spawn_component_processes(monkeypatch):
    async def unexpected_probe(*_args):
        raise AssertionError("the liveness endpoint must not spawn subprocesses")

    monkeypatch.setattr(main, "binary_version", unexpected_probe)

    response = await main.health()

    assert response["status"] == "ok"
    assert response["version"] == "2.1.1"
    assert set(response["components"]) == {"yt_dlp", "deno", "ffmpeg"}


@pytest.mark.asyncio
async def test_diagnostics_reports_component_versions(monkeypatch):
    async def fake_version(binary, *_args):
        return f"{binary}-test-version"

    monkeypatch.setattr(main, "binary_version", fake_version)

    response = await main.diagnostics()

    assert response["components"]["deno"] == "deno-test-version"
    assert response["components"]["ffmpeg"] == "ffmpeg-test-version"
