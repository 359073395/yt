import pytest
from fastapi import HTTPException

from app.auth import AuthStore


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


def test_user_daily_limit(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("bob", "password123")

    for index in range(10):
        quota = store.consume_quota(user, "127.0.0.1")
        assert quota.used == index + 1

    with pytest.raises(HTTPException) as exc:
        store.consume_quota(user, "127.0.0.1")
    assert exc.value.status_code == 403


def test_anonymous_daily_limit_by_ip(tmp_path):
    store = make_store(tmp_path)

    for _ in range(3):
        store.consume_quota(None, "203.0.113.9")

    with pytest.raises(HTTPException):
        store.consume_quota(None, "203.0.113.9")

    assert store.consume_quota(None, "203.0.113.10").used == 1


def test_batch_quota_is_consumed_atomically(tmp_path):
    store = make_store(tmp_path)
    user = store.create_user("batchuser", "password123")

    quota = store.consume_quota(user, "127.0.0.1", amount=4)

    assert quota.used == 4
    assert quota.remaining == 6
    with pytest.raises(HTTPException):
        store.consume_quota(user, "127.0.0.1", amount=7)
    assert store.quota_for(user, "127.0.0.1").used == 4


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
