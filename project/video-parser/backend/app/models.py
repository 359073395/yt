from enum import StrEnum
from pathlib import Path
from time import time
from typing import Any

from pydantic import BaseModel, Field


class JobStatus(StrEnum):
    queued = "queued"
    parsing = "parsing"
    downloading = "downloading"
    merging = "merging"
    completed = "completed"
    failed = "failed"
    expired = "expired"


class JobCreateRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


class JobCreateResponse(BaseModel):
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


class AuthResponse(BaseModel):
    token: str
    user: UserPublic
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


class JobPublic(BaseModel):
    job_id: str
    url: str
    status: JobStatus
    title: str | None = None
    extractor: str | None = None
    platform: str | None = None
    thumbnail: str | None = None
    duration: float | None = None
    size_bytes: int | None = None
    downloaded_bytes: int = 0
    total_bytes: int | None = None
    progress: float = 0
    filename: str | None = None
    download_url: str | None = None
    error: str | None = None
    created_at: float
    updated_at: float
    expires_at: float | None = None


class Job:
    def __init__(self, job_id: str, url: str, client_ip: str, ttl_seconds: int) -> None:
        now = time()
        self.job_id = job_id
        self.url = url
        self.client_ip = client_ip
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
        self.filename: str | None = None
        self.file_path: Path | None = None
        self.error: str | None = None
        self.created_at = now
        self.updated_at = now
        self.expires_at: float | None = now + ttl_seconds

    def touch(self) -> None:
        self.updated_at = time()

    def update_from_info(self, info: dict[str, Any]) -> None:
        self.title = info.get("title") or self.title
        self.extractor = info.get("extractor_key") or info.get("extractor") or self.extractor
        self.platform = self.extractor or self.platform
        self.thumbnail = info.get("thumbnail") or self.thumbnail
        self.duration = info.get("duration") or self.duration
        self.size_bytes = (
            info.get("filesize")
            or info.get("filesize_approx")
            or self.size_bytes
        )
        self.touch()

    def public(self) -> JobPublic:
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
            filename=self.filename,
            download_url=f"/api/jobs/{self.job_id}/download" if self.file_path else None,
            error=self.error,
            created_at=self.created_at,
            updated_at=self.updated_at,
            expires_at=self.expires_at,
        )
