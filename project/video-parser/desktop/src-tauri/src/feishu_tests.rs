use super::*;

fn history_message(id: &str, owner: &str) -> Value {
    json!({"message_id":id,"sender":{"id":owner,"id_type":"open_id","sender_type":"user"},"msg_type":"text","body":{"content":json!({"text":format!("https://youtu.be/{id}")}).to_string()}})
}
#[test]
fn history_pages_recover_offline_messages_and_advance_only_after_all_pages() {
    let s = fixture();
    let c = s.data.lock().unwrap().config.clone();
    let mut calls = 0;
    catch_up_pages(&s,&c,|path| {
        calls += 1;
        assert!(path.contains("container_id=oc_private"));
        if calls == 1 { Ok(json!({"data":{"items":[history_message("a","ou_owner"),history_message("b","ou_other")],"has_more":true,"page_token":"page2"}})) }
        else { assert!(path.contains("page_token=page2")); Ok(json!({"data":{"items":[history_message("c","ou_owner")],"has_more":false}})) }
    }).unwrap();
    assert_eq!(calls, 2);
    let d = s.data.lock().unwrap();
    assert_eq!(d.jobs.len(), 2);
    assert!(d.config.history_until > 0);
}
#[test]
fn failed_history_page_keeps_cursor_and_retry_deduplicates_previous_page() {
    let s = fixture();
    let c = s.data.lock().unwrap().config.clone();
    let mut calls = 0;
    assert!(catch_up_pages(&s,&c,|_| { calls += 1; if calls == 1 { Ok(json!({"data":{"items":[history_message("a","ou_owner")],"has_more":true,"page_token":"page2"}})) } else { Err("network failure".into()) } }).is_err());
    assert_eq!(s.data.lock().unwrap().config.history_until, 0);
    catch_up_pages(&s, &c, |_| {
        Ok(json!({"data":{"items":[history_message("a","ou_owner")],"has_more":false}}))
    })
    .unwrap();
    assert_eq!(s.data.lock().unwrap().jobs.len(), 1);
}
#[test]
fn malformed_history_response_never_silently_skips_messages() {
    let s = fixture();
    let c = s.data.lock().unwrap().config.clone();
    assert!(catch_up_pages(&s, &c, |_| Ok(json!({"data":{}}))).is_err());
    assert_eq!(s.data.lock().unwrap().config.history_until, 0);
}
#[test]
fn replying_with_notes_updates_the_original_video_without_new_download() {
    let s = fixture();
    ingest(&s, "cli_testapp", &event("video", "https://youtu.be/abc")).unwrap();
    let mut e = event("note", "分类：美妆/好开头\n备注：稍后研究");
    e["message"]["parent_id"] = json!("video");
    ingest(&s, "cli_testapp", &e).unwrap();
    let d = s.data.lock().unwrap();
    assert_eq!(d.jobs.len(), 1);
    let j = d.jobs.values().next().unwrap();
    assert_eq!(j.remote["category"], "美妆/好开头");
    assert_eq!(j.remote["note"], "稍后研究");
}
#[test]
fn messages_before_pair_confirmation_are_not_imported() {
    let s = fixture();
    s.data.lock().unwrap().config.bound_at = 1000;
    let mut e = event("old", "https://youtu.be/abc");
    e["message"]["create_time"] = json!("999");
    ingest(&s, "cli_testapp", &e).unwrap();
    assert!(s.data.lock().unwrap().jobs.is_empty());
    e["message"]["create_time"] = json!("1001");
    ingest(&s, "cli_testapp", &e).unwrap();
    assert_eq!(s.data.lock().unwrap().jobs.len(), 1);
}
fn fixture() -> TeamState {
    let s = super::super::tests::fixture_state();
    {
        let mut d = s.data.lock().unwrap();
        d.config.app_id = "cli_testapp".into();
        d.config.owner = "ou_owner".into();
        d.config.chat_id = "oc_private".into();
        d.config.session = json!({"device_id":"device-one"});
    }
    s
}
fn event(id: &str, text: &str) -> Value {
    json!({"sender":{"sender_type":"user","sender_id":{"open_id":"ou_owner"}},
        "message":{"message_id":id,"chat_id":"oc_private","chat_type":"p2p","message_type":"text","content":json!({"text":text}).to_string()}})
}
#[test]
fn official_authorized_owner_requires_a_real_fresh_private_message() {
    let s = fixture();
    {
        let mut d = s.data.lock().unwrap();
        d.config.onboarding = true;
        d.config.chat_id.clear();
        d.config.bound_at = 1000;
    }
    let mut e = event("verify", "连接测试");
    e["message"]["create_time"] = json!("1001");
    e["sender"]["sender_id"]["open_id"] = json!("ou_stranger");
    ingest(&s, "cli_testapp", &e).unwrap();
    assert!(s.data.lock().unwrap().config.onboarding);
    e["sender"]["sender_id"]["open_id"] = json!("ou_owner");
    e["message"]["create_time"] = json!("999");
    ingest(&s, "cli_testapp", &e).unwrap();
    assert!(s.data.lock().unwrap().config.onboarding);
    e["message"]["create_time"] = json!("1001");
    ingest(&s, "cli_testapp", &e).unwrap();
    let d = s.data.lock().unwrap();
    assert!(!d.config.onboarding);
    assert_eq!(d.config.chat_id, "oc_private");
    assert!(!d.config.enabled);
    assert!(d.jobs.is_empty());
}
#[test]
fn chinese_share_text_and_multiple_platforms_are_recognized() {
    let urls = media_urls("长按复制，https://v.douyin.com/qybx95SkFnQ/。\n[口播](https://www.tiktok.com/@cisun_/video/7678218577157115156?utm_source=app) https://www.youtube.com/watch?v=abc&si=one https://youtu.be/abc?si=two").unwrap();
    assert_eq!(urls.len(), 3);
    assert!(urls.iter().any(|v| v.key == "tiktok:7678218577157115156"));
    assert!(urls.iter().all(|v| !v.url.ends_with(['。', ')'])));
}
#[test]
fn untrusted_hosts_credentials_ports_and_overlong_batches_are_rejected() {
    assert!(media_urls("https://tiktok.com.evil.test/video/1 https://localhost/a https://127.0.0.1/a https://user:secret@tiktok.com/video/1 https://tiktok.com:444/video/1").unwrap().is_empty());
    let text = (0..51)
        .map(|i| format!("https://www.tiktok.com/@x/video/{i}\n"))
        .collect::<String>();
    assert!(media_urls(&text).is_err());
}
#[test]
fn notes_can_be_folders_and_explicit_category_wins() {
    assert_eq!(
        metadata("https://v.douyin.com/abc/\n备注：好开头").unwrap(),
        ("好开头".into(), "好开头".into())
    );
    assert_eq!(
        metadata("分类：美妆/口播参考 备注：这个开头很好\nhttps://youtu.be/abc").unwrap(),
        ("美妆/口播参考".into(), "这个开头很好".into())
    );
    assert!(metadata("分类：../outside").is_err());
    assert_eq!(metadata("备注：为什么这样？").unwrap().0, "为什么这样？");
    assert_eq!(metadata("备注：https://localhost/x").unwrap().0, "待分类");
}
#[test]
fn natural_share_suffix_classifies_without_a_colon() {
    let text = "7.69 复制打开抖音，看看【珵豪女书家的作品】\u{a0}90%%的人会说不会写：不窎㐒 # 生僻字# 书... [90%的人会说不会写：不窎㐒 #生僻字#书法 #方言科普 #汉字冷知识 - 抖音](https://v.douyin.com/B6-Fzz29S_Y/) 11/05 oDU:/ K@J.vS :4pm 分类 测试";
    assert_eq!(metadata(text).unwrap(), ("测试".into(), "".into()));
    let s = fixture();
    ingest(&s, "cli_testapp", &event("share", text)).unwrap();
    let d = s.data.lock().unwrap();
    assert_eq!(d.jobs.len(), 1);
    assert_eq!(d.jobs.values().next().unwrap().remote["category"], "测试");
}
#[test]
fn category_spacing_punctuation_and_nested_folders() {
    for label in ["分类 测试", "分类：测试", "分类: 测试", "分类 = 测试", "分类\t测试"] {
        assert_eq!(metadata(&format!("https://youtu.be/a {label}")).unwrap().0, "测试");
    }
    assert_eq!(metadata("分类 美妆\\口播 备注 开头好").unwrap(), ("美妆/口播".into(), "开头好".into()));
    assert_eq!(metadata("#美妆 #分类测试 https://youtu.be/a").unwrap().0, "待分类");
    for invalid in ["分类 ../逃逸", "分类 C:\\视频", "分类 CON", "分类："] { assert!(metadata(invalid).is_err()); }
}
#[test]
fn resending_same_link_updates_category_without_losing_note_or_redownloading() {
    let s = fixture();
    ingest(&s, "cli_testapp", &event("a", "https://youtu.be/abc 分类 旧目录 备注 保留备注")).unwrap();
    ingest(&s, "cli_testapp", &event("b", "https://youtu.be/abc 分类 新目录")).unwrap();
    let d = s.data.lock().unwrap();
    assert_eq!(d.jobs.len(), 1);
    let job = d.jobs.values().next().unwrap();
    assert_eq!(job.remote["category"], "新目录");
    assert_eq!(job.remote["note"], "保留备注");
    drop(d);
    // A bare duplicate must not reset the explicitly chosen category.
    ingest(&s, "cli_testapp", &event("c", "https://youtu.be/abc")).unwrap();
    assert_eq!(s.data.lock().unwrap().jobs.values().next().unwrap().remote["category"], "新目录");
}
#[test]
fn note_only_reply_preserves_existing_category() {
    let s = fixture();
    ingest(&s, "cli_testapp", &event("a", "https://youtu.be/abc 分类 美妆")).unwrap();
    let mut reply = event("b", "备注 新备注");
    reply["message"]["parent_id"] = json!("a");
    ingest(&s, "cli_testapp", &reply).unwrap();
    let d = s.data.lock().unwrap();
    let job = d.jobs.values().next().unwrap();
    assert_eq!(job.remote["category"], "美妆");
    assert_eq!(job.remote["note"], "新备注");
}
#[test]
fn only_bound_owner_private_chat_and_app_can_queue() {
    let s = fixture();
    let mut e = event("one", "https://youtu.be/abc");
    e["sender"]["sender_id"]["open_id"] = json!("ou_other");
    ingest(&s, "cli_testapp", &e).unwrap();
    e["sender"]["sender_id"]["open_id"] = json!("ou_owner");
    e["message"]["chat_type"] = json!("group");
    ingest(&s, "cli_testapp", &e).unwrap();
    e["message"]["chat_type"] = json!("p2p");
    e["message"]["chat_id"] = json!("oc_other");
    ingest(&s, "cli_testapp", &e).unwrap();
    e["message"]["chat_id"] = json!("oc_private");
    ingest(&s, "cli_otherapp", &e).unwrap();
    e["sender"]["sender_type"] = json!("app");
    ingest(&s, "cli_testapp", &e).unwrap();
    assert!(s.data.lock().unwrap().jobs.is_empty());
    ingest(&s, "cli_testapp", &event("two", "https://youtu.be/abc")).unwrap();
    assert_eq!(s.data.lock().unwrap().jobs.len(), 1);
}
#[test]
fn replay_restart_and_tracking_variations_never_duplicate_downloads() {
    let s = fixture();
    let e = event("one", "https://youtu.be/abc?si=one\n备注：好开头");
    ingest(&s, "cli_testapp", &e).unwrap();
    ingest(&s, "cli_testapp", &e).unwrap();
    let (loaded, generation) = load_journal(&s.path).unwrap();
    *s.data.lock().unwrap() = loaded;
    s.generation.store(generation, Ordering::SeqCst);
    ingest(
        &s,
        "cli_testapp",
        &event("two", "https://www.youtube.com/watch?v=abc&si=two"),
    )
    .unwrap();
    let d = s.data.lock().unwrap();
    assert_eq!(d.jobs.len(), 1);
    assert_eq!(d.messages.len(), 2);
    let j = d.jobs.values().next().unwrap();
    assert_eq!(j.category, "好开头");
    assert_eq!(j.stage, "queued");
    assert_eq!(d.notices.len(), 2);
    assert!(j.options.proof.is_empty());
}
#[test]
fn durable_ingest_failure_does_not_mark_message_seen() {
    let mut s = fixture();
    s.path = s
        .path
        .parent()
        .unwrap()
        .join("does-not-exist")
        .join("journal.json");
    assert!(ingest(&s, "cli_testapp", &event("one", "https://youtu.be/abc")).is_err());
    let d = s.data.lock().unwrap();
    assert!(d.jobs.is_empty());
    assert!(d.messages.is_empty());
}
#[test]
fn pairing_requires_current_code_then_explicit_computer_confirmation() {
    let s = fixture();
    s.data.lock().unwrap().config.owner.clear();
    *s.pair.lock().unwrap() = Some(Pairing {
        code: "AABBCCDDEEFF".into(),
        expires: now() + 600_000,
        pending: None,
    });
    ingest(&s, "cli_testapp", &event("bad", "配对 000000000000")).unwrap();
    assert!(confirm_pair(&s).is_err());
    ingest(&s, "cli_testapp", &event("ok", "配对 AABBCCDDEEFF")).unwrap();
    assert!(s.data.lock().unwrap().config.owner.is_empty());
    confirm_pair(&s).unwrap();
    assert_eq!(s.data.lock().unwrap().config.owner, "ou_owner");
    assert!(confirm_pair(&s).is_err());
}
#[test]
fn expired_pair_and_other_sender_cannot_replace_pending_identity() {
    let s = fixture();
    s.data.lock().unwrap().config.owner.clear();
    *s.pair.lock().unwrap() = Some(Pairing {
        code: "AABBCCDDEEFF".into(),
        expires: now() - 1,
        pending: None,
    });
    ingest(&s, "cli_testapp", &event("bad", "配对 AABBCCDDEEFF")).unwrap();
    assert!(confirm_pair(&s).is_err());
    s.pair.lock().unwrap().as_mut().unwrap().expires = now() + 60_000;
    ingest(&s, "cli_testapp", &event("ok", "配对 AABBCCDDEEFF")).unwrap();
    let mut e = event("other", "配对 AABBCCDDEEFF");
    e["sender"]["sender_id"]["open_id"] = json!("ou_other");
    ingest(&s, "cli_testapp", &e).unwrap();
    confirm_pair(&s).unwrap();
    assert_eq!(s.data.lock().unwrap().config.owner, "ou_owner");
}
#[test]
fn rich_text_link_and_note_are_preserved() {
    let mut e = event("post", "");
    e["message"]["message_type"] = json!("post");
    e["message"]["content"] = json!({"zh_cn":{"title":"分类：带货","content":[[{"tag":"a","text":"参考","href":"https://youtu.be/abc"}],[{"tag":"text","text":"备注：开头"}]]}}).to_string().into();
    let s = fixture();
    ingest(&s, "cli_testapp", &e).unwrap();
    let d = s.data.lock().unwrap();
    let j = d.jobs.values().next().unwrap();
    assert_eq!(j.category, "带货");
    assert_eq!(j.remote["note"], "开头");
}
#[test]
fn protobuf_matches_official_required_zero_fields() {
    let ping = Frame {
        service: 7,
        headers: vec![Header {
            key: "type".into(),
            value: "ping".into(),
        }],
        ..Default::default()
    };
    let golden = vec![
        8, 0, 16, 0, 24, 7, 32, 0, 42, 12, 10, 4, 116, 121, 112, 101, 18, 4, 112, 105, 110, 103,
    ];
    assert_eq!(ping.encode_to_vec(), golden);
    assert_eq!(Frame::decode(&golden[..]).unwrap(), ping);
}
fn fragment(seq: usize, sum: usize, bytes: &[u8]) -> Frame {
    Frame {
        method: 1,
        headers: vec![
            Header {
                key: "message_id".into(),
                value: "m".into(),
            },
            Header {
                key: "seq".into(),
                value: seq.to_string(),
            },
            Header {
                key: "sum".into(),
                value: sum.to_string(),
            },
        ],
        payload: Some(bytes.to_vec()),
        ..Default::default()
    }
}
#[test]
fn out_of_order_fragments_and_duplicate_parts_are_safe() {
    let mut a = Assembler::default();
    assert_eq!(a.payload(&fragment(1, 2, b"world")).unwrap(), None);
    assert_eq!(a.payload(&fragment(1, 2, b"world")).unwrap(), None);
    assert_eq!(
        a.payload(&fragment(0, 2, b"hello ")).unwrap(),
        Some(b"hello world".to_vec())
    );
    assert!(a.pending.is_empty());
    assert!(a.payload(&fragment(2, 2, b"bad")).is_err());
    assert!(a.payload(&fragment(0, 65535, b"bad")).is_err());
}
#[test]
fn secrets_are_dpapi_protected_and_not_duplicated_in_jobs() {
    let s = fixture();
    let secret = "test-only-not-real-credential";
    s.data.lock().unwrap().config.proof = protect_secret(secret).unwrap();
    ingest(&s, "cli_testapp", &event("one", "https://youtu.be/abc")).unwrap();
    let (d, _) = load_journal(&s.path).unwrap();
    assert_eq!(unprotect_secret(&d.config.proof).unwrap(), secret);
    assert!(!serde_json::to_string(&d).unwrap().contains(secret));
    assert!(d.jobs.values().all(|j| j.options.proof.is_empty()));
}
