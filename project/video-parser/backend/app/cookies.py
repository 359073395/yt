from __future__ import annotations

import base64
import hashlib
import os
import re
import shutil
from contextlib import contextmanager
from pathlib import Path
from time import time
from typing import Any, Iterator

from cryptography.fernet import Fernet, InvalidToken

from .models import CookieProfilePublic


PROFILE_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")
MAX_COOKIE_BYTES = 2 * 1024 * 1024
PLATFORM_DOMAINS: dict[str, tuple[str, ...]] = {
    "douyin": ("douyin.com", "douyinvod.com", "douyinpic.com", "byteimg.com", "bytedance.com"),
    "tiktok": ("tiktok.com", "tiktokv.com", "tiktokcdn.com", "byteoversea.com", "ibytedtos.com"),
    "youtube": ("youtube.com", "google.com", "googlevideo.com", "youtu.be"),
    "bilibili": ("bilibili.com", "bilivideo.com", "hdslb.com"),
    "instagram": ("instagram.com", "cdninstagram.com"),
    "facebook": ("facebook.com", "fbcdn.net"),
    "twitter": ("x.com", "twitter.com", "twimg.com"),
}


class CookieStore:
    """Encrypted Netscape cookie profiles used by yt-dlp and Chromium.

    Legacy global profiles keep their original paths for API compatibility.
    Browser profiles are stored below ``users/<id>`` and never fall back to a
    global account, so one visitor cannot silently use another account.
    """

    def __init__(self, directory: Path, secret: str) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(f"yinglian-cookie:{secret}".encode()).digest()
        self.fernet = Fernet(base64.urlsafe_b64encode(digest))

    def _profile_dir(self, owner_id: int | None) -> Path:
        if owner_id is None:
            return self.directory
        if owner_id <= 0:
            raise ValueError("Cookie 用户标识无效。")
        return self.directory / "users" / str(owner_id)

    def _path(self, name: str, owner_id: int | None = None) -> Path:
        if not PROFILE_RE.fullmatch(name):
            raise ValueError("Cookie 配置名称只能包含字母、数字、点、下划线和短横线。")
        return self._profile_dir(owner_id) / f"{name}.cookies.enc"

    def list(self, owner_id: int | None = None) -> list[CookieProfilePublic]:
        profile_dir = self._profile_dir(owner_id)
        if not profile_dir.exists():
            return []
        items: list[CookieProfilePublic] = []
        for path in sorted(profile_dir.glob("*.cookies.enc")):
            name = path.name.removesuffix(".cookies.enc")
            try:
                content = self.fernet.decrypt(path.read_bytes())
                count, domains, expires_at, expired = self._inspect_content(content)
            except (InvalidToken, OSError, ValueError):
                count, domains, expires_at, expired = 0, [], None, True
            stat = path.stat()
            items.append(
                CookieProfilePublic(
                    name=name,
                    size_bytes=stat.st_size,
                    updated_at=stat.st_mtime,
                    cookie_count=count,
                    domains=domains,
                    expires_at=expires_at,
                    expired=expired,
                    scope="user" if owner_id is not None else "global",
                )
            )
        return items

    def save(
        self,
        name: str,
        content: bytes,
        *,
        owner_id: int | None = None,
        platform: str | None = None,
    ) -> CookieProfilePublic:
        if not content or len(content) > MAX_COOKIE_BYTES:
            raise ValueError("Cookie 文件必须小于 2 MB 且不能为空。")
        filtered = self._normalize_content(content, platform)
        count, domains, expires_at, expired = self._inspect_content(filtered)
        if count == 0:
            raise ValueError("Cookie 文件中没有找到该平台的有效条目。")
        path = self._path(name, owner_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.fernet.encrypt(filtered))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        stat = path.stat()
        return CookieProfilePublic(
            name=name,
            size_bytes=stat.st_size,
            updated_at=time(),
            cookie_count=count,
            domains=domains,
            expires_at=expires_at,
            expired=expired,
            scope="user" if owner_id is not None else "global",
        )

    def delete(self, name: str, owner_id: int | None = None) -> None:
        self._path(name, owner_id).unlink(missing_ok=True)

    def delete_owner(self, owner_id: int) -> None:
        profile_dir = self._profile_dir(owner_id)
        if profile_dir.resolve().parent == (self.directory / "users").resolve():
            shutil.rmtree(profile_dir, ignore_errors=True)

    def exists(self, name: str | None, owner_id: int | None = None) -> bool:
        if not name:
            return False
        return self._path(name, owner_id).exists()

    @staticmethod
    def browser_cookies_to_netscape(cookies: list[dict[str, Any]]) -> bytes:
        """Convert Playwright cookies without exposing them outside the server."""
        lines = ["# Netscape HTTP Cookie File"]
        for cookie in cookies:
            name = str(cookie.get("name") or "").replace("\t", "").replace("\r", "").replace("\n", "")
            value = str(cookie.get("value") or "").replace("\t", "").replace("\r", "").replace("\n", "")
            domain = str(cookie.get("domain") or "").strip().lower()
            path = str(cookie.get("path") or "/").replace("\t", "").replace("\r", "").replace("\n", "") or "/"
            if not name or not domain:
                continue
            include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
            secure = "TRUE" if cookie.get("secure") else "FALSE"
            try:
                expires = int(float(cookie.get("expires") or 0))
            except (TypeError, ValueError):
                expires = 0
            if expires < 0:
                expires = 0
            stored_domain = f"#HttpOnly_{domain}" if cookie.get("httpOnly") else domain
            lines.append(
                "\t".join((stored_domain, include_subdomains, path, secure, str(expires), name, value))
            )
        return ("\n".join(lines) + "\n").encode("utf-8")

    @contextmanager
    def materialize(
        self,
        name: str | None,
        work_dir: Path,
        *,
        owner_id: int | None = None,
        platform: str | None = None,
    ) -> Iterator[Path | None]:
        candidates: list[Path] = []
        preferred = [name] if name else [platform, "default"]
        for candidate_name in preferred:
            if not candidate_name:
                continue
            candidates.append(self._path(candidate_name, owner_id))
        selected = next((path for path in candidates if path.exists()), None)
        if not selected:
            yield None
            return
        try:
            content = self.fernet.decrypt(selected.read_bytes())
        except InvalidToken as exc:
            raise ValueError("Cookie 配置无法解密，请重新上传。") from exc
        work_dir.mkdir(parents=True, exist_ok=True)
        temporary = work_dir / ".cookies.txt"
        temporary.write_bytes(content)
        try:
            os.chmod(temporary, 0o600)
            yield temporary
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _normalize_content(content: bytes, platform: str | None) -> bytes:
        text = content.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        lines = text.splitlines()
        if not lines or lines[0].strip() not in {"# Netscape HTTP Cookie File", "# HTTP Cookie File"}:
            raise ValueError("请上传 Netscape cookies.txt 文件，首行必须是标准格式声明。")
        allowed = PLATFORM_DOMAINS.get(platform or "")
        normalized = ["# Netscape HTTP Cookie File"]
        for line in lines[1:]:
            if not line.strip() or (line.startswith("#") and not line.startswith("#HttpOnly_")):
                continue
            fields = line.split("\t")
            if len(fields) != 7:
                continue
            domain = fields[0].removeprefix("#HttpOnly_").lstrip(".").lower()
            if allowed and not any(domain == suffix or domain.endswith(f".{suffix}") for suffix in allowed):
                continue
            normalized.append("\t".join(fields))
        return ("\n".join(normalized) + "\n").encode("utf-8")

    @staticmethod
    def _inspect_content(content: bytes) -> tuple[int, list[str], float | None, bool]:
        now = time()
        domains: set[str] = set()
        expirations: list[float] = []
        has_session_cookie = False
        count = 0
        for line in content.decode("utf-8", errors="replace").splitlines():
            if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
                continue
            fields = line.split("\t")
            if len(fields) != 7:
                continue
            count += 1
            domains.add(fields[0].removeprefix("#HttpOnly_").lstrip(".").lower())
            try:
                expires = float(fields[4])
            except ValueError:
                expires = 0
            if expires > 0:
                expirations.append(expires)
            else:
                has_session_cookie = True
        expires_at = max(expirations) if expirations else None
        expired = count == 0 or (not has_session_cookie and bool(expirations) and max(expirations) <= now)
        return count, sorted(domains)[:20], expires_at, expired
