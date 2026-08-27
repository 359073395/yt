import asyncio

import pytest

from app.cookies import CookieStore
from app.models import QrLoginStatus
from app.qr_login import QrLoginCapacityError, QrLoginManager


@pytest.mark.asyncio
async def test_qr_login_sessions_are_reused_and_isolated(tmp_path, monkeypatch):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    manager = QrLoginManager(store, chromium_path="missing", timeout_seconds=300, max_sessions=2)
    gate = asyncio.Event()

    async def fake_run(session):
        session.status = QrLoginStatus.waiting
        session.message = "waiting"
        session.qr_image = b"png"
        session.qr_revision = "revision"
        await gate.wait()

    monkeypatch.setattr(manager, "_run", fake_run)
    first = await manager.start(1, "douyin")
    reused = await manager.start(1, "douyin")
    second = await manager.start(2, "tiktok")
    await asyncio.sleep(0)

    assert first.session_id == reused.session_id
    assert manager.get(first.session_id, 1).status == QrLoginStatus.waiting
    assert manager.qr_code(first.session_id, 1) == (b"png", "revision")
    assert second.session_id != first.session_id
    with pytest.raises(KeyError):
        manager.get(first.session_id, 2)
    with pytest.raises(QrLoginCapacityError):
        await manager.start(3, "douyin")

    await manager.cancel(first.session_id, 1)
    assert manager.get(first.session_id, 1).status == QrLoginStatus.cancelled
    gate.set()
    await manager.close()


def test_qr_login_detects_only_authenticated_session_cookies(tmp_path):
    manager = QrLoginManager(CookieStore(tmp_path / "cookies", "test-secret"))

    assert manager._is_logged_in("douyin", [{"name": "ttwid", "value": "device"}]) is False
    assert manager._is_logged_in("douyin", [{"name": "sessionid", "value": "signed-in"}]) is True
    assert manager._is_logged_in("tiktok", [{"name": "sessionid_ss", "value": "signed-in"}]) is True
    assert manager._is_logged_in("tiktok", [{"name": "sessionid", "value": ""}]) is False
    assert manager._is_logged_in("bilibili", [{"name": "buvid3", "value": "device"}]) is False
    assert manager._is_logged_in("bilibili", [{"name": "SESSDATA", "value": "signed-in"}]) is True


@pytest.mark.asyncio
async def test_qr_login_rejects_unsupported_platform(tmp_path):
    manager = QrLoginManager(CookieStore(tmp_path / "cookies", "test-secret"))

    with pytest.raises(ValueError, match="暂不支持扫码登录"):
        await manager.start(1, "youtube")


@pytest.mark.asyncio
async def test_successful_scan_saves_only_platform_cookies(tmp_path, monkeypatch):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    manager = QrLoginManager(store, timeout_seconds=300)

    class FakeQr:
        async def screenshot(self, **_kwargs):
            return b"valid-png-placeholder"

    class FakePage:
        def set_default_timeout(self, _value):
            return None

        async def goto(self, *_args, **_kwargs):
            return None

    class FakeContext:
        async def new_page(self):
            return FakePage()

        async def cookies(self):
            return [
                {"name": "sessionid", "value": "signed-in", "domain": ".douyin.com", "path": "/", "expires": -1, "httpOnly": True, "secure": True},
                {"name": "other", "value": "remove-me", "domain": ".example.com", "path": "/", "expires": -1, "httpOnly": False, "secure": False},
            ]

        async def close(self):
            return None

    class FakeBrowser:
        version = "140.0.0.0"

        async def new_context(self, **_kwargs):
            return FakeContext()

    async def fake_browser():
        return FakeBrowser()

    async def fake_find(_page, _platform):
        return FakeQr()

    monkeypatch.setattr(manager, "_ensure_browser", fake_browser)
    monkeypatch.setattr(manager, "_find_qr", fake_find)

    created = await manager.start(9, "douyin")
    await manager.sessions[created.session_id].task
    completed = manager.get(created.session_id, 9)

    assert completed.status == QrLoginStatus.completed
    assert completed.profile is not None
    assert completed.profile.cookie_count == 1
    with store.materialize("douyin", tmp_path / "work", owner_id=9) as cookie_file:
        assert cookie_file is not None
        text = cookie_file.read_text()
        assert "signed-in" in text
        assert "remove-me" not in text
