from __future__ import annotations

import asyncio
import json
import logging
import random
import string
from time import monotonic
from typing import Any
from urllib.parse import urlencode

import httpx

from .douyin_signatures.abogus import ABogus, BrowserFingerprintGenerator


logger = logging.getLogger(__name__)


class DouyinPublicError(RuntimeError):
    """Raised when Douyin's public web session cannot return public content."""


class DouyinPublicSession:
    """Anonymous, server-side visitor session for Douyin public web content.

    A short headless visit establishes the same guest cookies that Douyin gives
    any ordinary visitor. Public API requests then reuse those cookies with the
    web signature. No platform account, user Cookie, or persistent browser
    profile is involved.
    """

    BASE_URL = "https://www.douyin.com"
    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    )
    SESSION_TTL_SECONDS = 20 * 60

    def __init__(self, chromium_path: str, request_timeout_seconds: int = 30) -> None:
        self.chromium_path = chromium_path
        self.request_timeout_seconds = max(10, min(request_timeout_seconds, 45))
        self._cookies: dict[str, str] = {}
        self._ms_token = ""
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def profile_posts(
        self,
        sec_uid: str,
        max_items: int,
        profile_url: str,
    ) -> tuple[list[dict[str, Any]], bool, int | None]:
        await self._ensure_guest_session(profile_url)
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        cursor = 0
        has_more = True
        total_count: int | None = None

        while has_more and len(items) < max_items:
            count = min(18, max_items - len(items))
            payload = await self._request_json(
                "/aweme/v1/web/aweme/post/",
                {
                    "sec_user_id": sec_uid,
                    "max_cursor": cursor,
                    "count": count,
                    "locate_query": "false",
                    "show_live_replay_strategy": "1",
                    "need_time_list": "1",
                    "time_list_query": "0",
                    "whale_cut_token": "",
                    "cut_version": "1",
                    "publish_video_strategy_type": "2",
                },
                refresh_url=profile_url,
            )
            raw_items = payload.get("aweme_list")
            if not isinstance(raw_items, list):
                if items:
                    break
                raise DouyinPublicError("抖音公开主页暂时没有返回作品列表，请稍后重试。")

            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
                author_sec_uid = str(author.get("sec_uid") or "")
                if author_sec_uid and author_sec_uid != sec_uid:
                    continue
                aweme_id = str(raw.get("aweme_id") or "")
                if not aweme_id or aweme_id in seen:
                    continue
                seen.add(aweme_id)
                items.append(raw)
                author_total = author.get("aweme_count")
                if isinstance(author_total, int) and author_total >= 0:
                    total_count = author_total
                if len(items) >= max_items:
                    break

            has_more = self._as_bool(payload.get("has_more"))
            next_cursor = self._as_int(payload.get("max_cursor"))
            if not has_more or next_cursor is None or next_cursor == cursor:
                break
            cursor = next_cursor

        return items, has_more, total_count

    async def video_detail(self, aweme_id: str, public_url: str) -> dict[str, Any]:
        await self._ensure_guest_session(public_url)
        for aid in ("6383", "1128"):
            payload = await self._request_json(
                "/aweme/v1/web/aweme/detail/",
                {"aweme_id": aweme_id, "aid": aid},
                refresh_url=public_url,
            )
            detail = payload.get("aweme_detail")
            if isinstance(detail, dict):
                return detail
        raise DouyinPublicError("抖音公开作品暂时没有返回可下载地址，请稍后重试。")

    async def _request_json(
        self,
        path: str,
        extra_params: dict[str, Any],
        *,
        refresh_url: str,
    ) -> dict[str, Any]:
        last_status = 0
        for attempt in range(2):
            if attempt:
                await self._refresh_guest_session(refresh_url)
            params = {**self._default_query(), **extra_params}
            query = urlencode(params)
            signer = ABogus(
                fp=BrowserFingerprintGenerator.generate_fingerprint("Chrome"),
                user_agent=self.USER_AGENT,
            )
            signed_query, _signature, user_agent, _body = signer.generate_abogus(query, "")
            url = f"{self.BASE_URL}{path}?{signed_query}"
            headers = {
                "User-Agent": user_agent,
                "Referer": f"{self.BASE_URL}/?recommend=1",
                "Accept": "*/*",
                "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            }
            try:
                async with httpx.AsyncClient(
                    headers=headers,
                    cookies=self._cookies,
                    follow_redirects=True,
                    timeout=self.request_timeout_seconds,
                ) as client:
                    response = await client.get(url)
                last_status = response.status_code
                if response.status_code == 200 and response.content:
                    payload = response.json()
                    if isinstance(payload, dict):
                        return payload
            except (httpx.HTTPError, json.JSONDecodeError) as exc:
                logger.warning(
                    "douyin_public_request_failed path=%s attempt=%s error=%s",
                    path,
                    attempt + 1,
                    str(exc)[:200],
                )
        raise DouyinPublicError(
            f"抖音公开接口暂时不可用（HTTP {last_status or '无响应'}），请稍后重试。"
        )

    def _default_query(self) -> dict[str, Any]:
        return {
            "device_platform": "webapp",
            "aid": "6383",
            "channel": "channel_pc_web",
            "update_version_code": "170400",
            "pc_client_type": "1",
            "pc_libra_divert": "Windows",
            "version_code": "290100",
            "version_name": "29.1.0",
            "cookie_enabled": "true",
            "screen_width": "1536",
            "screen_height": "864",
            "browser_language": "zh-CN",
            "browser_platform": "Win32",
            "browser_name": "Chrome",
            "browser_version": "139.0.0.0",
            "browser_online": "true",
            "engine_name": "Blink",
            "engine_version": "139.0.0.0",
            "os_name": "Windows",
            "os_version": "10",
            "cpu_core_num": "16",
            "device_memory": "8",
            "platform": "PC",
            "downlink": "10",
            "effective_type": "4g",
            "round_trip_time": "200",
            "support_h265": "1",
            "support_dash": "1",
            "uifid": "",
            "msToken": self._cookies.get("msToken") or self._stable_ms_token(),
        }

    async def _ensure_guest_session(self, target_url: str) -> None:
        if self._cookies and monotonic() < self._expires_at:
            return
        async with self._lock:
            if self._cookies and monotonic() < self._expires_at:
                return
            await self._bootstrap_guest_session(target_url)

    async def _refresh_guest_session(self, target_url: str) -> None:
        async with self._lock:
            await self._bootstrap_guest_session(target_url)

    async def _bootstrap_guest_session(self, target_url: str) -> None:
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise DouyinPublicError("服务器缺少抖音公开解析组件。") from exc

        browser = None
        playwright = None
        try:
            playwright = await async_playwright().start()
            browser = await playwright.chromium.launch(
                executable_path=self.chromium_path or None,
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                ],
            )
            context = await browser.new_context(
                user_agent=self.USER_AGENT,
                locale="zh-CN",
                viewport={"width": 1536, "height": 864},
            )
            page = await context.new_page()
            try:
                await page.goto(
                    target_url,
                    wait_until="domcontentloaded",
                    timeout=min(self.request_timeout_seconds * 1000, 25_000),
                )
            except Exception:  # The public page often keeps nonessential requests open.
                pass
            for _ in range(8):
                cookies = await context.cookies(self.BASE_URL)
                names = {str(item.get("name") or "") for item in cookies}
                if "ttwid" in names and "__ac_nonce" in names:
                    break
                await page.wait_for_timeout(500)
            cookies = await context.cookies(self.BASE_URL)
            guest_cookies = {
                str(item.get("name")): str(item.get("value"))
                for item in cookies
                if item.get("name") and item.get("value") and "douyin.com" in str(item.get("domain") or "")
            }
            await context.close()
            if not guest_cookies:
                raise DouyinPublicError("抖音没有建立匿名访客会话，请稍后重试。")
            self._cookies = guest_cookies
            self._expires_at = monotonic() + self.SESSION_TTL_SECONDS
            logger.info("douyin_public_guest_ready cookie_count=%s", len(guest_cookies))
        except DouyinPublicError:
            raise
        except Exception as exc:
            logger.warning("douyin_public_guest_failed error=%s", str(exc)[:240])
            raise DouyinPublicError("服务器无法建立抖音匿名访客会话，请稍后重试。") from exc
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:  # noqa: BLE001
                    pass
            if playwright:
                try:
                    await playwright.stop()
                except Exception:  # noqa: BLE001
                    pass

    @staticmethod
    def _false_ms_token() -> str:
        return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(182)) + "=="

    def _stable_ms_token(self) -> str:
        if not self._ms_token:
            self._ms_token = self._false_ms_token()
        return self._ms_token

    @staticmethod
    def _as_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _as_bool(value: Any) -> bool:
        try:
            return bool(int(value))
        except (TypeError, ValueError):
            return bool(value)
