import pytest
from fastapi import HTTPException

from app import main
from app.auth import AuthStore
from app.models import AuthRequest, JobCreateRequest
from app.store import JobStore


def make_store(tmp_path):
    return AuthStore(
        database_path=tmp_path / "auth.sqlite3",
        secret="test-secret",
        guest_daily_limit=3,
        user_daily_limit=10,
        admin_username="admin",
        admin_password="lhw111111",
    )


def test_seed_admin_can_authenticate(tmp_path):
    store = make_store(tmp_path)
    admin = store.authenticate("admin", "lhw111111")

    assert admin.role == "admin"
    assert store.quota_for(admin, "127.0.0.1").unlimited is True


def test_token_round_trip(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("alice", "password123")
    token = store.create_token(user)

    restored = store.user_from_token(token)

    assert restored is not None
    assert restored.username == "alice"


def test_web_downloads_are_unlimited(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("bob", "password123")

    for _ in range(25):
        quota = store.consume_quota(user, "127.0.0.1")
        assert quota.unlimited is True
        assert quota.limit is None
        assert quota.remaining is None


def test_anonymous_requests_are_unlimited(tmp_path):
    store = make_store(tmp_path)

    for _ in range(25):
        assert store.consume_quota(None, "203.0.113.9").unlimited is True


def test_batch_downloads_are_unlimited(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("batchuser", "password123")

    quota = store.consume_quota(user, "127.0.0.1", amount=4)

    assert quota.unlimited is True
    assert store.consume_quota(user, "127.0.0.1", amount=50).unlimited is True


def test_browser_session_token_is_private_unlimited_and_stateless(tmp_path):
    store = make_store(tmp_path)
    token_a, browser_a = store.create_browser_token()
    _token_b, browser_b = store.create_browser_token()

    restored = store.user_from_token(token_a)

    assert restored == browser_a
    assert browser_a.role == "browser"
    assert browser_a.id != browser_b.id
    assert browser_a.id >= store.BROWSER_ID_BASE
    assert store.get_user_by_id(browser_a.id) is None
    assert store.consume_quota(browser_a, "127.0.0.1", amount=50).unlimited is True
    assert store.user_from_token(f"{token_a}tampered") is None


@pytest.mark.asyncio
async def test_browser_session_endpoint_reuses_valid_identity(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    monkeypatch.setattr(main, "auth_store", store)
    request = type("Request", (), {"headers": {}, "client": None})()

    created = await main.browser_session(request)
    reused = await main.browser_session(type("Request", (), {"headers": {"authorization": f"Bearer {created.token}"}, "client": None})())

    assert reused.token == created.token
    assert reused.quota.unlimited is True
    assert store.user_from_token(created.token).role == "browser"


@pytest.mark.asyncio
async def test_login_endpoint_rejects_legacy_regular_users(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    store.create_user("legacyuser", "password123")
    monkeypatch.setattr(main, "auth_store", store)

    with pytest.raises(HTTPException) as exc:
        await main.login(
            AuthRequest(username="legacyuser", password="password123"),
            type("Request", (), {"headers": {}, "client": None})(),
        )

    assert exc.value.status_code == 403
    assert "普通用户登录已取消" in exc.value.detail


def test_browser_jobs_are_isolated_even_on_the_same_ip(tmp_path, monkeypatch):
    auth = make_store(tmp_path)
    token_a, browser_a = auth.create_browser_token()
    token_b, _browser_b = auth.create_browser_token()
    jobs = JobStore(tmp_path / "downloads", 3600, tmp_path / "jobs.sqlite3")
    job = jobs.create(
        "https://example.com/video.mp4",
        "203.0.113.10",
        JobCreateRequest(url="https://example.com/video.mp4"),
        browser_a.id,
    )
    monkeypatch.setattr(main, "auth_store", auth)
    monkeypatch.setattr(main, "store", jobs)

    owner_request = type("Request", (), {"headers": {"authorization": f"Bearer {token_a}"}, "client": None})()
    stranger_request = type("Request", (), {"headers": {"authorization": f"Bearer {token_b}"}, "client": None})()

    assert main.require_owned_job(job.job_id, owner_request) is job
    with pytest.raises(HTTPException) as exc:
        main.require_owned_job(job.job_id, stranger_request)
    assert exc.value.status_code == 403


def test_member_has_unlimited_quota(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("carol", "password123")
    member = store.update_role(user.id, "member")
    restored = store.get_user_by_id(member.id)

    assert restored is not None
    for _ in range(8):
        quota = store.consume_quota(restored, "127.0.0.1")
        assert quota.unlimited is True


def test_admin_can_create_member_directly(tmp_path):
    store = make_store(tmp_path)
    member = store.create_user("directmember", "password123", role="member")

    public = store.user_public(member)

    assert public.role == "member"
    assert public.unlimited is True

    admin = store.authenticate("admin", "lhw111111")
    store.delete_user(member.id, admin.id)
    assert store.get_user_by_id(member.id) is None


def test_api_key_quota_and_disable(tmp_path):
    store = make_store(tmp_path)
    created = store.create_api_key("Codex", daily_limit=2, scopes=["jobs:create"])
    request = type(
        "Request",
        (),
        {"headers": {"x-api-key": created.key}},
    )()

    api_key = store.api_key_from_request(request, "127.0.0.1")
    assert api_key.name == "Codex"
    assert store.consume_api_quota(api_key).used == 1
    assert store.consume_api_quota(api_key).used == 2

    with pytest.raises(HTTPException) as exc:
        store.consume_api_quota(api_key)
    assert exc.value.status_code == 403

    store.update_api_key(created.item.id, key_status="disabled")
    with pytest.raises(HTTPException) as disabled_exc:
        store.api_key_from_request(request, "127.0.0.1")
    assert disabled_exc.value.status_code == 403
