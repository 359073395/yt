import asyncio
import hashlib
import hmac
import json
import logging
import shutil
from contextlib import asynccontextmanager, suppress
from importlib.util import find_spec
from pathlib import Path
from time import monotonic, time

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .assets import RemoteAssetError, fetch_remote_asset, signed_asset_url, verify_asset_token
from .auth import AuthStore, AuthUser
from .config import get_settings
from .downloader import DownloadRejected, Downloader
from .models import (
    BrowserSessionResponse,
    BatchJobCreateRequest,
    BatchJobCreateResponse,
    BatchJobItemResponse,
    CollectionInspectRequest,
    CollectionInspectResponse,
    Job,
    JobCreateRequest,
    JobCreateResponse,
    JobPublic,
    JobStatus,
    MeResponse,
    ParseRequest,
    ParseResponse,
    PlatformItem,
    PlatformsResponse,
    QuotaPublic,
)
from .security import RateLimiter, client_ip_from_request, validate_public_url
from .store import JobStore

logger = logging.getLogger(__name__)

settings = get_settings()
store = JobStore(settings.download_dir, settings.job_ttl_seconds, settings.database_path)
rate_limiter = RateLimiter(settings.rate_limit_per_minute)
downloader = Downloader(settings, store)
auth_store = AuthStore(
    database_path=settings.database_path,
    secret=settings.auth_secret,
    guest_daily_limit=settings.guest_daily_limit,
    user_daily_limit=settings.user_daily_limit,
)

SUPPORTED_PLATFORMS = [
    PlatformItem(name="YouTube", extractor="youtube", region="international", status="supported", note="仅处理公开可访问视频。"),
    PlatformItem(name="TikTok", extractor="TikTok", region="international", status="supported"),
    PlatformItem(name="Instagram", extractor="Instagram", region="international", status="supported", note="仅处理公开可访问内容。"),
    PlatformItem(name="Facebook", extractor="Facebook", region="international", status="supported", note="仅处理公开可访问内容。"),
    PlatformItem(name="X / Twitter", extractor="Twitter", region="international", status="supported"),
    PlatformItem(name="Vimeo", extractor="Vimeo", region="international", status="supported"),
    PlatformItem(name="SoundCloud", extractor="SoundCloud", region="international", status="supported"),
    PlatformItem(name="Reddit", extractor="Reddit", region="international", status="supported"),
    PlatformItem(name="Twitch", extractor="Twitch", region="international", status="supported"),
    PlatformItem(name="Dailymotion", extractor="Dailymotion", region="international", status="supported"),
    PlatformItem(name="抖音", extractor="DouyinPublic", region="china", status="supported", note="服务器自动建立匿名访客会话。"),
    PlatformItem(name="小红书", extractor="XiaoHongShu", region="china", status="supported", note="能力随 yt-dlp 提取器更新。"),
    PlatformItem(name="哔哩哔哩", extractor="BiliBili", region="china", status="supported", note="会员内容不在公开版支持范围。"),
    PlatformItem(name="微博", extractor="Weibo", region="china", status="supported"),
    PlatformItem(name="AcFun", extractor="AcFunVideo", region="china", status="supported"),
    PlatformItem(name="优酷", extractor="youku", region="china", status="supported"),
    PlatformItem(name="爱奇艺", extractor="iqiyi", region="china", status="supported"),
    PlatformItem(name="腾讯视频", extractor="vqq", region="china", status="supported"),
    PlatformItem(name="斗鱼", extractor="DouyuTV", region="china", status="supported"),
    PlatformItem(name="虎牙", extractor="huya", region="china", status="supported"),
]

EXPERIMENTAL_PLATFORMS = [
    PlatformItem(name="快手", extractor=None, region="china", status="experimental", note="尝试通用解析，不保证长期可用。"),
    PlatformItem(name="Shopee", extractor=None, region="international", status="experimental", note="商品页暂不保证。"),
    PlatformItem(name="TikTok Shop", extractor=None, region="international", status="experimental", note="商品页暂不保证。"),
]


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(60)
        store.cleanup()


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.download_dir.mkdir(parents=True, exist_ok=True)
    settings.whisper_cache_dir.mkdir(parents=True, exist_ok=True)
    cleanup_task = asyncio.create_task(cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task


app = FastAPI(title="影链工坊 2.5 公开版", version=settings.app_version, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def request_identity(request: Request) -> tuple[AuthUser | None, str]:
    return (
        auth_store.user_from_request(request),
        client_ip_from_request(request, settings.trusted_proxy_headers),
    )


def require_owned_job(job_id: str, request: Request) -> Job:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在。")
    user, client_ip = request_identity(request)
    if user and user.role == "admin":
        return job
    if not store.is_owner(job, user.id if user else None, client_ip):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权操作该任务。")
    return job


def signed_download_url(job: Job) -> str | None:
    if not job.file_path:
        return None
    expires = int(time()) + 15 * 60
    payload = f"{job.job_id}:{expires}".encode()
    signature = hmac.new(settings.auth_secret.encode(), payload, hashlib.sha256).hexdigest()
    return f"/api/jobs/{job.job_id}/download?expires={expires}&signature={signature}"


def public_job(job: Job) -> JobPublic:
    item = job.public()
    item.download_url = signed_download_url(job)
    if job.thumbnail:
        try:
            item.thumbnail_proxy_url = signed_asset_url(job.thumbnail, "cover", settings.auth_secret, download=False)
            item.thumbnail_download_url = signed_asset_url(job.thumbnail, "cover", settings.auth_secret, download=True)
        except RemoteAssetError:
            pass
    return item


def verify_download_signature(job_id: str, expires: int, signature: str) -> None:
    if expires < int(time()):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="下载链接已过期，请刷新任务后重试。")
    payload = f"{job_id}:{expires}".encode()
    expected = hmac.new(settings.auth_secret.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="下载链接签名无效。")


async def binary_version(binary: str, *arguments: str) -> str:
    path = shutil.which(binary)
    if not path:
        return "missing"
    try:
        process = await asyncio.create_subprocess_exec(path, *arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output, _ = await asyncio.wait_for(process.communicate(), timeout=3)
        return output.decode(errors="replace").splitlines()[0][:120]
    except Exception:  # noqa: BLE001
        return "unavailable"


@app.get("/api/health")
async def health() -> dict[str, object]:
    """Return a fast liveness response without loading native runtimes."""
    chromium = settings.chromium_path.strip() or shutil.which("chromium") or shutil.which("chromium-browser")
    transcription_available = settings.transcription_enabled and find_spec("faster_whisper") is not None
    return {
        "status": "ok",
        "version": settings.app_version,
        "engine_channel": settings.engine_channel,
        "components": {
            "yt_dlp": downloader.engine_version(),
            "deno": "available" if shutil.which("deno") else "missing",
            "ffmpeg": "available" if shutil.which("ffmpeg") else "missing",
            "chromium": "available" if chromium and Path(chromium).is_file() else "missing",
            "douyin_public_session": "available" if chromium and Path(chromium).is_file() else "missing",
            "transcription": "available" if transcription_available else "disabled",
        },
    }


@app.get("/api/diagnostics")
async def diagnostics() -> dict[str, object]:
    """Return detailed component versions for interactive troubleshooting."""
    chromium_binary = settings.chromium_path.strip() or shutil.which("chromium") or "chromium-browser"
    transcription_available = settings.transcription_enabled and find_spec("faster_whisper") is not None
    deno, ffmpeg, chromium = await asyncio.gather(
        binary_version("deno", "--version"),
        binary_version("ffmpeg", "-version"),
        binary_version(chromium_binary, "--version"),
    )
    return {
        "status": "ok",
        "version": settings.app_version,
        "engine_channel": settings.engine_channel,
        "components": {
            "yt_dlp": downloader.engine_version(),
            "deno": deno,
            "ffmpeg": ffmpeg,
            "chromium": chromium,
            "douyin_public_session": "available" if chromium != "missing" else "missing",
            "transcription": f"faster-whisper/{settings.whisper_model}" if transcription_available else "disabled",
        },
    }


@app.post("/api/browser-session", response_model=BrowserSessionResponse)
async def browser_session(request: Request) -> BrowserSessionResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    header = request.headers.get("authorization", "")
    current_token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    current_user = auth_store.user_from_token(current_token) if current_token else None
    if current_user and current_user.role == "browser":
        return BrowserSessionResponse(token=current_token, quota=auth_store.quota_for(current_user, client_ip))
    token, browser = auth_store.create_browser_token()
    return BrowserSessionResponse(token=token, quota=auth_store.quota_for(browser, client_ip))


@app.get("/api/me", response_model=MeResponse)
async def me(request: Request) -> MeResponse:
    user, client_ip = request_identity(request)
    return MeResponse(user=auth_store.user_public(user) if user else None, quota=auth_store.quota_for(user, client_ip))


@app.post("/api/parse", response_model=ParseResponse)
async def parse_video(payload: ParseRequest, request: Request) -> ParseResponse:
    user, client_ip = request_identity(request)
    rate_limiter.check(f"parse:{client_ip}")
    url = validate_public_url(payload.url)
    started = monotonic()
    logger.info("parse started")
    try:
        result = await downloader.inspect(url, payload.cookie_profile, user.id if user else None)
        logger.info("parse completed platform=%s elapsed=%.2f", result.platform, monotonic() - started)
        return result
    except DownloadRejected as exc:
        logger.warning("parse rejected elapsed=%.2f error=%s", monotonic() - started, str(exc)[:240])
        raise HTTPException(status_code=422, detail=downloader._safe_error(exc)) from exc


@app.post("/api/collections/inspect", response_model=CollectionInspectResponse)
async def inspect_collection(payload: CollectionInspectRequest, request: Request) -> CollectionInspectResponse:
    user, client_ip = request_identity(request)
    rate_limiter.check(f"collection:{client_ip}")
    url = validate_public_url(payload.url)
    started = monotonic()
    logger.info("collection started max_items=%s", payload.max_items)
    try:
        result = await downloader.inspect_collection(url, payload.max_items, payload.cookie_profile, user.id if user else None)
        logger.info("collection completed extractor=%s items=%s elapsed=%.2f", result.extractor, len(result.items), monotonic() - started)
        return result
    except DownloadRejected as exc:
        logger.warning("collection rejected elapsed=%.2f error=%s", monotonic() - started, str(exc)[:240])
        raise HTTPException(status_code=422, detail=downloader._safe_error(exc)) from exc


async def create_download(payload: JobCreateRequest, request: Request, api_key_mode: bool = False) -> JobCreateResponse:
    user, client_ip = request_identity(request)
    rate_limiter.check(f"job:{client_ip}")
    url = validate_public_url(payload.url)
    if not api_key_mode:
        auth_store.consume_quota(user, client_ip)
    job = store.create(url, client_ip, payload, user.id if user else None)
    asyncio.create_task(downloader.run(job))
    return JobCreateResponse(job_id=job.job_id)


@app.post("/api/jobs", response_model=JobCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_job(payload: JobCreateRequest, request: Request) -> JobCreateResponse:
    return await create_download(payload, request)


@app.post("/api/jobs/batch", response_model=BatchJobCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_batch_jobs(payload: BatchJobCreateRequest, request: Request) -> BatchJobCreateResponse:
    user, client_ip = request_identity(request)
    rate_limiter.check(f"job:{client_ip}")
    urls = [validate_public_url(url) for url in payload.urls]
    quota = auth_store.consume_quota(user, client_ip, amount=len(urls))
    jobs: list[Job] = []
    for url in urls:
        job_payload = JobCreateRequest(
            url=url,
            media_type=payload.media_type,
            format_id=payload.format_id,
            format_has_audio=payload.format_id == "best",
            audio_format=payload.audio_format,
            transcript_mode=payload.transcript_mode,
            transcript_format=payload.transcript_format,
            transcript_language=payload.transcript_language,
            include_description=payload.include_description,
            include_thumbnail=payload.include_thumbnail,
            cookie_profile=None,
        )
        jobs.append(store.create(url, client_ip, job_payload, user.id if user else None))
    for job in jobs:
        asyncio.create_task(downloader.run(job))
    return BatchJobCreateResponse(
        jobs=[BatchJobItemResponse(url=job.url, job_id=job.job_id) for job in jobs],
        quota=quota,
    )


@app.get("/api/jobs", response_model=list[JobPublic])
async def job_history(request: Request) -> list[JobPublic]:
    user, client_ip = request_identity(request)
    jobs = [store.get(item.job_id) for item in store.list_for(user.id if user else None, client_ip)]
    return [public_job(job) for job in jobs if job]


@app.get("/api/jobs/{job_id}", response_model=JobPublic)
async def get_job(job_id: str, request: Request) -> JobPublic:
    return public_job(require_owned_job(job_id, request))


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    require_owned_job(job_id, request)

    async def stream():
        previous = ""
        while True:
            job = store.get(job_id)
            if not job:
                break
            data = json.dumps(public_job(job).model_dump(mode="json"), ensure_ascii=False)
            if data != previous:
                yield f"data: {data}\n\n"
                previous = data
            if job.status in {JobStatus.completed, JobStatus.failed, JobStatus.cancelled, JobStatus.expired}:
                break
            await asyncio.sleep(0.75)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/jobs/{job_id}/cancel", response_model=JobPublic)
async def cancel_job(job_id: str, request: Request) -> JobPublic:
    job = require_owned_job(job_id, request)
    try:
        await downloader.cancel(job)
    except DownloadRejected as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return public_job(job)


@app.post("/api/jobs/{job_id}/retry", response_model=JobPublic, status_code=status.HTTP_202_ACCEPTED)
async def retry_job(job_id: str, request: Request) -> JobPublic:
    job = require_owned_job(job_id, request)
    if not job.public().can_retry:
        raise HTTPException(status_code=409, detail="该任务当前不能重试。")
    store.retry(job)
    asyncio.create_task(downloader.run(job))
    return public_job(job)


@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str, expires: int, signature: str) -> FileResponse:
    verify_download_signature(job_id, expires, signature)
    return file_response(job_id)


@app.get("/api/assets/{kind}")
async def download_remote_asset(
    kind: str,
    source: str,
    expires: int,
    signature: str,
    download: bool = True,
) -> Response:
    try:
        source_url = verify_asset_token(kind, source, expires, signature, settings.auth_secret)
        asset = await asyncio.to_thread(fetch_remote_asset, source_url, kind)
    except RemoteAssetError as exc:
        message = str(exc)
        code = status.HTTP_410_GONE if "过期" in message else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=message) from exc
    disposition = "attachment" if download else "inline"
    return Response(
        content=asset.data,
        media_type=asset.content_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{asset.filename}"',
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )


def file_response(job_id: str) -> FileResponse:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在。")
    if job.status == JobStatus.expired:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="文件已过期。")
    if job.status != JobStatus.completed or not job.file_path:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成。")
    if not job.file_path.exists():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="文件已被清理。")
    return FileResponse(path=job.file_path, filename=job.filename or job.file_path.name, media_type="application/octet-stream")


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
    job = store.create(url, client_ip, payload)
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
    return public_job(job)


@app.get("/api/v1/jobs/{job_id}/download")
async def v1_download_job(job_id: str, request: Request) -> FileResponse:
    client_ip = client_ip_from_request(request, settings.trusted_proxy_headers)
    api_key = auth_store.api_key_from_request(request, client_ip)
    auth_store.require_api_scope(api_key, "files:download")
    return file_response(job_id)


@app.get("/api/v1/openapi.json")
async def v1_openapi() -> dict:
    return app.openapi()


static_dir = Path(settings.static_dir)
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
