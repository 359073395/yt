from app.cookies import CookieStore


COOKIE_TEXT = b"# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsession\tsecret\n"


def test_cookie_profiles_are_encrypted_and_materialized(tmp_path):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    item = store.save("default", COOKIE_TEXT)

    encrypted = (tmp_path / "cookies" / "default.cookies.enc").read_bytes()
    assert b"session" not in encrypted
    assert item.name == "default"

    with store.materialize("default", tmp_path / "work") as cookie_file:
        assert cookie_file is not None
        assert cookie_file.read_bytes() == COOKIE_TEXT
    assert not (tmp_path / "work" / ".cookies.txt").exists()


def test_user_profiles_are_isolated_and_platform_filtered(tmp_path):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    content = (
        b"# Netscape HTTP Cookie File\n"
        b".douyin.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tdouyin-secret\n"
        b".example.com\tTRUE\t/\tFALSE\t0\tother\tshould-be-removed\n"
    )

    item = store.save("douyin", content, owner_id=7, platform="douyin")

    assert item.scope == "user"
    assert item.cookie_count == 1
    assert item.domains == ["douyin.com"]
    assert not store.exists("douyin", owner_id=8)
    with store.materialize("douyin", tmp_path / "work-user", owner_id=7) as cookie_file:
        assert cookie_file is not None
        materialized = cookie_file.read_bytes()
        assert b"douyin-secret" in materialized
        assert b"should-be-removed" not in materialized


def test_user_profile_automatically_selected_by_platform(tmp_path):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    content = b"# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\tuser-secret\n"
    store.save("tiktok", content, owner_id=3, platform="tiktok")

    with store.materialize(None, tmp_path / "work-auto", owner_id=3, platform="tiktok") as cookie_file:
        assert cookie_file is not None
        assert b"user-secret" in cookie_file.read_bytes()


def test_browser_profile_never_falls_back_to_legacy_global_cookie(tmp_path):
    store = CookieStore(tmp_path / "cookies", "test-secret")
    content = b"# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\tglobal-secret\n"
    store.save("tiktok", content, platform="tiktok")

    assert store.exists("tiktok", owner_id=88) is False
    with store.materialize(None, tmp_path / "work-private", owner_id=88, platform="tiktok") as cookie_file:
        assert cookie_file is None


def test_browser_cookies_are_converted_to_netscape_and_sanitized():
    content = CookieStore.browser_cookies_to_netscape([
        {
            "name": "sessionid",
            "value": "secret-value",
            "domain": ".douyin.com",
            "path": "/",
            "expires": -1,
            "httpOnly": True,
            "secure": True,
        },
        {
            "name": "unsafe\tname",
            "value": "line\nbreak",
            "domain": "www.douyin.com",
            "path": "/",
            "expires": 4102444800,
            "httpOnly": False,
            "secure": False,
        },
    ])

    text = content.decode()
    assert text.startswith("# Netscape HTTP Cookie File\n")
    assert "#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tsecret-value" in text
    assert "www.douyin.com\tFALSE\t/\tFALSE\t4102444800\tunsafename\tlinebreak" in text
