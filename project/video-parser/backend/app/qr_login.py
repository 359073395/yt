from __future__ import annotations

import asyncio
import hashlib
import shutil
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from time import monotonic, time
from typing import Any

from .cookies import CookieStore
from .models import CookieProfilePublic, QrLoginPublic, QrLoginStatus


QR_LOGIN_PLATFORMS = {"douyin", "tiktok"}
ACTIVE_STATUSES = {QrLoginStatus.starting, QrLoginStatus.waiting, QrLoginStatus.scanned}
LOGIN_COOKIE_NAMES = {
    "douyin": {"sessionid", "sessionid_ss"},
    "tiktok": {"sessionid", "sessionid_ss"},
}
LOGIN_URLS = {
    "douyin": "https://creator.douyin.com/creator-micro/content/upload",
    "tiktok": "https://www.tiktok.com/login/qrcode",
}
QR_SELECTORS = {
    "douyin": (
        "#animate_qrcode_container img[src^='data:image']",
        "#animate_qrcode_container canvas",
        "img[src^='data:image/png;base64']",
    ),
    "tiktok": (
        "canvas",
        "img[alt*='QR']",
        "img[alt*='qr']",
    ),
}


class QrLoginCapacityError(RuntimeError):
    pass


@dataclass
class QrLoginSession:
    session_id: str
    user_id: int
    platform: str
    status: QrLoginStatus
    created_at: float
    expires_at: float
    message: str
    qr_image: bytes | None = None
    qr_revision: str | None = None
    profile: CookieProfilePublic | None = None
    task: asyncio.Task[None] | None = field(default=None, repr=False)

    def public(self) -> QrLoginPublic:
        return QrLoginPublic(
            session_id=self.session_id,
            platform=self.platform,
            status=self.status,
            created_at=self.created_at,
            expires_at=self.expires_at,
            message=self.message,
            qr_ready=self.qr_image is not None,
            qr_revision=self.qr_revision,
            profile=self.profile,
        )


class QrLoginManager:
    """Short-lived, isolated browser sessions for official QR login pages."""

    def __init__(
        self,
        cookie_store: CookieStore,
        *,
        chromium_path: str = "",
        timeout_seconds: int = 300,
        max_sessions: int = 3,
    ) -> None:
        self.cookie_store = cookie_store
        self.chromium_path = chromium_path
        self.timeout_seconds = timeout_seconds
        self.max_sessions = max_sessions
        self.sessions: dict[str, QrLoginSession] = {}
        self.owner_sessions: dict[tuple[int, str], str] = {}
        self._lock = asyncio.Lock()
        self._browser_lock = asyncio.Lock()
        self._playwright: Any = None
        self._browser: Any = None

    async def start(self, user_id: int, platform: str) -> QrLoginPublic:
        platform = platform.lower()
        if platform not in QR_LOGIN_PLATFORMS:
            raise ValueError("该平台暂不支持扫码登录。")
        async with self._lock:
            existing_id = self.owner_sessions.get((user_id, platform))
            existing = self.sessions.get(existing_id or "")
            if existing and existing.status in ACTIVE_STATUSES:
                return existing.public()
            active_count = sum(item.status in ACTIVE_STATUSES for item in self.sessions.values())
            if active_count >= self.max_sessions:
                raise QrLoginCapacityError("当前扫码人数较多，请稍后再试。")
            now = time()
            session = QrLoginSession(
                session_id=uuid.uuid4().hex,
                user_id=user_id,
                platform=platform,
                status=QrLoginStatus.starting,
                created_at=now,
                expires_at=now + self.timeout_seconds,
                message="正在连接平台官方登录页…",
            )
            self.sessions[session.session_id] = session
            self.owner_sessions[(user_id, platform)] = session.session_id
            session.task = asyncio.create_task(self._run(session))
            return session.public()

    def get(self, session_id: str, user_id: int) -> QrLoginPublic:
        return self._owned(session_id, user_id).public()

    def qr_code(self, session_id: str, user_id: int) -> tuple[bytes, str]:
        session = self._owned(session_id, user_id)
        if not session.qr_image or not session.qr_revision:
            raise ValueError("二维码仍在生成，请稍候。")
        return session.qr_image, session.qr_revision

    async def cancel(self, session_id: str, user_id: int) -> None:
        session = self._owned(session_id, user_id)
        await self._cancel_session(session, "扫码登录已取消。")

    async def cancel_platform(self, user_id: int, platform: str) -> None:
        session_id = self.owner_sessions.get((user_id, platform.lower()))
        session = self.sessions.get(session_id or "")
        if session and session.status in ACTIVE_STATUSES:
            await self._cancel_session(session, "扫码登录已取消。")

    async def cancel_user(self, user_id: int) -> None:
        sessions = [item for item in self.sessions.values() if item.user_id == user_id and item.status in ACTIVE_STATUSES]
        await asyncio.gather(*(self._cancel_session(item, "用户已删除。") for item in sessions), return_exceptions=True)

    async def cleanup(self) -> None:
        cutoff = time() - 15 * 60
        async with self._lock:
            stale = [key for key, item in self.sessions.items() if item.status not in ACTIVE_STATUSES and item.created_at < cutoff]
            for session_id in stale:
                item = self.sessions.pop(session_id)
                if self.owner_sessions.get((item.user_id, item.platform)) == session_id:
                    self.owner_sessions.pop((item.user_id, item.platform), None)

    async def close(self) -> None:
        tasks = [item.task for item in self.sessions.values() if item.task and not item.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        async with self._browser_lock:
            if self._browser:
                with suppress(Exception):
                    await self._browser.close()
            if self._playwright:
                with suppress(Exception):
                    await self._playwright.stop()
            self._browser = None
            self._playwright = None

    def _owned(self, session_id: str, user_id: int) -> QrLoginSession:
        session = self.sessions.get(session_id)
        if not session or session.user_id != user_id:
            raise KeyError(session_id)
        return session

    async def _cancel_session(self, session: QrLoginSession, message: str) -> None:
        if session.status not in ACTIVE_STATUSES:
            return
        session.status = QrLoginStatus.cancelled
        session.message = message
        session.qr_image = None
        session.qr_revision = None
        if session.task and session.task is not asyncio.current_task() and not session.task.done():
            session.task.cancel()
            await asyncio.gather(session.task, return_exceptions=True)

    async def _ensure_browser(self) -> Any:
        async with self._browser_lock:
            if self._browser and self._browser.is_connected():
                return self._browser
            chromium = self.chromium_path.strip() or shutil.which("chromium") or shutil.which("chromium-browser")
            if not chromium:
                raise RuntimeError("服务器未安装 Chromium，暂时无法扫码登录。")
            from playwright.async_api import async_playwright

            if self._playwright:
                with suppress(Exception):
                    await self._playwright.stop()
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                executable_path=chromium,
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            return self._browser

    async def _run(self, session: QrLoginSession) -> None:
        context: Any = None
        try:
            browser = await self._ensure_browser()
            version = browser.version
            context = await browser.new_context(
                locale="zh-CN",
                viewport={"width": 1280, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    f"(KHTML, like Gecko) Chrome/{version} Safari/537.36"
                ),
            )
            page = await context.new_page()
            page.set_default_timeout(30_000)
            await page.goto(LOGIN_URLS[session.platform], wait_until="domcontentloaded", timeout=60_000)
            qr_locator = await self._find_qr(page, session.platform)
            await self._update_qr(session, qr_locator)
            session.status = QrLoginStatus.waiting
            session.message = "请使用平台 App 扫描二维码并在手机上确认登录。"
            deadline = monotonic() + max(1, session.expires_at - time())
            while monotonic() < deadline and session.status in ACTIVE_STATUSES:
                cookies = await context.cookies()
                if self._is_logged_in(session.platform, cookies):
                    content = CookieStore.browser_cookies_to_netscape(cookies)
                    session.profile = self.cookie_store.save(
                        session.platform,
                        content,
                        owner_id=session.user_id,
                        platform=session.platform,
                    )
                    session.status = QrLoginStatus.completed
                    session.message = "扫码登录成功，Cookie 已加密保存并启用。"
                    session.qr_image = None
                    session.qr_revision = None
                    return
                if await self._looks_scanned(page, session.platform):
                    session.status = QrLoginStatus.scanned
                    session.message = "已扫码，请在手机上确认；如平台要求验证，请按提示完成。"
                with suppress(Exception):
                    await self._update_qr(session, qr_locator)
                await asyncio.sleep(2)
            if session.status in ACTIVE_STATUSES:
                session.status = QrLoginStatus.expired
                session.message = "本次扫码已超时，请重新生成二维码。"
                session.qr_image = None
                session.qr_revision = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            if session.status in ACTIVE_STATUSES:
                session.status = QrLoginStatus.failed
                session.message = self._safe_error(exc)
                session.qr_image = None
                session.qr_revision = None
        finally:
            if context:
                with suppress(Exception):
                    await context.close()

    @staticmethod
    async def _find_qr(page: Any, platform: str) -> Any:
        deadline = monotonic() + 35
        while monotonic() < deadline:
            for selector in QR_SELECTORS[platform]:
                candidates = page.locator(selector)
                for index in range(min(await candidates.count(), 12)):
                    candidate = candidates.nth(index)
                    box = await candidate.bounding_box()
                    if box and 120 <= box["width"] <= 360 and 120 <= box["height"] <= 360:
                        return candidate
            await asyncio.sleep(0.5)
        raise RuntimeError("平台登录页没有生成二维码，请稍后重试。")

    @staticmethod
    async def _update_qr(session: QrLoginSession, locator: Any) -> None:
        image = await locator.screenshot(type="png")
        revision = hashlib.sha256(image).hexdigest()[:16]
        if revision != session.qr_revision:
            session.qr_image = image
            session.qr_revision = revision

    @staticmethod
    def _is_logged_in(platform: str, cookies: list[dict[str, Any]]) -> bool:
        required = LOGIN_COOKIE_NAMES[platform]
        return any(cookie.get("name") in required and cookie.get("value") for cookie in cookies)

    @staticmethod
    async def _looks_scanned(page: Any, platform: str) -> bool:
        try:
            text = (await page.locator("body").inner_text(timeout=2_000)).lower()
        except Exception:  # noqa: BLE001
            return False
        if platform == "tiktok":
            return any(marker in text for marker in ("已扫描", "scanned", "confirm on your phone", "在手机上确认"))
        return any(marker in text for marker in ("扫码成功", "已扫码", "请在手机上确认"))

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        message = str(exc).splitlines()[0].strip()
        if "Timeout" in type(exc).__name__ or "timeout" in message.lower():
            return "平台登录页响应超时，请稍后重新生成二维码。"
        if not message or len(message) > 180:
            return "扫码登录暂时不可用，请稍后重试或改用 cookies.txt。"
        return f"扫码登录失败：{message}"
