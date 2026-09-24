use super::*;
fn fixture() -> TeamState {
    let s = super::super::tests::fixture_state();
    *s.registration.lock().unwrap() = Some(Registration {
        id: "attempt-one".into(),
        status: "waiting".into(),
        message: String::new(),
        url: "https://open.feishu.cn/page/launcher?user_code=test".into(),
        qr: String::new(),
        expires: now() + 600_000,
    });
    s
}
fn granted() -> Value {
    json!({"client_id":"cli_testapp", "client_secret":"fixture-secret-not-real", "user_info":{"open_id":"ou_owner","tenant_brand":"feishu"}})
}
#[test]
fn official_parameters_minimize_permissions_and_prevent_existing_app_changes() {
    let u = url::Url::parse(&verification_url("https://open.feishu.cn/page/launcher?user_code=abc&createOnly=false&clientID=cli_existing").unwrap()).unwrap();
    let params: BTreeMap<_, _> = u.query_pairs().into_owned().collect();
    assert_eq!(params["user_code"], "abc");
    assert_eq!(params["createOnly"], "true");
    assert!(!params.contains_key("clientID"));
    let bytes = URL_SAFE_NO_PAD.decode(&params["addons"]).unwrap();
    let mut decoded = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut decoded)
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&decoded).unwrap(), addons());
    assert_eq!(addons()["scopes"]["tenant"].as_array().unwrap().len(), 3);
    assert!(!decoded.contains("contact:"));
    assert!(!decoded.contains("drive:"));
    assert!(begin_body().contains("request_user_info=open_id"));
    assert_eq!(poll_body("a+b&c"), "action=poll&device_code=a%2Bb%26c");
}
#[test]
fn reject_untrusted_authorization_urls() {
    for url in [
        "http://open.feishu.cn/page/launcher",
        "https://open.feishu.cn.evil.test/page/launcher",
        "https://evil@open.feishu.cn/page/launcher",
        "https://open.feishu.cn:444/page/launcher",
        "https://open.feishu.cn/not-the-launcher",
        "https://open.feishu.cn/page/launcher#evil",
    ] {
        assert!(verification_url(url).is_err(), "{url}");
    }
}
#[test]
fn qr_is_local_svg_and_protocol_fields_are_bounded() {
    let value = json!({"device_code":"private-device-code","verification_uri_complete":"https://open.feishu.cn/page/launcher?user_code=test","expires_in":3600,"interval":5});
    let t = ticket(&value).unwrap();
    assert!(t.qr.starts_with("data:image/svg+xml;base64,"));
    let svg = String::from_utf8(STANDARD.decode(t.qr.split_once(',').unwrap().1).unwrap()).unwrap();
    assert!(svg.contains("<svg"));
    assert!(!svg.contains("<script"));
    assert_eq!(t.seconds, 3600);
    let mut invalid = value.clone();
    invalid["expires_in"] = json!(0);
    assert!(ticket(&invalid).is_err());
    invalid = value;
    invalid["interval"] = json!(10000);
    assert!(ticket(&invalid).is_err());
}
#[test]
fn cancelled_stale_and_expired_responses_never_commit_credentials() {
    let s = fixture();
    cancel(&s);
    store_authorized(&s, "attempt-one", "office", &granted()).unwrap();
    assert!(s.data.lock().unwrap().config.app_id.is_empty());
    assert!(status(&s)["url"].as_str().unwrap().is_empty());
    let s = fixture();
    s.registration.lock().unwrap().as_mut().unwrap().id = "attempt-two".into();
    store_authorized(&s, "attempt-one", "office", &granted()).unwrap();
    assert!(s.data.lock().unwrap().config.app_id.is_empty());
    s.registration.lock().unwrap().as_mut().unwrap().expires = 1;
    store_authorized(&s, "attempt-two", "office", &granted()).unwrap();
    assert!(s.data.lock().unwrap().config.app_id.is_empty());
    assert_eq!(status(&s)["status"], "expired");
}
#[test]
fn authorization_persists_encrypted_credentials_but_not_download_permission() {
    let s = fixture();
    store_authorized(&s, "attempt-one", "office", &granted()).unwrap();
    let d = s.data.lock().unwrap();
    assert_eq!(d.config.owner, "ou_owner");
    assert!(d.config.onboarding);
    assert!(!d.config.enabled);
    assert_eq!(
        unprotect_secret(&d.config.proof).unwrap(),
        "fixture-secret-not-real"
    );
    let (restored, _) = load_journal(&s.path).unwrap();
    assert!(restored.config.onboarding);
    assert!(!restored.config.proof.is_empty());
    assert!(!serde_json::to_string(&restored)
        .unwrap()
        .contains("fixture-secret-not-real"));
    assert!(!status(&s).to_string().contains("client_secret"));
    assert_eq!(status(&s)["status"], "authorized");
}
#[test]
fn existing_binding_and_malformed_credentials_are_not_overwritten() {
    let s = fixture();
    s.data.lock().unwrap().config.app_id = "cli_existing".into();
    assert!(store_authorized(&s, "attempt-one", "office", &granted()).is_err());
    assert_eq!(s.data.lock().unwrap().config.app_id, "cli_existing");
    let s = fixture();
    let mut g = granted();
    g["client_secret"] = json!("short");
    assert!(store_authorized(&s, "attempt-one", "office", &g).is_err());
    g = granted();
    g["user_info"]["open_id"] = json!("ou_../bad");
    assert!(store_authorized(&s, "attempt-one", "office", &g).is_err());
    assert!(s.data.lock().unwrap().config.app_id.is_empty());
}
#[test]
fn missing_owner_uses_pairing_without_trusting_arbitrary_first_sender() {
    let s = fixture();
    let mut g = granted();
    g["user_info"] = Value::Null;
    store_authorized(&s, "attempt-one", "office", &g).unwrap();
    assert!(s.data.lock().unwrap().config.owner.is_empty());
    assert!(s.pair.lock().unwrap().is_some());
}
#[test]
fn denied_slow_pending_and_lark_responses_are_handled_explicitly() {
    assert!(matches!(
        classify(&json!({"error":"authorization_pending"})),
        Poll::Pending
    ));
    assert!(matches!(
        classify(&json!({"error":"slow_down"})),
        Poll::Slow
    ));
    assert!(matches!(classify(&granted()), Poll::Authorized));
    for error in ["access_denied", "expired_token", "unknown_secret_response"] {
        assert!(matches!(classify(&json!({"error":error})), Poll::Failed(_)));
    }
    let mut g = granted();
    g["user_info"]["tenant_brand"] = json!("lark");
    assert!(matches!(classify(&g), Poll::Failed(_)));
}
#[test]
fn registration_http_parses_pending_400_and_never_follows_redirects() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr());
    let worker = thread::spawn(move || {
        let request = server.recv().unwrap();
        request
            .respond(
                tiny_http::Response::from_string("{\"error\":\"authorization_pending\"}")
                    .with_status_code(400),
            )
            .unwrap();
        let request = server.recv().unwrap();
        request
            .respond(tiny_http::Response::empty(302).with_header(
                tiny_http::Header::from_bytes("Location", "http://127.0.0.1:1/secret").unwrap(),
            ))
            .unwrap();
    });
    assert_eq!(
        request_at(&url, &poll_body("test")).unwrap()["error"],
        "authorization_pending"
    );
    assert!(request_at(&url, &begin_body()).unwrap_err().contains("302"));
    worker.join().unwrap();
}

// Explicit read-only live smoke: obtains a QR ticket, but never authorizes or creates an app.
#[test]
#[ignore = "requires live Feishu network; creates no application"]
fn live_official_registration_ticket() {
    let v = request_at(ENDPOINT, &begin_body()).unwrap();
    let t = ticket(&v).unwrap();
    assert!(t.url.starts_with("https://open.feishu.cn/page/launcher?"));
    assert!(matches!(
        classify(&request_at(ENDPOINT, &poll_body(&t.code)).unwrap()),
        Poll::Pending
    ));
}
