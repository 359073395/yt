//! Durable subscriptions and live jobs. Media files are never deleted by this module.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub id: String, pub name: String, pub url: String, pub category: String,
    pub interval_minutes: u64, pub limit: usize, pub include_existing: bool,
    pub auto_download: bool, pub enabled: bool, pub initialized: bool,
    pub last_checked: u64, pub next_check: u64, pub detail: String,
    pub checking: bool, pub failures: u32, pub seen: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Delivery {
    pub id: String, pub subscription_id: String, pub url: String, pub title: String,
    pub category: String, pub note: String, pub auto_download: bool, pub created: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String, pub url: String, pub name: String, pub category: String,
    pub output_dir: String, pub status: String, pub detail: String,
    pub created: u64, pub elapsed: u64, pub bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Journal {
    version: u32, generation: u64, pub subscriptions: Vec<Subscription>,
    pub deliveries: Vec<Delivery>, pub recordings: Vec<Recording>,
}
impl Default for Journal {
    fn default() -> Self { Self { version: 1, generation: 0, subscriptions: vec![], deliveries: vec![], recordings: vec![] } }
}
pub struct AutomationState {
    root: PathBuf, pub journal: Mutex<Journal>, pub error: Mutex<String>,
    pub stops: Mutex<HashMap<String, Arc<AtomicBool>>>, pub quitting: AtomicBool,
}
pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn load(root: &Path) -> Result<Journal, String> {
    let mut found = false;
    let mut valid = vec![];
    for slot in 0..2 {
        let path = root.join(format!("automation.{slot}.json"));
        if path.exists() {
            found = true;
            if let Ok(bytes) = fs::read(&path) {
                if bytes.len() <= 32 * 1024 * 1024 {
                    if let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) {
                        if journal.version == 1 { valid.push(journal); }
                    }
                }
            }
        }
    }
    match valid.into_iter().max_by_key(|j| j.generation) {
        Some(j) => Ok(j), None if !found => Ok(Journal::default()),
        None => Err("订阅/录制记录损坏或版本不兼容，已停止后台操作，原文件未覆盖".into()),
    }
}
fn save(root: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    if bytes.len() > 32 * 1024 * 1024 { return Err("订阅记录超过 32 MB，请先处理待收视频".into()); }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut file = File::create(root.join(format!("automation.{}.json", journal.generation % 2))).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("后台任务保存失败：{e}"))
}
impl AutomationState {
    pub fn edit<T>(&self, change: impl FnOnce(&mut Journal) -> Result<T, String>) -> Result<T, String> {
        let blocked = self.error.lock().unwrap().clone();
        if !blocked.is_empty() { return Err(blocked); }
        let mut current = self.journal.lock().unwrap();
        let mut next = current.clone();
        let value = change(&mut next)?;
        next.generation += 1;
        if let Err(error) = save(&self.root, &next) {
            *self.error.lock().unwrap() = error.clone();
            return Err(error);
        }
        *current = next;
        Ok(value)
    }
    pub fn update_record(&self, id: &str, status: &str, detail: &str, elapsed: u64, bytes: u64) -> Result<(), String> {
        self.edit(|j| {
            let r = j.recordings.iter_mut().find(|r| r.id == id).ok_or("录制记录不存在")?;
            r.status = status.into(); r.detail = detail.into(); r.elapsed = elapsed; r.bytes = bytes; Ok(())
        })
    }
}
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (mut journal, error) = match load(&root) { Ok(j) => (j, String::new()), Err(e) => (Journal::default(), e) };
    for s in &mut journal.subscriptions { s.checking = false; }
    for r in &mut journal.recordings {
        if active_record(&r.status) { r.status = "interrupted".into(); r.detail = "上次录制中断；已写入的分段保留，请打开文件夹检查".into(); }
    }
    app.manage(AutomationState { root, journal: Mutex::new(journal), error: Mutex::new(error), stops: Mutex::new(HashMap::new()), quitting: AtomicBool::new(false) });
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<AutomationState>();
        while !state.quitting.load(Ordering::Relaxed) {
            let next = if state.error.lock().unwrap().is_empty() {
                state.journal.lock().unwrap().subscriptions.iter().find(|s| s.enabled && !s.checking && s.next_check <= now()).cloned()
            } else { None };
            if let Some(subscription) = next {
                if state.edit(|j| { if let Some(s) = j.subscriptions.iter_mut().find(|s| s.id == subscription.id) { s.checking = true; s.detail = "正在检查公开作品…".into(); } Ok(()) }).is_ok() {
                    let result = scan_profile_sync(&app, ProfileRequest { url: subscription.url.clone(), limit: subscription.limit });
                    let _ = state.edit(|j| apply_scan(j, &subscription.id, result, now()));
                }
            }
            for _ in 0..10 { if state.quitting.load(Ordering::Relaxed) { break; } thread::sleep(Duration::from_millis(500)); }
        }
    });
    Ok(())
}
fn key(item: &ProfileItem) -> String {
    if !item.id.is_empty() { return format!("id:{}", item.id); }
    let mut url = Url::parse(&item.url).ok();
    if let Some(u) = &mut url { u.set_fragment(None); }
    url.map(|u| u.to_string()).unwrap_or_else(|| item.url.clone())
}
fn apply_scan(j: &mut Journal, id: &str, result: Result<Vec<ProfileItem>, String>, time: u64) -> Result<(), String> {
    let Some(s) = j.subscriptions.iter_mut().find(|s| s.id == id) else { return Ok(()); };
    s.checking = false;
    if !s.enabled { return Ok(()); }
    s.last_checked = time;
    match result {
        Err(error) => {
            s.failures = s.failures.saturating_add(1);
            s.next_check = time + (s.interval_minutes * 60 * (1u64 << s.failures.min(4))).min(24 * 3600);
            s.detail = format!("检查失败：{}；稍后重试", error.chars().take(300).collect::<String>());
        }
        Ok(items) => {
            let baseline = !s.initialized && !s.include_existing;
            let mut seen: HashSet<_> = s.seen.iter().cloned().collect();
            let mut additions = vec![];
            let mut new_keys = vec![];
            for item in items {
                let k = key(&item);
                if seen.insert(k.clone()) {
                    new_keys.push(k);
                    if !baseline { additions.push(Delivery { id: uuid::Uuid::new_v4().to_string(), subscription_id: s.id.clone(), url: item.url, title: item.title, category: s.category.clone(), note: format!("订阅：{}", s.name), auto_download: s.auto_download, created: time }); }
                }
            }
            if j.deliveries.len() + additions.len() > 5000 || s.seen.len() + new_keys.len() > 100_000 {
                s.enabled = false; s.detail = "待收记录或去重记录达到上限，已暂停；未将新作品标记为已收，请处理后继续".into(); return Ok(());
            }
            s.seen.extend(new_keys);
            s.initialized = true; s.failures = 0; s.next_check = time + s.interval_minutes * 60;
            s.detail = if baseline { format!("已建立基线，{} 条已有作品不补下；以后收集新增", s.seen.len()) } else { format!("发现 {} 条新作品，已加入待收队列", additions.len()) };
            j.deliveries.extend(additions);
        }
    }
    Ok(())
}
#[derive(Deserialize)]
pub struct SubscriptionRequest {
    name: String, url: String, category: String, interval_minutes: u64,
    limit: usize, include_existing: bool, auto_download: bool,
}
#[derive(Serialize)]
pub struct Snapshot { pub subscriptions: Vec<Subscription>, pub deliveries: Vec<Delivery>, pub recordings: Vec<Recording>, error: String }
#[tauri::command]
pub fn automation_snapshot(state: State<AutomationState>) -> Snapshot {
    let error = state.error.lock().unwrap().clone();
    let j = state.journal.lock().unwrap();
    // Seen IDs are native-only; do not send large histories every poll.
    let subscriptions = j.subscriptions.iter().cloned().map(|mut s| { s.seen.clear(); s }).collect();
    Snapshot { subscriptions, deliveries: j.deliveries.clone(), recordings: j.recordings.clone(), error }
}
#[tauri::command]
pub async fn subscription_add(app: tauri::AppHandle, request: SubscriptionRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = validate_url(&request.url)?;
        library::category_path(Path::new("validation"), &request.category)?;
        if !(15..=1440).contains(&request.interval_minutes) || !(1..=500).contains(&request.limit) { return Err("检查间隔为 15～1440 分钟，每次扫描 1～500 条".into()); }
        if request.name.trim().is_empty() || request.name.chars().count() > 80 { return Err("请填写不超过 80 字的订阅名称".into()); }
        app.state::<AutomationState>().edit(|j| {
            if j.subscriptions.len() >= 100 { return Err("最多添加 100 个订阅".into()); }
            if j.subscriptions.iter().any(|s| s.url == url) { return Err("这个主页已订阅".into()); }
            j.subscriptions.push(Subscription { id: uuid::Uuid::new_v4().to_string(), name: request.name.trim().into(), url, category: request.category, interval_minutes: request.interval_minutes, limit: request.limit, include_existing: request.include_existing, auto_download: request.auto_download, enabled: true, initialized: false, last_checked: 0, next_check: 0, detail: "等待首次检查".into(), checking: false, failures: 0, seen: vec![] }); Ok(())
        })
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn subscription_action(app: tauri::AppHandle, id: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AutomationState>().edit(|j| {
        let s = j.subscriptions.iter_mut().find(|s| s.id == id).ok_or("订阅不存在")?;
        match action.as_str() {
            "toggle" => { s.enabled = !s.enabled; if s.enabled { s.next_check = 0; } },
            "check" => { if !s.enabled { return Err("请先恢复订阅".into()); } s.next_check = 0; },
            "remove" => { j.subscriptions.retain(|s| s.id != id); },
            _ => return Err("未知订阅操作".into()),
        } Ok(())
    })).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn automation_ack(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AutomationState>();
        let ids: HashSet<_> = ids.into_iter().collect();
        if !state.journal.lock().unwrap().deliveries.iter().any(|d| ids.contains(&d.id)) { return Ok(()); }
        state.edit(|j| { j.deliveries.retain(|d| !ids.contains(&d.id)); Ok(()) })
    }).await.map_err(|e| e.to_string())?
}
pub fn active_record(status: &str) -> bool { matches!(status, "resolving" | "recording" | "stopping") }
pub fn enabled(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<AutomationState>() else { return false; };
    let j = state.journal.lock().unwrap();
    j.subscriptions.iter().any(|s| s.enabled) || j.recordings.iter().any(|r| active_record(&r.status))
}
pub fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<AutomationState>();
    state.quitting.store(true, Ordering::Relaxed);
    for stop in state.stops.lock().unwrap().values() { stop.store(true, Ordering::Relaxed); }
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !state.stops.lock().unwrap().is_empty() && std::time::Instant::now() < deadline { thread::sleep(Duration::from_millis(100)); }
}
#[derive(Deserialize)]
pub struct LiveRequest { pub url: String, pub name: String, pub root: String, pub category: String, pub minutes: u64, pub max_gb: u64 }
#[tauri::command]
pub async fn live_start(app: tauri::AppHandle, request: LiveRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = validate_url(&request.url)?;
        if !(1..=360).contains(&request.minutes) || !(1..=50).contains(&request.max_gb) { return Err("录制时长 1～360 分钟，容量上限 1～50 GB".into()); }
        if request.name.chars().count() > 80 { return Err("名称不超过 80 字".into()); }
        find_tool(&app, "ffmpeg.exe").ok_or("FFmpeg 尚未就绪")?;
        let state = app.state::<AutomationState>();
        if state.quitting.load(Ordering::Relaxed) { return Err("程序正在退出".into()); }
        let id = uuid::Uuid::new_v4().to_string();
        let root = PathBuf::from(&request.root);
        if !root.is_absolute() { return Err("请选择绝对保存路径".into()); }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let parent = library::category_path(&root, &request.category)?.join("直播");
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        if !parent.starts_with(&root) { return Err("分类路径超出保存目录".into()); }
        let output = parent.join(format!("录制_{}_[{}]", now(), &id[..8]));
        fs::create_dir(&output).map_err(|e| e.to_string())?;
        state.edit(|j| {
            if j.recordings.iter().filter(|r| active_record(&r.status)).count() >= 2 { return Err("最多同时录制 2 个直播间".into()); }
            if j.recordings.iter().any(|r| active_record(&r.status) && r.url == url) { return Err("该直播间正在录制或连接".into()); }
            j.recordings.insert(0, Recording { id: id.clone(), url, name: if request.name.trim().is_empty() { "直播录制".into() } else { request.name.clone() }, category: request.category.clone(), output_dir: visible_directory(&output), status: "resolving".into(), detail: "正在连接官方直播源，最多等待 60 秒…".into(), created: now(), elapsed: 0, bytes: 0 }); Ok(())
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        state.stops.lock().unwrap().insert(id.clone(), stop.clone());
        let job_id = id.clone();
        thread::spawn(move || {
            let result = live::record(&app, &job_id, &request, &output, &stop);
            let state = app.state::<AutomationState>();
            if let Err(error) = result {
                let bytes = live::folder_bytes(&output);
                let _ = state.update_record(&job_id, if bytes > 0 { "partial" } else if stop.load(Ordering::Relaxed) { "cancelled" } else { "failed" }, &error, 0, bytes);
            }
            state.stops.lock().unwrap().remove(&job_id);
        });
        Ok(id)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn live_stop(state: State<AutomationState>, id: String) -> Result<(), String> {
    let stop = state.stops.lock().unwrap().get(&id).cloned().ok_or("该录制已结束")?;
    stop.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(include_existing: bool) -> Journal {
        let mut j = Journal::default();
        j.subscriptions.push(Subscription { id:"s".into(), name:"test".into(), url:"https://example.com".into(), category:"测试".into(), interval_minutes:15, limit:50, include_existing, auto_download:true, enabled:true, initialized:false, last_checked:0, next_check:0, detail:String::new(), checking:true, failures:0, seen:vec![] }); j
    }
    fn item(id: &str) -> ProfileItem { ProfileItem { id:id.into(), url:format!("https://example.com/{id}"), title:id.into() } }
    #[test]
    fn baseline_incremental_and_duplicate_scan_are_atomic() {
        let mut j = fixture(false);
        apply_scan(&mut j,"s",Ok(vec![item("a")]),100).unwrap(); assert!(j.deliveries.is_empty());
        apply_scan(&mut j,"s",Ok(vec![item("b"),item("a"),item("b")]),200).unwrap(); assert_eq!(j.deliveries.len(),1);
        assert_eq!(j.deliveries[0].title,"b"); assert_eq!(j.subscriptions[0].seen.len(),2);
        apply_scan(&mut j,"s",Ok(vec![item("b")]),300).unwrap(); assert_eq!(j.deliveries.len(),1);
    }
    #[test]
    fn existing_opt_in_failure_and_pause() {
        let mut j = fixture(true);
        apply_scan(&mut j,"s",Err("登录失效".into()),100).unwrap(); assert!(!j.subscriptions[0].initialized); assert!(j.subscriptions[0].next_check > 1000);
        apply_scan(&mut j,"s",Ok(vec![item("a")]),200).unwrap(); assert_eq!(j.deliveries.len(),1);
        j.subscriptions[0].enabled = false;
        apply_scan(&mut j,"s",Ok(vec![item("b")]),300).unwrap(); assert_eq!(j.deliveries.len(),1);
    }
    #[test]
    fn recover_one_torn_snapshot_and_reject_both() {
        let root = std::env::temp_dir().join(format!("automation-test-{}",uuid::Uuid::new_v4()));
        let mut j = fixture(false); j.generation=1; save(&root,&j).unwrap(); j.generation=2; save(&root,&j).unwrap();
        fs::write(root.join("automation.0.json"),b"{").unwrap(); assert_eq!(load(&root).unwrap().generation,1);
        fs::write(root.join("automation.1.json"),b"{").unwrap(); assert!(load(&root).is_err());
        fs::remove_file(root.join("automation.0.json")).unwrap(); fs::remove_file(root.join("automation.1.json")).unwrap(); fs::remove_dir(root).unwrap();
    }
}

/// Explicitly opt-in real-network acceptance, with an isolated app identity and no real user jobs.
#[cfg(feature = "team-smoke")]
pub fn run_smoke() {
    let exit = Arc::new(std::sync::atomic::AtomicI32::new(3)); let final_exit = exit.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("org.yinglian.automation-smoke-{}", process::id());
    context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(move |app| {
        network::init(app.handle())?;
        start(app.handle())?;
        let app = app.handle().clone();
        thread::spawn(move || {
            let mut passed = true;
            if let Ok(url) = std::env::var("PAOLIANG_SMOKE_PROFILE") {
                let begin = std::time::Instant::now();
                let request = SubscriptionRequest { url, name:"订阅原生验收".into(), category:"验收".into(), interval_minutes:15, limit:3, include_existing:true, auto_download:false };
                match tauri::async_runtime::block_on(subscription_add(app.clone(),request)) {
                    Err(e) => { passed=false; println!("SUBSCRIPTION_ADD_FAIL {e}"); }
                    Ok(()) => loop {
                        let state = app.state::<AutomationState>();
                        let snapshot = state.journal.lock().unwrap().clone();
                        let s = &snapshot.subscriptions[0];
                        if s.initialized {
                            let deliveries = &snapshot.deliveries;
                            let disk = load(&state.root).unwrap();
                            if deliveries.len()!=3 || disk.deliveries.len()!=3 { passed=false; }
                            println!("SUBSCRIPTION_PASS count={} durable={} seconds={}",deliveries.len(),disk.deliveries.len(),begin.elapsed().as_secs());
                            let receipt_ids: Vec<_> = deliveries.iter().map(|d|d.id.clone()).collect();
                            let items: Vec<_> = deliveries.iter().map(|d|serde_json::json!({"id":format!("subscription-{}",d.id),"url":d.url,"automationId":d.id})).collect();
                            tauri::async_runtime::block_on(library::library_save(app.clone(),serde_json::json!({"version":1,"items":items,"tasks":[],"categories":["验收"]}))).unwrap();
                            tauri::async_runtime::block_on(automation_ack(app.clone(),receipt_ids)).unwrap();
                            let persisted = tauri::async_runtime::block_on(library::library_load(app.clone())).unwrap();
                            let pending = load(&state.root).unwrap().deliveries.len();
                            println!("HANDOFF_PASS library={} pending={pending}",persisted["items"].as_array().unwrap().len());
                            if pending!=0 {passed=false;}
                            break;
                        }
                        if s.failures>0 || begin.elapsed()>Duration::from_secs(160) {
                            passed=false; println!("SUBSCRIPTION_FAIL seconds={} reason={}",begin.elapsed().as_secs(),s.detail); break;
                        }
                        thread::sleep(Duration::from_millis(500));
                    }
                }
            }
            if let Ok(url) = std::env::var("PAOLIANG_SMOKE_LIVE") {
                let root = std::env::var("PAOLIANG_SMOKE_OUTPUT").unwrap_or_else(|_| std::env::temp_dir().join("paoliang-live-smoke").to_string_lossy().into());
                let request = LiveRequest { url, name:"真实网络验收".into(), root, category:"验收".into(), minutes:1, max_gb:1 };
                match tauri::async_runtime::block_on(live_start(app.clone(),request)) {
                    Err(e) => { passed=false; println!("LIVE_START_FAIL {e}"); }
                    Ok(id) => {
                        let start = std::time::Instant::now();
                        loop {
                            let state = app.state::<AutomationState>();
                            let record = state.journal.lock().unwrap().recordings.iter().find(|r| r.id==id).cloned().unwrap();
                            if !active_record(&record.status) {
                                println!("LIVE_RESULT status={} bytes={} seconds={} detail={} output={}",record.status,record.bytes,record.elapsed,record.detail,record.output_dir);
                                if record.status!="completed" || record.bytes==0 { passed=false; }
                                break;
                            }
                            if record.elapsed>=12 || start.elapsed()>Duration::from_secs(90) { if let Some(stop)=state.stops.lock().unwrap().get(&id) { stop.store(true,Ordering::Relaxed); } }
                            if start.elapsed()>Duration::from_secs(115) { passed=false; println!("LIVE_TIMEOUT"); break; }
                            thread::sleep(Duration::from_millis(500));
                        }
                    }
                }
            }
            shutdown(&app); let code=if passed {0}else{1}; exit.store(code,Ordering::SeqCst); app.exit(code);
        });
        Ok(())
    }).run(context).expect("automation acceptance application");
    process::exit(final_exit.load(Ordering::SeqCst));
}
