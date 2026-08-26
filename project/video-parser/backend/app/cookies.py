import base64
import hashlib
import os
import re
from contextlib import contextmanager
from pathlib import Path
from time import time
from typing import Iterator

from cryptography.fernet import Fernet, InvalidToken

from .models import CookieProfilePublic


PROFILE_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")
MAX_COOKIE_BYTES = 2 * 1024 * 1024


class CookieStore:
    """Encrypted Netscape cookie profiles used by yt-dlp.

    The encryption key is derived from AUTH_SECRET, so profiles stay usable across
    container updates while the secret remains unchanged.
    """

    def __init__(self, directory: Path, secret: str) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(f"yinglian-cookie:{secret}".encode()).digest()
        self.fernet = Fernet(base64.urlsafe_b64encode(digest))

    def _path(self, name: str) -> Path:
        if not PROFILE_RE.fullmatch(name):
            raise ValueError("Cookie 配置名称只能包含字母、数字、点、下划线和短横线。")
        return self.directory / f"{name}.cookies.enc"

    def list(self) -> list[CookieProfilePublic]:
        items: list[CookieProfilePublic] = []
        for path in sorted(self.directory.glob("*.cookies.enc")):
            stat = path.stat()
            items.append(CookieProfilePublic(name=path.name.removesuffix(".cookies.enc"), size_bytes=stat.st_size, updated_at=stat.st_mtime))
        return items

    def save(self, name: str, content: bytes) -> CookieProfilePublic:
        if not content or len(content) > MAX_COOKIE_BYTES:
            raise ValueError("Cookie 文件必须小于 2 MB 且不能为空。")
        text = content.decode("utf-8", errors="replace")
        if "# Netscape HTTP Cookie File" not in text and not any("\t" in line for line in text.splitlines()):
            raise ValueError("请上传 Netscape cookies.txt 文件。")
        path = self._path(name)
        path.write_bytes(self.fernet.encrypt(content))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        stat = path.stat()
        return CookieProfilePublic(name=name, size_bytes=stat.st_size, updated_at=time())

    def delete(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)

    def exists(self, name: str | None) -> bool:
        return bool(name and self._path(name).exists())

    @contextmanager
    def materialize(self, name: str | None, work_dir: Path) -> Iterator[Path | None]:
        selected = name if name and self.exists(name) else "default" if self.exists("default") else None
        if not selected:
            yield None
            return
        encrypted = self._path(selected).read_bytes()
        try:
            content = self.fernet.decrypt(encrypted)
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
