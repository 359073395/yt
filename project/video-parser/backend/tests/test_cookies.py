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
