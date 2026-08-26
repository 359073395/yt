from __future__ import annotations

import base64
import hashlib
import hmac
from dataclasses import dataclass
from time import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import HTTPException

from .security import validate_public_url


ASSET_TOKEN_TTL_SECONDS = 15 * 60
ASSET_SOURCE_MAX_LENGTH = 8192
ASSET_LIMITS = {"cover": 12 * 1024 * 1024, "subtitle": 5 * 1024 * 1024}
COVER_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
}
SUBTITLE_TYPES = {
    "text/vtt": "vtt",
    "application/x-subrip": "srt",
    "application/ttml+xml": "ttml",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/json": "json",
    "text/plain": "txt",
    "application/octet-stream": "vtt",
}


class RemoteAssetError(ValueError):
    pass


@dataclass(frozen=True)
class RemoteAsset:
    data: bytes
    content_type: str
    filename: str


def signed_asset_url(source_url: str, kind: str, secret: str, *, download: bool = True) -> str:
    if kind not in ASSET_LIMITS or not source_url or len(source_url) > ASSET_SOURCE_MAX_LENGTH:
        raise RemoteAssetError("资源地址无效。")
    parsed = urlsplit(source_url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise RemoteAssetError("资源地址无效。")
    encoded = base64.urlsafe_b64encode(source_url.encode("utf-8")).decode("ascii").rstrip("=")
    expires = int(time()) + ASSET_TOKEN_TTL_SECONDS
    signature = _signature(kind, encoded, expires, secret)
    disposition = "1" if download else "0"
    return f"/api/assets/{kind}?source={encoded}&expires={expires}&signature={signature}&download={disposition}"


def verify_asset_token(kind: str, source: str, expires: int, signature: str, secret: str) -> str:
    if kind not in ASSET_LIMITS or len(source) > ASSET_SOURCE_MAX_LENGTH * 2:
        raise RemoteAssetError("资源令牌无效。")
    if expires < int(time()):
        raise RemoteAssetError("资源链接已过期，请重新解析。")
    expected = _signature(kind, source, expires, secret)
    if not hmac.compare_digest(signature, expected):
        raise RemoteAssetError("资源签名无效。")
    try:
        padding = "=" * (-len(source) % 4)
        url = base64.urlsafe_b64decode(source + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise RemoteAssetError("资源令牌无效。") from exc
    if len(url) > ASSET_SOURCE_MAX_LENGTH:
        raise RemoteAssetError("资源地址过长。")
    return _validate_remote_url(url)


def fetch_remote_asset(source_url: str, kind: str) -> RemoteAsset:
    if kind not in ASSET_LIMITS:
        raise RemoteAssetError("不支持的资源类型。")
    source_url = _validate_remote_url(source_url)
    opener = build_opener(_ValidatingRedirectHandler())
    parsed = urlsplit(source_url)
    request = Request(
        source_url,
        headers={
            "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" if kind == "cover" else "text/vtt,text/plain,application/xml,application/json,*/*;q=0.5",
            "Referer": f"{parsed.scheme}://{parsed.netloc}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36",
        },
    )
    try:
        with opener.open(request, timeout=20) as response:  # noqa: S310
            content_length = response.headers.get("Content-Length")
            limit = ASSET_LIMITS[kind]
            if content_length and int(content_length) > limit:
                raise RemoteAssetError("远程资源超过大小限制。")
            data = response.read(limit + 1)
            content_type = str(response.headers.get_content_type()).lower()
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        if isinstance(exc, RemoteAssetError):
            raise
        raise RemoteAssetError("远程资源暂时无法读取。") from exc
    if len(data) > ASSET_LIMITS[kind]:
        raise RemoteAssetError("远程资源超过大小限制。")
    extension = _extension_for(kind, content_type, source_url)
    return RemoteAsset(data=data, content_type=content_type, filename=f"{kind}.{extension}")


def _signature(kind: str, source: str, expires: int, secret: str) -> str:
    payload = f"{kind}:{expires}:{source}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _validate_remote_url(url: str) -> str:
    if not url.lower().startswith("https://"):
        raise RemoteAssetError("只允许读取 HTTPS 资源。")
    try:
        return validate_public_url(url)
    except HTTPException as exc:
        raise RemoteAssetError("远程资源地址不安全。") from exc


def _extension_for(kind: str, content_type: str, source_url: str) -> str:
    if kind == "cover":
        extension = COVER_TYPES.get(content_type)
        if not extension:
            raise RemoteAssetError("远程资源不是受支持的图片。")
        return extension
    extension = SUBTITLE_TYPES.get(content_type)
    if extension:
        return extension
    suffix = urlsplit(source_url).path.rsplit(".", 1)[-1].lower()
    if suffix in {"vtt", "srt", "ass", "ssa", "ttml", "xml", "json", "json3"}:
        return suffix
    raise RemoteAssetError("远程资源不是受支持的字幕。")


class _ValidatingRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        _validate_remote_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)
