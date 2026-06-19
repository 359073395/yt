import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .auth import AuthStore
from .config import get_settings
from .downloader import Downloader
from .models import (
    AdminUserCreate,
    AdminUserUpdate,
    AdminOverview,
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    ApiKeyPublic,
    ApiKeyUpdateRequest,
    AuthRequest,
    AuthResponse,
    JobCreateRequest,
    JobCreateResponse,
    JobPublic,
    JobStatus,
    MeResponse,
    PlatformItem,
    PlatformsResponse,
    QuotaPublic,
    UserPublic,
)
from .security import RateLimiter, client_ip_from_request, validate_public_url
from .store import JobStore

settings = get_settings()
store = JobStore(settings.download_dir, settings.job_ttl_seconds)
rate_limiter = RateLimiter(settings.rate_limit_per_minute)
downloader = Downloader(settings, store)
auth_store = AuthStore(
    database_path=settings.database_path,
    secret=settings.auth_secret,
    guest_daily_limit=settings.guest_daily_limit,
    user_daily_limit=settings.user_daily_limit,
    admin_username=settings.admin_username,
    admin_password=settings.admin_password,
)

SUPPORTED_PLATFORMS = [
    PlatformItem(name="YouTube", extractor="youtube", region="international", status="supported"),
    PlatformItem(name="TikTok", extractor="TikTok", region="international", status="supported"),
    PlatformItem(name="Instagram", extractor="Instagram", region="international", status="supported"),
    PlatformItem(name="Facebook", extractor="Facebook", region="international", status="supported"),
    PlatformItem(name="X / Twitter", extractor="Twitter", region="international", status="supported"),
    PlatformItem(name="Vimeo", extractor="Vimeo", region="international", status="supported"),
    PlatformItem(name="SoundCloud", extractor="SoundCloud", region="international", status="supported"),
    PlatformItem(name="Reddit", extractor="Reddit", region="international", status="supported"),
    PlatformItem(name="Twitch", extractor="Twitch", region="international", status="supported"),
    PlatformItem(name="Dailymotion", extractor="Dailymotion", region="international", status="supported"),
    PlatformItem(name="Rumble", extractor="Rumble", region="international", status="supported"),
    PlatformItem(name="抖音", extractor="Douyin", region="china", status="supported"),
    PlatformItem(name="小红书", extractor="XiaoHongShu", region="china", status="supported"),
    PlatformItem(name="哔哩哔哩", extractor="BiliBili", region="china", status="supported"),
    PlatformItem(name="微博", extractor="Weibo", region="china", status="supported"),
    PlatformItem(name="AcFun", extractor="AcFunVideo", region="china", status="supported"),
    PlatformItem(name="优酷", extractor="youku", region="china", status="supported"),
    PlatformItem(name="爱奇艺", extractor="iqiyi", region="china", status="supported"),
    PlatformItem(name="腾讯视频", extractor="vqq", region="china", status="supported"),
    PlatformItem(name="百度视频", extractor="BaiduVideo", region="china", status="supported"),
    PlatformItem(name="斗鱼", extractor="DouyuTV", region="china", status="supported"),
    PlatformItem(name="虎牙", extractor="huya", region="china", status="supported"),
    PlatformItem(name="QQ 音乐 MV", extractor="qqmusic:mv", region="china", status="supported"),
    PlatformItem(name="网易 MV", extractor="netease:mv", region="china", status="supported"),
]

EXPERIMENTAL_PLATFORMS = [
    PlatformItem(name="快手", extractor=None, region="china", status="experimental", note="当前 yt-dlp extractor 列表未显示明确支持，会尝试通用解析。"),
    PlatformItem(name="Shopee", extractor=None, region="international", status="experimental", note="商品页暂不保证。"),
    PlatformItem(name="TikTok Shop", extractor=None, region="international", status="experimental", note="商品页暂不保证。"),
]


async def cleanup_loop() -> None:
    while True:
        store.cleanup()
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.download_dir.mkdir(parents=True, exist_ok=True)
    cleanup_task = asyncio.create_task(cleanup_loop())
    yield
    cleanup_task.cancel()


app = FastAPI(title="影链工坊", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/register", response_model=AuthResponse)
async def register(payload: AuthRequest, request: Request) -> AuthResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    user = auth_store.create_user(payload.username, payload.password)
    return AuthResponse(
        token=auth_store.create_token(user),
        user=auth_store.user_public(user),
        quota=auth_store.quota_for(user, client_ip),
    )


@app.post("/api/auth/login", response_model=AuthResponse)
async def login(payload: AuthRequest, request: Request) -> AuthResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    user = auth_store.authenticate(payload.username, payload.password)
    return AuthResponse(
        token=auth_store.create_token(user),
        user=auth_store.user_public(user),
        quota=auth_store.quota_for(user, client_ip),
    )


@app.get("/api/me", response_model=MeResponse)
async def me(request: Request) -> MeResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    user = auth_store.user_from_request(request)
    return MeResponse(
        user=auth_store.user_public(user) if user else None,
        quota=auth_store.quota_for(user, client_ip),
    )


@app.get("/api/admin/users", response_model=list[UserPublic])
async def list_users(request: Request) -> list[UserPublic]:
    auth_store.require_admin(request)
    return auth_store.list_users()


@app.post("/api/admin/users", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_admin_user(payload: AdminUserCreate, request: Request) -> UserPublic:
    auth_store.require_admin(request)
    user = auth_store.create_user(
        payload.username,
        payload.password,
        role=payload.role,
        user_status=payload.status,
        member_expires_at=payload.member_expires_at,
        daily_limit_override=payload.daily_limit_override,
    )
    return auth_store.user_public(user)


@app.patch("/api/admin/users/{user_id}", response_model=UserPublic)
async def update_user(user_id: int, payload: AdminUserUpdate, request: Request) -> UserPublic:
    auth_store.require_admin(request)
    fields = payload.model_fields_set
    return auth_store.update_user(
        user_id,
        role=payload.role,
        user_status=payload.status,
        member_expires_at=payload.member_expires_at,
        daily_limit_override=payload.daily_limit_override,
        daily_used=payload.daily_used,
        set_member_expires_at="member_expires_at" in fields,
        set_daily_limit_override="daily_limit_override" in fields,
    )


@app.delete("/api/admin/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: int, request: Request) -> None:
    admin = auth_store.require_admin(request)
    auth_store.delete_user(user_id, admin.id)


@app.get("/api/admin/overview", response_model=AdminOverview)
async def admin_overview(request: Request) -> AdminOverview:
    auth_store.require_admin(request)
    return AdminOverview(**auth_store.admin_counts(), **store.stats())


@app.get("/api/admin/jobs", response_model=list[JobPublic])
async def admin_jobs(request: Request) -> list[JobPublic]:
    auth_store.require_admin(request)
    return store.list_public()


@app.post("/api/admin/cleanup")
async def admin_cleanup(request: Request) -> dict[str, int]:
    auth_store.require_admin(request)
    removed = store.cleanup()
    return {"removed": removed, "storage_bytes": store.storage_bytes()}


@app.get("/api/admin/api-keys", response_model=list[ApiKeyPublic])
async def list_api_keys(request: Request) -> list[ApiKeyPublic]:
    auth_store.require_admin(request)
    return auth_store.list_api_keys()


@app.post("/api/admin/api-keys", response_model=ApiKeyCreateResponse)
async def create_api_key(payload: ApiKeyCreateRequest, request: Request) -> ApiKeyCreateResponse:
    auth_store.require_admin(request)
    return auth_store.create_api_key(payload.name, payload.daily_limit, payload.scopes)


@app.patch("/api/admin/api-keys/{api_key_id}", response_model=ApiKeyPublic)
async def update_api_key(api_key_id: int, payload: ApiKeyUpdateRequest, request: Request) -> ApiKeyPublic:
    auth_store.require_admin(request)
    return auth_store.update_api_key(
        api_key_id,
        name=payload.name,
        key_status=payload.status,
        daily_limit=payload.daily_limit,
        scopes=payload.scopes,
    )


@app.delete("/api/admin/api-keys/{api_key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_api_key(api_key_id: int, request: Request) -> None:
    auth_store.require_admin(request)
    auth_store.delete_api_key(api_key_id)


@app.post("/api/jobs", response_model=JobCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_job(payload: JobCreateRequest, request: Request) -> JobCreateResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    user = auth_store.user_from_request(request)
    rate_limiter.check(client_ip)
    url = validate_public_url(payload.url)
    auth_store.consume_quota(user, client_ip)
    job = store.create(url, client_ip)
    asyncio.create_task(downloader.run(job))
    return JobCreateResponse(job_id=job.job_id)


@app.get("/api/v1/platforms", response_model=PlatformsResponse)
async def v1_platforms() -> PlatformsResponse:
    return PlatformsResponse(supported=SUPPORTED_PLATFORMS, experimental=EXPERIMENTAL_PLATFORMS)


@app.get("/api/v1/quota", response_model=QuotaPublic)
async def v1_quota(request: Request) -> QuotaPublic:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    api_key = auth_store.api_key_from_request(request, client_ip)
    return auth_store.quota_for_api_key(api_key)


@app.post("/api/v1/jobs", response_model=JobCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def v1_create_job(payload: JobCreateRequest, request: Request) -> JobCreateResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    api_key = auth_store.api_key_from_request(request, client_ip)
    auth_store.require_api_scope(api_key, "jobs:create")
    rate_limiter.check(f"api:{api_key.id}")
    url = validate_public_url(payload.url)
    auth_store.consume_api_quota(api_key)
    job = store.create(url, client_ip)
    asyncio.create_task(downloader.run(job))
    return JobCreateResponse(job_id=job.job_id)


@app.get("/api/v1/jobs/{job_id}", response_model=JobPublic)
async def v1_get_job(job_id: str, request: Request) -> JobPublic:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    api_key = auth_store.api_key_from_request(request, client_ip)
    auth_store.require_api_scope(api_key, "jobs:read")
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在。")
    return job.public()


@app.get("/api/v1/jobs/{job_id}/download")
async def v1_download_job(job_id: str, request: Request) -> FileResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    api_key = auth_store.api_key_from_request(request, client_ip)
    auth_store.require_api_scope(api_key, "files:download")
    return _download_job_response(job_id)


@app.get("/api/v1/openapi.json")
async def v1_openapi() -> dict:
    return app.openapi()


@app.get("/api/jobs/{job_id}", response_model=JobPublic)
async def get_job(job_id: str) -> JobPublic:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在。")
    return job.public()


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str) -> FileResponse:
    return _download_job_response(job_id)


def _download_job_response(job_id: str) -> FileResponse:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在。")
    if job.status == JobStatus.expired:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="文件已过期。")
    if job.status != JobStatus.completed or not job.file_path:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成。")
    if not job.file_path.exists():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="文件已被清理。")
    return FileResponse(
        path=job.file_path,
        filename=job.filename or job.file_path.name,
        media_type="application/octet-stream",
    )


static_dir = Path(settings.static_dir)
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
