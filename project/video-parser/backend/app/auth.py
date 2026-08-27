import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import time
from typing import Any

from fastapi import HTTPException, Request, status

from .models import ApiKeyCreateResponse, ApiKeyPublic, QuotaPublic, UserPublic


@dataclass(frozen=True)
class AuthUser:
    id: int
    username: str
    role: str
    created_at: float
    status: str = "active"
    member_expires_at: float | None = None
    daily_limit_override: int | None = None

    def public(self, daily_used: int = 0, daily_limit: int | None = None, unlimited: bool = False) -> UserPublic:
        return UserPublic(
            id=self.id,
            username=self.username,
            role=self.role,
            created_at=self.created_at,
            status=self.status,
            member_expires_at=self.member_expires_at,
            daily_limit_override=self.daily_limit_override,
            daily_used=daily_used,
            daily_limit=daily_limit,
            unlimited=unlimited,
        )


@dataclass(frozen=True)
class ApiKeyAuth:
    id: int
    name: str
    prefix: str
    scopes: list[str]
    daily_limit: int | None


class AuthStore:
    BROWSER_ID_BASE = 1 << 62

    def __init__(
        self,
        database_path: Path,
        secret: str,
        guest_daily_limit: int,
        user_daily_limit: int,
        admin_username: str,
        admin_password: str,
    ) -> None:
        self.database_path = database_path
        self.secret = secret.encode("utf-8")
        self.guest_daily_limit = guest_daily_limit
        self.user_daily_limit = user_daily_limit
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.seed_admin(admin_username, admin_password)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    status TEXT NOT NULL DEFAULT 'active',
                    member_expires_at REAL,
                    daily_limit_override INTEGER,
                    created_at REAL NOT NULL
                )
                """
            )
            self._ensure_column(conn, "users", "status", "TEXT NOT NULL DEFAULT 'active'")
            self._ensure_column(conn, "users", "member_expires_at", "REAL")
            self._ensure_column(conn, "users", "daily_limit_override", "INTEGER")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS daily_usage (
                    usage_date TEXT NOT NULL,
                    subject_type TEXT NOT NULL,
                    subject_key TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (usage_date, subject_type, subject_key)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    key_hash TEXT NOT NULL UNIQUE,
                    prefix TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    scopes TEXT NOT NULL,
                    daily_limit INTEGER,
                    created_at REAL NOT NULL,
                    last_used_at REAL,
                    last_used_ip TEXT
                )
                """
            )

    @staticmethod
    def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        if column not in {str(row["name"]) for row in rows}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def seed_admin(self, username: str, password: str) -> None:
        existing = self.get_user_by_username(username)
        password_hash = self.hash_password(password)
        now = time()
        with self.connect() as conn:
            if existing:
                conn.execute(
                    "UPDATE users SET password_hash = ?, role = 'admin', status = 'active' WHERE username = ?",
                    (password_hash, username),
                )
            else:
                conn.execute(
                    "INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?, ?, 'admin', 'active', ?)",
                    (username, password_hash, now),
                )

    @staticmethod
    def hash_password(password: str) -> str:
        salt = os.urandom(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260_000)
        return f"pbkdf2_sha256${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"

    @staticmethod
    def verify_password(password: str, stored: str) -> bool:
        try:
            algorithm, salt_b64, digest_b64 = stored.split("$", 2)
            if algorithm != "pbkdf2_sha256":
                return False
            salt = base64.urlsafe_b64decode(salt_b64.encode())
            expected = base64.urlsafe_b64decode(digest_b64.encode())
            actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260_000)
            return hmac.compare_digest(actual, expected)
        except Exception:
            return False

    def create_user(
        self,
        username: str,
        password: str,
        role: str = "user",
        user_status: str = "active",
        member_expires_at: float | None = None,
        daily_limit_override: int | None = None,
    ) -> AuthUser:
        now = time()
        try:
            with self.connect() as conn:
                cursor = conn.execute(
                    """
                    INSERT INTO users (
                        username,
                        password_hash,
                        role,
                        status,
                        member_expires_at,
                        daily_limit_override,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        username,
                        self.hash_password(password),
                        role,
                        user_status,
                        member_expires_at,
                        daily_limit_override,
                        now,
                    ),
                )
                user_id = int(cursor.lastrowid)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在。") from exc
        return AuthUser(
            id=user_id,
            username=username,
            role=role,
            status=user_status,
            member_expires_at=member_expires_at,
            daily_limit_override=daily_limit_override,
            created_at=now,
        )

    def authenticate(self, username: str, password: str) -> AuthUser:
        row = self._get_user_row_by_username(username)
        if not row or not self.verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码不正确。")
        if str(row["status"]) == "disabled":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已禁用。")
        return self._row_to_user(row)

    def get_user_by_username(self, username: str) -> AuthUser | None:
        row = self._get_user_row_by_username(username)
        return self._row_to_user(row) if row else None

    def get_user_by_id(self, user_id: int) -> AuthUser | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT id, username, role, status, member_expires_at, daily_limit_override, created_at FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
        return self._row_to_user(row) if row else None

    def _get_user_row_by_username(self, username: str) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(
                "SELECT id, username, password_hash, role, status, member_expires_at, daily_limit_override, created_at FROM users WHERE username = ?",
                (username,),
            ).fetchone()

    @staticmethod
    def _row_to_user(row: sqlite3.Row) -> AuthUser:
        return AuthUser(
            id=int(row["id"]),
            username=str(row["username"]),
            role=str(row["role"]),
            status=str(row["status"]),
            member_expires_at=float(row["member_expires_at"]) if row["member_expires_at"] is not None else None,
            daily_limit_override=int(row["daily_limit_override"]) if row["daily_limit_override"] is not None else None,
            created_at=float(row["created_at"]),
        )

    def create_token(self, user: AuthUser) -> str:
        payload = {
            "sub": user.id,
            "iat": int(time()),
            "nonce": secrets.token_urlsafe(8),
        }
        payload_b64 = self._b64_json(payload)
        signature = hmac.new(self.secret, payload_b64.encode("utf-8"), hashlib.sha256).digest()
        return f"{payload_b64}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"

    def create_browser_token(self) -> tuple[str, AuthUser]:
        created_at = int(time())
        browser_id = self.BROWSER_ID_BASE | secrets.randbits(61)
        user = AuthUser(
            id=browser_id,
            username="当前浏览器",
            role="browser",
            created_at=float(created_at),
        )
        payload = {
            "browser": browser_id,
            "iat": created_at,
            "nonce": secrets.token_urlsafe(8),
        }
        payload_b64 = self._b64_json(payload)
        signature = hmac.new(self.secret, payload_b64.encode("utf-8"), hashlib.sha256).digest()
        token = f"{payload_b64}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"
        return token, user

    def user_from_token(self, token: str) -> AuthUser | None:
        try:
            payload_b64, signature_b64 = token.split(".", 1)
            expected = hmac.new(self.secret, payload_b64.encode("utf-8"), hashlib.sha256).digest()
            actual = base64.urlsafe_b64decode(self._pad_b64(signature_b64))
            if not hmac.compare_digest(actual, expected):
                return None
            payload = json.loads(base64.urlsafe_b64decode(self._pad_b64(payload_b64)).decode("utf-8"))
            if "browser" in payload:
                browser_id = int(payload["browser"])
                if browser_id < self.BROWSER_ID_BASE or browser_id >= (1 << 63):
                    return None
                return AuthUser(
                    id=browser_id,
                    username="当前浏览器",
                    role="browser",
                    created_at=float(payload["iat"]),
                )
            user = self.get_user_by_id(int(payload["sub"]))
            return user if user and user.status == "active" else None
        except Exception:
            return None

    def user_from_request(self, request: Request) -> AuthUser | None:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            return None
        return self.user_from_token(header.split(" ", 1)[1].strip())

    def require_user(self, request: Request) -> AuthUser:
        user = self.user_from_request(request)
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="浏览器会话已失效，请刷新页面。")
        return user

    def require_admin(self, request: Request) -> AuthUser:
        user = self.require_user(request)
        if user.role != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限。")
        return user

    def list_users(self) -> list[UserPublic]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id, username, role, status, member_expires_at, daily_limit_override, created_at FROM users ORDER BY id ASC"
            ).fetchall()
        return [self.user_public(self._row_to_user(row)) for row in rows]

    def update_role(self, user_id: int, role: str) -> UserPublic:
        return self.update_user(user_id, role=role)

    def update_user(
        self,
        user_id: int,
        *,
        role: str | None = None,
        user_status: str | None = None,
        member_expires_at: float | None = None,
        daily_limit_override: int | None = None,
        daily_used: int | None = None,
        set_member_expires_at: bool = False,
        set_daily_limit_override: bool = False,
    ) -> UserPublic:
        assignments: list[str] = []
        values: list[Any] = []
        if role is not None:
            assignments.append("role = ?")
            values.append(role)
        if user_status is not None:
            assignments.append("status = ?")
            values.append(user_status)
        if set_member_expires_at or role == "member":
            assignments.append("member_expires_at = ?")
            values.append(member_expires_at)
        if set_daily_limit_override:
            assignments.append("daily_limit_override = ?")
            values.append(daily_limit_override or None)
        if assignments:
            values.append(user_id)
            with self.connect() as conn:
                cursor = conn.execute(f"UPDATE users SET {', '.join(assignments)} WHERE id = ?", values)
                if cursor.rowcount == 0:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在。")
        if daily_used is not None:
            self.set_user_usage(user_id, daily_used)
        user = self.get_user_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在。")
        return self.user_public(user)

    def delete_user(self, user_id: int, current_admin_id: int) -> None:
        if user_id == current_admin_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除当前登录的管理员。")
        with self.connect() as conn:
            user = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
            if not user:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在。")
            if str(user["role"]) == "admin":
                admins = conn.execute("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").fetchone()
                if int(admins["total"] or 0) <= 1:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="至少保留一个管理员。")
            conn.execute("DELETE FROM daily_usage WHERE subject_type = 'user' AND subject_key = ?", (str(user_id),))
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def set_user_usage(self, user_id: int, count: int) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO daily_usage (usage_date, subject_type, subject_key, count)
                VALUES (?, 'user', ?, ?)
                ON CONFLICT(usage_date, subject_type, subject_key)
                DO UPDATE SET count = excluded.count
                """,
                (self._today(), str(user_id), count),
            )

    def user_public(self, user: AuthUser) -> UserPublic:
        subject_type, subject_key = self._quota_subject(user, "")
        limit = self._limit_for(user)
        used = self._usage_count(subject_type, subject_key)
        unlimited = self._is_unlimited(user)
        return user.public(
            daily_used=0 if unlimited else used,
            daily_limit=None if unlimited else limit,
            unlimited=unlimited,
        )

    def create_api_key(self, name: str, daily_limit: int | None, scopes: list[str]) -> ApiKeyCreateResponse:
        raw_key = f"ylg_{secrets.token_urlsafe(32)}"
        key_hash = self._hash_api_key(raw_key)
        prefix = raw_key[:12]
        now = time()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO api_keys (name, key_hash, prefix, status, scopes, daily_limit, created_at)
                VALUES (?, ?, ?, 'active', ?, ?, ?)
                """,
                (name, key_hash, prefix, json.dumps(scopes), daily_limit, now),
            )
            api_key_id = int(cursor.lastrowid)
        item = self.get_api_key(api_key_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="API Key 创建失败。")
        return ApiKeyCreateResponse(key=raw_key, item=item)

    def list_api_keys(self) -> list[ApiKeyPublic]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, prefix, status, scopes, daily_limit, created_at, last_used_at, last_used_ip
                FROM api_keys
                ORDER BY id DESC
                """
            ).fetchall()
        return [self._api_key_public(row) for row in rows]

    def get_api_key(self, api_key_id: int) -> ApiKeyPublic | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, prefix, status, scopes, daily_limit, created_at, last_used_at, last_used_ip
                FROM api_keys WHERE id = ?
                """,
                (api_key_id,),
            ).fetchone()
        return self._api_key_public(row) if row else None

    def update_api_key(
        self,
        api_key_id: int,
        *,
        name: str | None = None,
        key_status: str | None = None,
        daily_limit: int | None = None,
        scopes: list[str] | None = None,
    ) -> ApiKeyPublic:
        assignments: list[str] = []
        values: list[Any] = []
        if name is not None:
            assignments.append("name = ?")
            values.append(name)
        if key_status is not None:
            assignments.append("status = ?")
            values.append(key_status)
        if daily_limit is not None:
            assignments.append("daily_limit = ?")
            values.append(daily_limit)
        if scopes is not None:
            assignments.append("scopes = ?")
            values.append(json.dumps(scopes))
        if assignments:
            values.append(api_key_id)
            with self.connect() as conn:
                cursor = conn.execute(f"UPDATE api_keys SET {', '.join(assignments)} WHERE id = ?", values)
                if cursor.rowcount == 0:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API Key 不存在。")
        item = self.get_api_key(api_key_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API Key 不存在。")
        return item

    def delete_api_key(self, api_key_id: int) -> None:
        with self.connect() as conn:
            cursor = conn.execute("DELETE FROM api_keys WHERE id = ?", (api_key_id,))
            if cursor.rowcount == 0:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API Key 不存在。")

    def api_key_from_request(self, request: Request, client_ip: str) -> ApiKeyAuth:
        raw_key = request.headers.get("x-api-key", "").strip()
        if not raw_key:
            header = request.headers.get("authorization", "")
            if header.lower().startswith("bearer ylg_"):
                raw_key = header.split(" ", 1)[1].strip()
        if not raw_key:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少 API Key。")
        key_hash = self._hash_api_key(raw_key)
        with self.connect() as conn:
            row = conn.execute(
                "SELECT id, name, prefix, status, scopes, daily_limit FROM api_keys WHERE key_hash = ?",
                (key_hash,),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API Key 无效。")
            if str(row["status"]) != "active":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="API Key 已禁用。")
            conn.execute(
                "UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
                (time(), client_ip, int(row["id"])),
            )
        return ApiKeyAuth(
            id=int(row["id"]),
            name=str(row["name"]),
            prefix=str(row["prefix"]),
            scopes=json.loads(str(row["scopes"])),
            daily_limit=int(row["daily_limit"]) if row["daily_limit"] is not None else None,
        )

    def require_api_scope(self, api_key: ApiKeyAuth, scope: str) -> None:
        if scope not in api_key.scopes:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="API Key 权限不足。")

    def quota_for_api_key(self, api_key: ApiKeyAuth) -> QuotaPublic:
        used = self._usage_count("api_key", str(api_key.id))
        if api_key.daily_limit is None:
            return QuotaPublic(limit=None, used=used, remaining=None, unlimited=True)
        return QuotaPublic(
            limit=api_key.daily_limit,
            used=used,
            remaining=max(0, api_key.daily_limit - used),
            unlimited=False,
        )

    def consume_api_quota(self, api_key: ApiKeyAuth) -> QuotaPublic:
        if api_key.daily_limit is None:
            return self.quota_for_api_key(api_key)
        today = self._today()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT count FROM daily_usage WHERE usage_date = ? AND subject_type = 'api_key' AND subject_key = ?",
                (today, str(api_key.id)),
            ).fetchone()
            used = int(row["count"]) if row else 0
            if used >= api_key.daily_limit:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="API Key 今日额度已用完。")
            new_count = used + 1
            conn.execute(
                """
                INSERT INTO daily_usage (usage_date, subject_type, subject_key, count)
                VALUES (?, 'api_key', ?, ?)
                ON CONFLICT(usage_date, subject_type, subject_key)
                DO UPDATE SET count = excluded.count
                """,
                (today, str(api_key.id), new_count),
            )
        return self.quota_for_api_key(api_key)

    def _api_key_public(self, row: sqlite3.Row) -> ApiKeyPublic:
        daily_limit = int(row["daily_limit"]) if row["daily_limit"] is not None else None
        used = self._usage_count("api_key", str(row["id"]))
        return ApiKeyPublic(
            id=int(row["id"]),
            name=str(row["name"]),
            prefix=str(row["prefix"]),
            status=str(row["status"]),
            scopes=json.loads(str(row["scopes"])),
            daily_limit=daily_limit,
            daily_used=used,
            created_at=float(row["created_at"]),
            last_used_at=float(row["last_used_at"]) if row["last_used_at"] is not None else None,
            last_used_ip=str(row["last_used_ip"]) if row["last_used_ip"] is not None else None,
        )

    @staticmethod
    def _hash_api_key(raw_key: str) -> str:
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

    def admin_counts(self) -> dict[str, int]:
        with self.connect() as conn:
            users = conn.execute(
                """
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS regular,
                  SUM(CASE WHEN role = 'member' THEN 1 ELSE 0 END) AS member,
                  SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin,
                  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
                FROM users
                """
            ).fetchone()
            api_keys = conn.execute(
                """
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
                FROM api_keys
                """
            ).fetchone()
            usage = conn.execute(
                "SELECT SUM(count) AS total FROM daily_usage WHERE usage_date = ?",
                (self._today(),),
            ).fetchone()
        return {
            "users_total": int(users["total"] or 0),
            "users_regular": int(users["regular"] or 0),
            "users_member": int(users["member"] or 0),
            "users_admin": int(users["admin"] or 0),
            "users_disabled": int(users["disabled"] or 0),
            "api_keys_total": int(api_keys["total"] or 0),
            "api_keys_active": int(api_keys["active"] or 0),
            "today_downloads": int(usage["total"] or 0),
        }

    def quota_for(self, user: AuthUser | None, client_ip: str) -> QuotaPublic:
        return QuotaPublic(limit=None, used=0, remaining=None, unlimited=True)

    def consume_quota(self, user: AuthUser | None, client_ip: str, amount: int = 1) -> QuotaPublic:
        if amount < 1 or amount > 50:
            raise ValueError("单次额度扣除数量必须在 1 到 50 之间。")
        return self.quota_for(user, client_ip)

    def _usage_count(self, subject_type: str, subject_key: str) -> int:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT count FROM daily_usage WHERE usage_date = ? AND subject_type = ? AND subject_key = ?",
                (self._today(), subject_type, subject_key),
            ).fetchone()
        return int(row["count"]) if row else 0

    @staticmethod
    def _quota_subject(user: AuthUser | None, client_ip: str) -> tuple[str, str]:
        if user:
            return "user", str(user.id)
        return "ip", client_ip

    def _limit_for(self, user: AuthUser | None) -> int:
        if user and user.daily_limit_override:
            return user.daily_limit_override
        return self.user_daily_limit if user else self.guest_daily_limit

    @staticmethod
    def _is_unlimited(user: AuthUser) -> bool:
        if user.role in {"admin", "browser"}:
            return True
        if user.role != "member":
            return False
        return user.member_expires_at is None or user.member_expires_at > time()

    @staticmethod
    def _today() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    @staticmethod
    def _b64_json(value: dict[str, Any]) -> str:
        raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @staticmethod
    def _pad_b64(value: str) -> bytes:
        return (value + "=" * (-len(value) % 4)).encode("utf-8")
