//! Persistent, bounded live monitoring. Only confirmed platform states mean offline.
use super::*;
use automation::{active_record, AutomationState, Journal, LiveRequest};
use live::{PreparedLive, RecordBudget};

#[derive(Clone, Serialize, Deserialize)]
pub struct LiveMonitor {
    pub id: String, pub request: LiveRequest, pub interval_seconds: u64,
    pub enabled: bool, pub checking: bool, pub last_checked: u64, pub next_check: u64,
    pub detail: String, pub failures: u32, pub revision: u64,
    pub session_id: String, pub finished_session: String, pub recording_id: String,
}
#[derive(Deserialize)]
pub struct MonitorRequest { pub recording: LiveRequest, pub interval_seconds: u64 }
pub struct Launch {
    pub monitor_id: String, pub revision: u64, pub session_id: String,
    pub playback_url: String, pub prepared: Option<PreparedLive>,
}
struct Broadcast { session_id: String, playback_url: String, prepared: Option<PreparedLive> }

pub fn normalize(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(&validate_url(raw)?).map_err(|_| "链接格式无效")?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() { return Err("监控链接不能包含账号、密码或端口".into()); }
    let parts: Vec<_> = parsed.path().trim_matches('/').split('/').collect();
    let host = parsed.host_str().unwrap_or_default();
    let token = |s: &str| !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'|b'.'));
    if matches!(host, "tiktok.com"|"www.tiktok.com"|"m.tiktok.com") && (parts.len() == 1 || (parts.len() == 2 && parts[1] == "live")) {
        if let Some(handle) = parts[0].strip_prefix('@').filter(|s| token(s)) {
            return Ok(format!("https://www.tiktok.com/@{}/live", handle.to_ascii_lowercase()));
        }
    }
    if matches!(host,"douyin.com"|"www.douyin.com"|"www.iesdouyin.com"|"iesdouyin.com") {
        let sec = match parts.as_slice() { ["user", sec] | ["share", "user", sec] => Some(*sec), _ => None };
        if let Some(sec) = sec.filter(|s| s.starts_with("MS4wLjABAAAA") && token(s)) { return Ok(format!("https://www.douyin.com/user/{sec}")); }
    }
    if host == "live.douyin.com" && parts.len() == 1 && numeric(parts[0]) {
        return Ok(format!("https://live.douyin.com/{}", parts[0]));
    }
    Err("请使用 TikTok 的 @用户名主页、抖音 /user/ 主页或 live.douyin.com/数字房间号完整链接；短分享链接请先在官方页面打开并复制完整地址".into())
}
pub fn same_source(a: &str, b: &str) -> bool {
    match (normalize(a), normalize(b)) { (Ok(a),Ok(b)) => a == b, _ => a == b }
}
fn numeric(s: &str) -> bool { !s.is_empty() && s.len() <= 30 && s.bytes().all(|b| b.is_ascii_digit()) && s.bytes().any(|b| b != b'0') }
fn identifier(v: &Value) -> Option<String> {
    let id = v.as_str().map(str::to_owned).or_else(|| v.as_u64().map(|n| n.to_string()))?;
    numeric(&id).then_some(id)
}
fn fetch(app: &tauri::AppHandle, url: &str, proxy: Option<&str>) -> Result<Value,String> {
    let client = network::client_at(proxy).timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法建立监控连接")?;
    let mut request = client.get(url).header(reqwest::header::USER_AGENT,BROWSER_USER_AGENT).header(reqwest::header::REFERER, if is_douyin_url(url) { "https://www.douyin.com/" } else { "https://www.tiktok.com/" });
    if let Some(cookie) = accounts::request_cookie(app,url) { request = request.header(reqwest::header::COOKIE,cookie); }
    let response = request.send().map_err(|_| "检查超时或网络不可达，尚不能判断是否开播")?;
    if !response.status().is_success() { return Err(format!("平台返回 HTTP {}，稍后重试；可在账号页检查登录和网络", response.status().as_u16())); }
    let mut bytes = vec![];
    response.take(8*1024*1024+1).read_to_end(&mut bytes).map_err(|_| "平台响应未接收完整")?;
    if bytes.len() > 8*1024*1024 { return Err("平台响应超出大小限制".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "平台未返回有效状态，可能需要在账号页登录或完成验证；不会当作未开播".into())
}
fn tiktok_state(data: &Value, handle: &str) -> Result<Option<Broadcast>, String> {
    if data["statusCode"].as_u64() != Some(0) || !data["data"]["user"]["uniqueId"].as_str().map(|u| u.eq_ignore_ascii_case(handle)).unwrap_or(false) { return Err("TikTok 未返回匹配的博主信息，无法确认开播状态".into()); }
    match data["data"]["liveRoom"]["status"].as_u64() {
        Some(4) => Ok(None),
        Some(2) => {
            let id = identifier(&data["data"]["user"]["roomId"]).ok_or("TikTok 直播场次编号缺失")?;
            Ok(Some(Broadcast { playback_url: format!("https://m.tiktok.com/share/live/{id}/"), session_id: id, prepared: None }))
        }
        _ => Err("TikTok 返回了未知直播状态，稍后重试".into()),
    }
}
fn douyin_state(data: &Value, sec: &str, proxy: Option<String>) -> Result<Option<Broadcast>, String> {
    if data["status_code"].as_u64() != Some(0) || data["user"]["sec_uid"].as_str() != Some(sec) { return Err("抖音未返回匹配的博主信息，请检查登录或稍后重试".into()); }
    let user = &data["user"];
    match user["live_status"].as_u64() {
        Some(0) => Ok(None),
        Some(1) => {
            let room: Value = serde_json::from_str(user["room_data"].as_str().ok_or("抖音直播信息缺失")?).map_err(|_| "抖音直播信息不完整")?;
            let id = identifier(&user["room_id_str"]).or_else(|| identifier(&user["room_id"])).ok_or("抖音直播场次编号缺失")?;
            Ok(Some(Broadcast { session_id:id, playback_url:format!("https://www.douyin.com/user/{sec}"), prepared:Some(PreparedLive { stream:live::room_stream(&room)?, referer:"https://live.douyin.com/".into(), proxy }) }))
        }
        _ => Err("抖音返回了未知直播状态，稍后重试".into()),
    }
}
fn probe(app: &tauri::AppHandle, source: &str, stop: &AtomicBool) -> Result<Option<Broadcast>, String> {
    if stop.load(Ordering::Relaxed) { return Err("程序正在退出".into()); }
    let url = Url::parse(source).map_err(|_| "监控链接无效")?;
    let proxy = network::endpoint(source);
    if url.host_str() == Some("www.tiktok.com") {
        let handle = url.path().trim_start_matches("/@").trim_end_matches("/live");
        let data = fetch(app, &format!("https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId={handle}&sourceType=54"), proxy.as_deref())?;
        tiktok_state(&data,handle)
    } else if url.host_str() == Some("live.douyin.com") {
        let room = live::douyin_room(&url,stop,proxy.as_deref())?;
        match room["status"].as_u64() {
            Some(4) => Ok(None),
            Some(2) => Ok(Some(Broadcast { session_id:identifier(&room["id_str"]).or_else(|| identifier(&room["id"])).ok_or("抖音直播场次编号缺失")?, playback_url:source.into(), prepared:Some(PreparedLive { stream:live::room_stream(&room)?,referer:"https://live.douyin.com/".into(),proxy }) })),
            _ => Err("抖音返回了未知直播状态，稍后重试".into()),
        }
    } else {
        let sec = url.path().trim_start_matches("/user/");
        let data = fetch(app,&format!("https://www.douyin.com/aweme/v1/web/user/profile/other/?aid=6383&device_platform=webapp&sec_user_id={sec}"),proxy.as_deref())?;
        douyin_state(&data,sec,proxy)
    }
}

pub fn recover(journal: &mut Journal) {
    for m in &mut journal.monitors { m.checking = false; m.revision = m.revision.wrapping_add(1); if m.enabled { m.next_check = 0; m.detail = "已恢复监控，等待检查".into(); } }
}
fn budget(j: &Journal, m: &LiveMonitor, session: &str) -> Option<RecordBudget> {
    let (seconds,bytes,count) = j.recordings.iter().filter(|r| r.monitor_id == m.id && r.session_id == session).fold((0u64,0u64,0usize), |(s,b,n),r| (s.saturating_add(r.elapsed),b.saturating_add(r.bytes),n+1));
    let remaining = RecordBudget { seconds:(m.request.minutes*60).saturating_sub(seconds), bytes:(m.request.max_gb*1024*1024*1024).saturating_sub(bytes) };
    (remaining.seconds > 0 && remaining.bytes > 0 && count < 3).then_some(remaining)
}
pub fn reserve(j: &mut Journal, launch: &Launch, recording_id: &str) -> Result<RecordBudget,String> {
    let m = j.monitors.iter().find(|m| m.id == launch.monitor_id).ok_or("监控已移除")?;
    if !m.enabled || m.revision != launch.revision || m.finished_session == launch.session_id || !m.recording_id.is_empty() { return Err("监控已变更或本场已处理，未重复启动".into()); }
    let remaining = budget(j,m,&launch.session_id).ok_or("本场已达到录制上限或连续重试上限，等待下一场")?;
    let m = j.monitors.iter_mut().find(|m| m.id == launch.monitor_id).unwrap();
    m.session_id = launch.session_id.clone(); m.recording_id = recording_id.into(); m.checking = false;
    m.detail = "检测到开播，自动录制已启动".into();
    Ok(remaining)
}
pub fn finish_current(j: &mut Journal, recording_id: &str) {
    for m in &mut j.monitors { if m.recording_id == recording_id { m.finished_session = m.session_id.clone(); m.detail = "本场已停止，等待下一场直播".into(); } }
}
fn settle(j: &mut Journal, id: &str) {
    let Some(index) = j.monitors.iter().position(|m| m.id == id) else { return; };
    let record_id = &j.monitors[index].recording_id;
    if record_id.is_empty() { return; }
    let Some(record) = j.recordings.iter().find(|r| &r.id == record_id) else { j.monitors[index].recording_id.clear(); return; };
    if active_record(&record.status) { return; }
    let m = &mut j.monitors[index];
    if record.status == "completed" || record.status == "cancelled" { m.finished_session = m.session_id.clone(); }
    m.recording_id.clear();
}
fn eligible(j: &Journal, m: &LiveMonitor, at: u64) -> bool {
    m.enabled && !m.checking && m.next_check <= at && !j.recordings.iter().any(|r| r.id == m.recording_id && active_record(&r.status))
}
fn checked(j: &mut Journal, snapshot: &LiveMonitor, result: Result<Option<Broadcast>,String>, at: u64) -> Result<Option<Launch>,String> {
    let Some(index) = j.monitors.iter().position(|m| m.id == snapshot.id && m.revision == snapshot.revision && m.enabled) else { return Ok(None); };
    settle(j,&snapshot.id);
    let m = &mut j.monitors[index];
    m.checking = false; m.last_checked = at;
    match result {
        Err(e) => {
            m.failures = m.failures.saturating_add(1);
            m.next_check = at + (m.interval_seconds * (1u64 << m.failures.min(5))).min(1800);
            m.detail = format!("检查失败：{}；将自动重试", live::safe_error(&e)); Ok(None)
        }
        Ok(None) => { m.failures = 0; m.next_check = at + m.interval_seconds; m.detail = "当前未开播，继续监控".into(); Ok(None) }
        Ok(Some(broadcast)) => {
            m.failures = 0; m.next_check = at + m.interval_seconds;
            if m.finished_session == broadcast.session_id { m.detail = "本场已录制或手动停止，等待下一场".into(); return Ok(None); }
            let launch = Launch { monitor_id:m.id.clone(),revision:m.revision,session_id:broadcast.session_id,playback_url:broadcast.playback_url,prepared:broadcast.prepared };
            if budget(j,&j.monitors[index],&launch.session_id).is_none() {
                let m = &mut j.monitors[index]; m.finished_session = launch.session_id; m.detail = "本场达到录制上限或 3 次连接上限，等待下一场".into(); return Ok(None);
            }
            Ok(Some(launch))
        }
    }
}
pub fn start(app: &tauri::AppHandle) {
    // Two bounded workers, oldest due first. A slow site cannot block every monitor.
    for _ in 0..2 {
        let app = app.clone();
        thread::spawn(move || {
            let state = app.state::<AutomationState>();
            while !state.quitting.load(Ordering::Relaxed) {
                let candidate = if state.error.lock().unwrap().is_empty() {
                    let j = state.journal.lock().unwrap();
                    j.monitors.iter().filter(|m| eligible(&j,m,automation::now())).min_by_key(|m| m.next_check).map(|m| m.id.clone())
                } else { None };
                if let Some(id) = candidate {
                    let claimed = state.edit(|j| {
                        let Some(index) = j.monitors.iter().position(|m| m.id == id && eligible(j,m,automation::now())) else { return Ok(None); };
                        settle(j,&id); let m = &mut j.monitors[index]; m.checking = true; m.detail = "正在检查开播状态…".into(); Ok(Some(m.clone()))
                    });
                    if let Ok(Some(monitor)) = claimed {
                        let result = probe(&app,&monitor.request.url,&state.quitting);
                        if let Ok(Some(launch)) = state.edit(|j| checked(j,&monitor,result,automation::now())) {
                            if let Err(e) = automation::live_start_sync(app.clone(),monitor.request.clone(),Some(launch)) {
                                let _ = state.edit(|j| { if let Some(m) = j.monitors.iter_mut().find(|m| m.id == monitor.id && m.revision == monitor.revision && m.enabled) { m.detail = format!("已开播，暂未录制：{}；稍后重试",live::safe_error(&e)); } Ok(()) });
                            }
                        }
                    }
                }
                for _ in 0..4 { if state.quitting.load(Ordering::Relaxed) { break; } thread::sleep(Duration::from_millis(250)); }
            }
        });
    }
}
#[tauri::command]
pub async fn live_monitor_add(app: tauri::AppHandle, request: MonitorRequest) -> Result<(),String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut recording = request.recording;
        recording.url = normalize(&recording.url)?;
        if !(60..=900).contains(&request.interval_seconds) { return Err("监控间隔为 60～900 秒".into()); }
        if !(1..=360).contains(&recording.minutes) || !(1..=50).contains(&recording.max_gb) || recording.name.chars().count() > 80 { return Err("每场录制 1～360 分钟、1～50 GB，名称不超过 80 字".into()); }
        if !Path::new(&recording.root).is_absolute() { return Err("请选择绝对保存路径".into()); }
        library::category_path(Path::new(&recording.root),&recording.category)?;
        find_tool(&app,"ffmpeg.exe").ok_or("FFmpeg 尚未就绪")?;
        if recording.name.trim().is_empty() { recording.name = "开播自动录制".into(); }
        let _ = accounts::sync(&app,false);
        let state = app.state::<AutomationState>();
        state.edit(|j| {
            if state.quitting.load(Ordering::Relaxed) { return Err("程序正在退出".into()); }
            if j.monitors.len() >= 20 { return Err("最多添加 20 个直播监控".into()); }
            if j.monitors.iter().any(|m| m.request.url == recording.url) { return Err("这个博主或直播间已在监控列表中".into()); }
            j.monitors.push(LiveMonitor { id:uuid::Uuid::new_v4().to_string(),request:recording,interval_seconds:request.interval_seconds,enabled:true,checking:false,last_checked:0,next_check:0,detail:"等待首次检查，已开播时也会自动开始录制".into(),failures:0,revision:0,session_id:String::new(),finished_session:String::new(),recording_id:String::new() }); Ok(())
        })
    }).await.map_err(|e| e.to_string())?
}
fn action(j: &mut Journal, id: &str, action: &str) -> Result<Option<String>,String> {
    let index = j.monitors.iter().position(|m| m.id == id).ok_or("直播监控不存在")?;
    let m = &mut j.monitors[index];
    match action {
        "check" => { if !m.enabled || m.checking { return Err("请先恢复监控或等待当前检查结束".into()); } m.next_check = 0; Ok(None) }
        "toggle" | "remove" => {
            let record_id = m.recording_id.clone(); m.revision = m.revision.wrapping_add(1); m.checking = false;
            if action == "remove" { j.monitors.remove(index); }
            else { m.enabled = !m.enabled; m.next_check = 0; if !m.enabled && !record_id.is_empty() { m.finished_session = m.session_id.clone(); } m.detail = if m.enabled { "已恢复监控，等待检查" } else { "已暂停，已有录制文件保留" }.into(); }
            Ok((!record_id.is_empty()).then_some(record_id))
        }
        _ => Err("未知监控操作".into()),
    }
}
#[tauri::command]
pub async fn live_monitor_action(app: tauri::AppHandle, id: String, action: String) -> Result<(),String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AutomationState>(); let stops = state.stops.lock().unwrap();
        let record_id = state.edit(|j| self::action(j,&id,&action))?;
        if let Some(stop) = record_id.and_then(|id| stops.get(&id)) { stop.store(true,Ordering::Relaxed); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Journal {
        let mut j = Journal::default();
        j.monitors.push(LiveMonitor { id:"watch".into(),request:LiveRequest { url:"https://www.tiktok.com/@alice/live".into(),name:"Alice".into(),root:"C:\\QA".into(),category:"直播".into(),minutes:2,max_gb:1 },interval_seconds:60,enabled:true,checking:true,last_checked:0,next_check:0,detail:String::new(),failures:0,revision:1,session_id:String::new(),finished_session:String::new(),recording_id:String::new() }); j
    }
    fn broadcast(id: &str) -> Result<Option<Broadcast>,String> { Ok(Some(Broadcast { session_id:id.into(),playback_url:"https://www.tiktok.com/@alice/live".into(),prepared:None })) }
    fn check(j: &mut Journal, result: Result<Option<Broadcast>,String>) -> Option<Launch> { let m = j.monitors[0].clone(); checked(j,&m,result,100).unwrap() }
    fn record(j: &mut Journal, launch: &Launch, id: &str) {
        reserve(j,launch,id).unwrap();
        j.recordings.push(automation::Recording { id:id.into(),url:j.monitors[0].request.url.clone(),name:"Alice".into(),category:"直播".into(),output_dir:"C:\\QA\\record".into(),status:"recording".into(),detail:String::new(),created:100,elapsed:0,bytes:0,monitor_id:"watch".into(),session_id:launch.session_id.clone() });
    }
    #[test] fn accepts_only_canonical_profiles_and_supported_rooms() {
        assert_eq!(normalize("https://tiktok.com/@Alice?lang=en").unwrap(),"https://www.tiktok.com/@alice/live");
        assert!(same_source("https://www.tiktok.com/@alice/", "https://www.tiktok.com/@ALICE/live?ref=x"));
        assert_eq!(normalize("https://www.iesdouyin.com/share/user/MS4wLjABAAAAxyz/?x=1").unwrap(),"https://www.douyin.com/user/MS4wLjABAAAAxyz");
        for url in ["https://tiktok.com.evil.com/@alice", "https://user:secret@tiktok.com/@alice", "https://tiktok.com:8888/@alice", "https://www.tiktok.com/@alice/video/123", "https://live.douyin.com/", "file:///C:/secret", "https://www.tiktok.com/@alice%0A"] { assert!(normalize(url).is_err(),"{url}"); }
    }
    #[test] fn platform_errors_and_wrong_owners_are_not_offline() {
        let mut tk = serde_json::json!({"statusCode":0,"data":{"user":{"uniqueId":"alice","roomId":"123"},"liveRoom":{"status":2}}});
        assert_eq!(tiktok_state(&tk,"alice").unwrap().unwrap().session_id,"123");
        assert!(tiktok_state(&tk,"bob").is_err());
        tk["data"]["liveRoom"]["status"] = 4.into(); assert!(tiktok_state(&tk,"alice").unwrap().is_none());
        tk["data"]["liveRoom"]["status"] = 0.into(); assert!(tiktok_state(&tk,"alice").is_err());
        assert!(tiktok_state(&serde_json::json!({"statusCode":10201}),"alice").is_err());
        let mut dy = serde_json::json!({"status_code":0,"user":{"sec_uid":"sec","live_status":0}});
        assert!(douyin_state(&dy,"sec",None).unwrap().is_none()); assert!(douyin_state(&dy,"other",None).is_err());
        dy["user"]["live_status"] = 1.into(); assert!(douyin_state(&dy,"sec",None).is_err());
        dy["user"]["room_id_str"] = "123".into(); dy["user"]["room_data"] = serde_json::json!({"status":2,"stream_url":{"flv_pull_url":{"HD1":"https://cdn.example/live.flv"}}}).to_string().into();
        assert_eq!(douyin_state(&dy,"sec",None).unwrap().unwrap().session_id,"123");
    }
    #[test] fn offline_to_live_starts_once_then_waits_for_next_broadcast() {
        let mut j = fixture(); assert!(check(&mut j,Ok(None)).is_none());
        let launch = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&launch,"record-1");
        assert!(!eligible(&j,&j.monitors[0],1000)); assert!(reserve(&mut j,&launch,"duplicate").is_err());
        j.recordings[0].status = "completed".into(); j.recordings[0].bytes = 1000;
        assert!(check(&mut j,broadcast("123")).is_none());
        assert!(check(&mut j,Ok(None)).is_none());
        assert_eq!(check(&mut j,broadcast("456")).unwrap().session_id,"456");
    }
    #[test] fn retry_counts_bytes_and_time_across_connection_attempts() {
        let mut j = fixture(); let first = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&first,"one");
        j.recordings[0].status = "partial".into(); j.recordings[0].elapsed = 80; j.recordings[0].bytes = 500;
        let retry = check(&mut j,broadcast("123")).unwrap();
        assert_eq!(budget(&j,&j.monitors[0],"123").unwrap(),RecordBudget { seconds:40,bytes:1024*1024*1024-500 });
        record(&mut j,&retry,"two"); j.recordings[1].status = "partial".into(); j.recordings[1].elapsed = 40;
        assert!(check(&mut j,broadcast("123")).is_none()); assert_eq!(j.monitors[0].finished_session,"123");
        assert!(check(&mut j,broadcast("456")).is_some());
    }
    #[test] fn zero_byte_failures_have_finite_attempts() {
        let mut j = fixture();
        for n in 0..3 { let launch = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&launch,&n.to_string()); j.recordings[n].status = "failed".into(); }
        assert!(check(&mut j,broadcast("123")).is_none()); assert_eq!(j.recordings.len(),3);
    }
    #[test] fn network_failure_backs_off_without_resetting_session_dedup() {
        let mut j = fixture(); j.monitors[0].finished_session = "123".into();
        assert!(check(&mut j,Err("HTTP 429".into())).is_none()); assert_eq!(j.monitors[0].next_check,220); assert_eq!(j.monitors[0].finished_session,"123");
        assert!(j.monitors[0].detail.contains("失败"));
        for _ in 0..15 { check(&mut j,Err("timeout".into())); } assert_eq!(j.monitors[0].next_check,1900);
        check(&mut j,Ok(None)); assert_eq!(j.monitors[0].failures,0); assert_eq!(j.monitors[0].next_check,160);
    }
    #[test] fn pause_remove_and_stop_reject_stale_inflight_results() {
        let mut j = fixture(); let stale = j.monitors[0].clone(); action(&mut j,"watch","toggle").unwrap(); action(&mut j,"watch","toggle").unwrap();
        assert!(checked(&mut j,&stale,broadcast("123"),100).unwrap().is_none());
        let launch = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&launch,"one"); finish_current(&mut j,"one");
        j.recordings[0].status = "partial".into(); assert!(check(&mut j,broadcast("123")).is_none());
        let next = check(&mut j,broadcast("456")).unwrap(); action(&mut j,"watch","remove").unwrap();
        assert!(reserve(&mut j,&next,"late").is_err()); assert_eq!(j.recordings.len(),1);
    }
    #[test] fn restart_retains_monitor_settings_and_finished_session() {
        let mut j = fixture(); let launch = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&launch,"one"); j.recordings[0].status = "completed".into();
        let mut restored: Journal = serde_json::from_slice(&serde_json::to_vec(&j).unwrap()).unwrap(); recover(&mut restored);
        assert!(!restored.monitors[0].checking); assert_eq!(restored.monitors[0].next_check,0); assert!(check(&mut restored,broadcast("123")).is_none());
        assert_eq!(restored.monitors[0].request.root,"C:\\QA");
        let legacy = serde_json::json!({"version":1,"generation":4,"subscriptions":[],"deliveries":[],"recordings":[]});
        assert!(serde_json::from_value::<Journal>(legacy).unwrap().monitors.is_empty());
    }
    #[test] fn interrupted_recording_can_resume_with_remaining_budget() {
        let mut j = fixture(); let launch = check(&mut j,broadcast("123")).unwrap(); record(&mut j,&launch,"one"); j.recordings[0].elapsed = 30; j.recordings[0].status = "interrupted".into(); recover(&mut j);
        assert!(check(&mut j,broadcast("123")).is_some()); assert_eq!(budget(&j,&j.monitors[0],"123").unwrap().seconds,90);
    }
}

/// Opt-in real-network test. The separate app ID persists across two invocations
/// so the second process verifies durable recovery and same-session suppression.
#[cfg(feature = "team-smoke")]
pub fn run_smoke() {
    let name = std::env::var("PAOLIANG_MONITOR_SMOKE_ID").expect("set isolated test id");
    assert!(!name.is_empty() && name.len() <= 60 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("org.yinglian.monitor-smoke-{name}");
    context.config_mut().app.windows.clear();
    let exit = Arc::new(std::sync::atomic::AtomicI32::new(3)); let final_exit = exit.clone();
    tauri::Builder::default().setup(move |app| {
        network::init(app.handle())?;
        if let Ok(proxy) = std::env::var("PAOLIANG_MONITOR_PROXY") {
            tauri::async_runtime::block_on(network::save_network_settings(app.handle().clone(),network::Config { mode:"manual".into(),address:proxy,overseas_only:true }))?;
        }
        if std::env::var_os("PAOLIANG_MONITOR_USE_APP_SESSION").is_some() {
            let source = PathBuf::from(std::env::var("LOCALAPPDATA")?).join("org.yinglian.desktop.preview/browser/edge-user-data/platform-sessions.dpapi");
            let destination = edge_profile_dir(app.handle())?;
            fs::create_dir_all(&destination)?; fs::copy(source,destination.join("platform-sessions.dpapi"))?;
        }
        automation::start(app.handle())?;
        let app = app.handle().clone();
        thread::spawn(move || {
            let verify = std::env::var_os("PAOLIANG_MONITOR_VERIFY_RESTART").is_some();
            let result = (|| -> Result<Value,String> {
                let state = app.state::<AutomationState>();
                let initial = state.journal.lock().unwrap().clone();
                if verify {
                    if initial.monitors.len() != 1 || initial.recordings.is_empty() { return Err("restart fixture missing".into()); }
                } else {
                    if !initial.monitors.is_empty() { return Err("use a fresh isolated test id".into()); }
                    let request = MonitorRequest { recording:LiveRequest { url:std::env::var("PAOLIANG_MONITOR_URL").map_err(|e|e.to_string())?,name:"真实主页开播监控验收".into(),root:std::env::var("PAOLIANG_MONITOR_OUTPUT").map_err(|e|e.to_string())?,category:"验收".into(),minutes:1,max_gb:1 },interval_seconds:60 };
                    tauri::async_runtime::block_on(live_monitor_add(app.clone(),request))?;
                }
                let start = std::time::Instant::now(); let mut stopped = verify; let mut after_check = automation::now();
                let mut first_data: Option<std::time::Instant> = None;
                let mut current_record = String::new();
                if verify { state.edit(|j| { j.monitors[0].next_check = 0; Ok(()) })?; }
                loop {
                    let j = state.journal.lock().unwrap().clone(); let m = &j.monitors[0];
                    if let Some(r) = j.recordings.first() {
                        if r.id != current_record { current_record = r.id.clone(); first_data = None; }
                        if r.bytes > 0 && first_data.is_none() { first_data = Some(std::time::Instant::now()); }
                        if !stopped && r.bytes > 0 && active_record(&r.status) && first_data.map(|t| t.elapsed() >= Duration::from_secs(12)).unwrap_or(false) {
                            automation::live_stop(app.state::<AutomationState>(),r.id.clone())?;
                            stopped = true; after_check = automation::now();
                            state.edit(|j| { j.monitors[0].next_check = 0; Ok(()) })?;
                        }
                        if !stopped && r.status == "completed" && r.bytes > 0 { stopped = true; after_check = automation::now(); state.edit(|j| { j.monitors[0].next_check = 0; Ok(()) })?; }
                        if stopped && !active_record(&r.status) && m.last_checked >= after_check && !m.checking && m.failures == 0 {
                            if j.recordings.len() > 3 || (verify && j.recordings.len() != initial.recordings.len()) || r.status != "completed" || r.bytes == 0 { return Err(format!("unexpected recording state {} count={} bytes={}",r.status,j.recordings.len(),r.bytes)); }
                            let disk = automation::load(&app.path().app_data_dir().map_err(|e|e.to_string())?)?;
                            if disk.monitors.len() != 1 || disk.monitors[0].finished_session != r.session_id { return Err("monitor receipt not durable".into()); }
                            return Ok(serde_json::json!({"passed":true,"restart":verify,"recordings":j.recordings.len(),"status":r.status,"bytes":r.bytes,"elapsed":r.elapsed,"output":r.output_dir,"detail":m.detail,"profile":m.request.url,"session_id":r.session_id}));
                        }
                    }
                    if start.elapsed() > Duration::from_secs(480) { return Err(format!("monitor timeout: {}",m.detail)); }
                    thread::sleep(Duration::from_millis(300));
                }
            })();
            match &result { Ok(value) => println!("MONITOR_RESULT {value}"),Err(e) => println!("MONITOR_FAIL {}",live::safe_error(e)) }
            automation::shutdown(&app);
            if verify { if let Ok(root) = edge_profile_dir(&app) { let _ = fs::remove_file(root.join("platform-sessions.dpapi")); } }
            let code = if result.is_ok() { 0 } else { 1 }; exit.store(code,Ordering::SeqCst); app.exit(code);
        }); Ok(())
    }).run(context).expect("live monitor acceptance app");
    process::exit(final_exit.load(Ordering::SeqCst));
}
