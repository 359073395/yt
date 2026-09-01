from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_host: str = "0.0.0.0"
    app_port: int = 8080
    download_dir: Path = Path("/data/downloads")
    database_path: Path = Path("/data/video-parser.sqlite3")
    static_dir: Path = Path("/app/static")
    auth_secret: str = "change-this-auth-secret"
    guest_daily_limit: int = Field(default=3, ge=1, le=1000)
    user_daily_limit: int = Field(default=10, ge=1, le=1000)
    max_concurrent_downloads: int = Field(default=2, ge=1, le=10)
    rate_limit_per_minute: int = Field(default=6, ge=1, le=120)
    max_file_size_mb: int = Field(default=512, ge=10, le=10240)
    max_duration_seconds: int = Field(default=1800, ge=10, le=86400)
    job_ttl_seconds: int = Field(default=3600, ge=60, le=86400)
    request_timeout_seconds: int = Field(default=20, ge=5, le=120)
    metadata_timeout_seconds: int = Field(default=45, ge=10, le=180)
    chromium_path: str = ""
    transcription_enabled: bool = True
    whisper_model: str = "base"
    whisper_device: str = Field(default="cpu", pattern=r"^(cpu|cuda|auto)$")
    whisper_compute_type: str = "int8"
    whisper_cpu_threads: int = Field(default=2, ge=1, le=32)
    whisper_cache_dir: Path = Path("/data/cache/whisper")
    engine_channel: str = Field(default="stable", pattern=r"^(stable|nightly)$")
    app_version: str = "2.5.0"
    trusted_proxy_headers: bool = False

    @property
    def max_file_size_bytes(self) -> int:
        return self.max_file_size_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
