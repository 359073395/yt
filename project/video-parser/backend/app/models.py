from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from time import time
from typing import Any, Callable

from pydantic import BaseModel, Field, field_validator, model_validator


class JobStatus(StrEnum):
    queued = "queued"
    parsing = "parsing"
    downloading = "downloading"
    merging = "merging"
    transcribing = "transcribing"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"
    expired = "expired"


class MediaType(StrEnum):
    video = "video"
    audio = "audio"
    transcript = "transcript"


class TranscriptMode(StrEnum):
    none = "none"
    native = "native"
    ai = "ai"
    auto = "auto"


class TranscriptFormat(StrEnum):
    txt = "txt"
    srt = "srt"
    vtt = "vtt"


class QrLoginStatus(StrEnum):
    starting = "starting"
    waiting = "waiting"
    scanned = "scanned"
    completed = "completed"
    failed = "failed"
    expired = "expired"
    cancelled = "cancelled"


class ParseRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    cookie_profile: str | None = Field(default=None, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")


class FormatOption(BaseModel):
    format_id: str
    label: str
    ext: str | None = None
    resolution: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    filesize: int | None = None
    vcodec: str | None = None
    acodec: str | None = None
    has_video: bool = False
    has_audio: bool = False


class SubtitleOption(BaseModel):
    language: str
    label: str
    automatic: bool = False
    ext: str | None = None
    download_url: str | None = None


class ParseResponse(BaseModel):
    url: str
    title: str
    extractor: str | None = None
    platform: str | None = None
    thumbnail: str | None = None
    thumbnail_proxy_url: str | None = None
    thumbnail_download_url: str | None = None
    duration: float | None = None
    uploader: str | None = None
    description: str | None = None
    formats: list[FormatOption]
    subtitles: list[SubtitleOption]
    subtitle_note: str | None = None
    ai_transcription_available: bool = False


class CollectionInspectRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    max_items: int = Field(default=20, ge=1, le=50)
    cookie_profile: str | None = Field(default=None, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")


class CollectionItem(BaseModel):
    url: str
    title: str
    thumbnail: str | None = None
    thumbnail_proxy_url: str | None = None
    duration: float | None = None
    uploader: str | None = None


class CollectionInspectResponse(BaseModel):
    source_url: str
    title: str
    extractor: str | None = None
    total_count: int | None = None
    items: list[CollectionItem]
    truncated: bool = False


class JobCreateRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    media_type: MediaType = MediaType.video
    format_id: str = Field(default="best", min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    format_has_audio: bool = False
    audio_format: str = Field(default="mp3", pattern=r"^(mp3|m4a|opus|wav|flac)$")
    subtitle_language: str | None = Field(default=None, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    transcript_mode: TranscriptMode = TranscriptMode.none
    transcript_format: TranscriptFormat = TranscriptFormat.srt
    transcript_language: str | None = Field(default=None, max_length=16, pattern=r"^[a-zA-Z0-9_.-]+$")
    include_description: bool = False
    include_thumbnail: bool = False
    cookie_profile: str | None = Field(default=None, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")

    @model_validator(mode="after")
    def normalize_transcript_job(self) -> "JobCreateRequest":
        if self.media_type == MediaType.transcript and self.transcript_mode == TranscriptMode.none:
            self.transcript_mode = TranscriptMode.auto
        return self


class JobCreateResponse(BaseModel):
    job_id: str


class BatchJobCreateRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=50)
    media_type: MediaType = MediaType.video
    audio_format: str = Field(default="mp3", pattern=r"^(mp3|m4a|opus|wav|flac)$")
    transcript_mode: TranscriptMode = TranscriptMode.none
    transcript_format: TranscriptFormat = TranscriptFormat.srt
    transcript_language: str | None = Field(default=None, max_length=16, pattern=r"^[a-zA-Z0-9_.-]+$")
    include_description: bool = False
    include_thumbnail: bool = False
    cookie_profile: str | None = Field(default=None, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")

    @field_validator("urls")
    @classmethod
    def normalize_urls(cls, urls: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_url in urls:
            url = raw_url.strip()
            if len(url) < 8 or len(url) > 2048:
                raise ValueError("每条链接长度必须在 8 到 2048 个字符之间")
            if url not in seen:
                normalized.append(url)
                seen.add(url)
        if not normalized:
            raise ValueError("请至少提交一条链接")
        return normalized


class BatchJobItemResponse(BaseModel):
    url: str
    job_id: str


class AuthRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_@.-]+$")
    password: str = Field(min_length=8, max_length=128)


class UserPublic(BaseModel):
    id: int
    username: str
    role: str
    created_at: float
    status: str = "active"
    member_expires_at: float | None = None
    daily_limit_override: int | None = None
    daily_used: int = 0
    daily_limit: int | None = None
    unlimited: bool = False


class QuotaPublic(BaseModel):
    limit: int | None
    used: int
    remaining: int | None
    unlimited: bool


class BatchJobCreateResponse(BaseModel):
    jobs: list[BatchJobItemResponse]
    quota: QuotaPublic


class AuthResponse(BaseModel):
    token: str
    user: UserPublic
    quota: QuotaPublic


class BrowserSessionResponse(BaseModel):
    token: str
    quota: QuotaPublic


class MeResponse(BaseModel):
    user: UserPublic | None
    quota: QuotaPublic


class AdminUserUpdate(BaseModel):
    role: str | None = Field(default=None, pattern=r"^(user|member|admin)$")
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    member_expires_at: float | None = None
    daily_limit_override: int | None = Field(default=None, ge=0, le=100000)
    daily_used: int | None = Field(default=None, ge=0, le=100000)


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_@.-]+$")
    password: str = Field(min_length=8, max_length=128)
    role: str = Field(default="user", pattern=r"^(user|member|admin)$")
    status: str = Field(default="active", pattern=r"^(active|disabled)$")
    member_expires_at: float | None = None
    daily_limit_override: int | None = Field(default=None, ge=0, le=100000)


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    daily_limit: int | None = Field(default=None, ge=1, le=100000)
    scopes: list[str] = Field(default_factory=lambda: ["jobs:create", "jobs:read", "files:download"])


class ApiKeyUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    daily_limit: int | None = Field(default=None, ge=1, le=100000)
    scopes: list[str] | None = None


class ApiKeyPublic(BaseModel):
    id: int
    name: str
    prefix: str
    status: str
    scopes: list[str]
    daily_limit: int | None = None
    daily_used: int = 0
    created_at: float
    last_used_at: float | None = None
    last_used_ip: str | None = None


class ApiKeyCreateResponse(BaseModel):
    key: str
    item: ApiKeyPublic


class AdminOverview(BaseModel):
    users_total: int
    users_regular: int
    users_member: int
    users_admin: int
    users_disabled: int
    api_keys_total: int
    api_keys_active: int
    today_downloads: int
    jobs_total: int
    jobs_running: int
    jobs_completed: int
    jobs_failed: int
    storage_bytes: int


class PlatformItem(BaseModel):
    name: str
    extractor: str | None = None
    region: str
    status: str
    note: str | None = None


class PlatformsResponse(BaseModel):
    supported: list[PlatformItem]
    experimental: list[PlatformItem]


class CookieProfilePublic(BaseModel):
    name: str
    size_bytes: int
    updated_at: float
    cookie_count: int = 0
    domains: list[str] = Field(default_factory=list)
    expires_at: float | None = None
    expired: bool = False
    scope: str = "global"


class QrLoginPublic(BaseModel):
    session_id: str
    platform: str
    status: QrLoginStatus
    created_at: float
    expires_at: float
    message: str
    qr_ready: bool = False
    qr_revision: str | None = None
    profile: CookieProfilePublic | None = None


class JobPublic(BaseModel):
    job_id: str
    url: str
    status: JobStatus
    title: str | None = None
    extractor: str | None = None
    platform: str | None = None
    thumbnail: str | None = None
    thumbnail_proxy_url: str | None = None
    thumbnail_download_url: str | None = None
    duration: float | None = None
    size_bytes: int | None = None
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    progress: float = 0
    speed: float | None = None
    eta: int | None = None
    media_type: MediaType = MediaType.video
    format_id: str = "best"
    audio_format: str = "mp3"
    subtitle_language: str | None = None
    transcript_mode: TranscriptMode = TranscriptMode.none
    transcript_format: TranscriptFormat = TranscriptFormat.srt
    transcript_language: str | None = None
    include_description: bool = False
    include_thumbnail: bool = False
    filename: str | None = None
    download_url: str | None = None
    error: str | None = None
    created_at: float
    updated_at: float
    expires_at: float | None = None
    can_cancel: bool = False
    can_retry: bool = False


class Job:
    def __init__(
        self,
        job_id: str,
        url: str,
        client_ip: str,
        ttl_seconds: int,
        *,
        user_id: int | None = None,
        media_type: MediaType = MediaType.video,
        format_id: str = "best",
        format_has_audio: bool = False,
        audio_format: str = "mp3",
        subtitle_language: str | None = None,
        transcript_mode: TranscriptMode = TranscriptMode.none,
        transcript_format: TranscriptFormat = TranscriptFormat.srt,
        transcript_language: str | None = None,
        include_description: bool = False,
        include_thumbnail: bool = False,
        cookie_profile: str | None = None,
        created_at: float | None = None,
        persist: Callable[["Job"], None] | None = None,
    ) -> None:
        now = created_at or time()
        self.job_id = job_id
        self.url = url
        self.client_ip = client_ip
        self.user_id = user_id
        self.status = JobStatus.queued
        self.title: str | None = None
        self.extractor: str | None = None
        self.platform: str | None = None
        self.thumbnail: str | None = None
        self.duration: float | None = None
        self.size_bytes: int | None = None
        self.downloaded_bytes = 0
        self.total_bytes: int | None = None
        self.progress = 0.0
        self.speed: float | None = None
        self.eta: int | None = None
        self.media_type = media_type
        self.format_id = format_id
        self.format_has_audio = format_has_audio
        self.audio_format = audio_format
        self.subtitle_language = subtitle_language
        self.transcript_mode = transcript_mode
        self.transcript_format = transcript_format
        self.transcript_language = transcript_language
        self.include_description = include_description
        self.include_thumbnail = include_thumbnail
        self.cookie_profile = cookie_profile
        self.filename: str | None = None
        self.file_path: Path | None = None
        self.error: str | None = None
        self.created_at = now
        self.updated_at = now
        self.expires_at: float | None = now + ttl_seconds
        self._persist = persist

    def touch(self, persist: bool = False) -> None:
        self.updated_at = time()
        if persist and self._persist:
            self._persist(self)

    def update_from_info(self, info: dict[str, Any]) -> None:
        self.title = info.get("title") or self.title
        self.extractor = info.get("extractor_key") or info.get("extractor") or self.extractor
        self.platform = self.extractor or self.platform
        self.thumbnail = info.get("thumbnail") or self.thumbnail
        self.duration = info.get("duration") or self.duration
        self.size_bytes = info.get("filesize") or info.get("filesize_approx") or self.size_bytes
        self.touch()

    def public(self) -> JobPublic:
        active = self.status in {JobStatus.queued, JobStatus.parsing, JobStatus.downloading, JobStatus.transcribing, JobStatus.merging}
        return JobPublic(
            job_id=self.job_id,
            url=self.url,
            status=self.status,
            title=self.title,
            extractor=self.extractor,
            platform=self.platform,
            thumbnail=self.thumbnail,
            duration=self.duration,
            size_bytes=self.size_bytes,
            downloaded_bytes=self.downloaded_bytes,
            total_bytes=self.total_bytes,
            progress=round(self.progress, 2),
            speed=self.speed,
            eta=self.eta,
            media_type=self.media_type,
            format_id=self.format_id,
            audio_format=self.audio_format,
            subtitle_language=self.subtitle_language,
            transcript_mode=self.transcript_mode,
            transcript_format=self.transcript_format,
            transcript_language=self.transcript_language,
            include_description=self.include_description,
            include_thumbnail=self.include_thumbnail,
            filename=self.filename,
            download_url=f"/api/jobs/{self.job_id}/download" if self.file_path else None,
            error=self.error,
            created_at=self.created_at,
            updated_at=self.updated_at,
            expires_at=self.expires_at,
            can_cancel=active,
            can_retry=self.status in {JobStatus.failed, JobStatus.cancelled, JobStatus.expired},
        )
