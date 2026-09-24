//! App-owned browser sessions. Never give the download engine a live browser database.
use super::*;

pub const PLATFORMS: [&str; 7] = ["douyin", "tiktok", "youtube", "bilibili", "instagram", "facebook", "twitter"];
static SYNC: Mutex<Option<(PathBuf, std::time::Instant, Result<(), String>)>> = Mutex::new(None);

#[derive(Clone, Serialize)]
pub struct AccountStatus {
    platform: String,
    state: String,
    detail: String,
}

pub struct CookieLease(pub PathBuf);
impl Drop for CookieLease {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}
fn temporary(root: &Path) -> Result<CookieLease, String> {
    let root = root.join("session-transfer");
    fs::create_dir_all(&root).map_err(|_| "无法创建会话临时目录")?;
    let path = root.join(format!("{}.txt", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "无法创建会话临时文件")?;
    let lease = CookieLease(path);
    file.write_all(b"# Netscape HTTP Cookie File\n").map_err(|_| "无法初始化会话临时文件")?;
    Ok(lease)
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> { edge_profile_dir(app) }
fn domain_matches(domain: &str, base: &str) -> bool { domain == base || domain.ends_with(&format!(".{base}")) }
pub fn platform_for_url(source: &str) -> Option<&'static str> {
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    PLATFORMS.into_iter().find(|platform| domains(platform).iter().any(|d| domain_matches(&host, d)))
}
fn domains(platform: &str) -> &'static [&'static str] {
    match platform {
        "douyin" => &["douyin.com", "iesdouyin.com"],
        "tiktok" => &["tiktok.com"],
        "youtube" => &["youtube.com", "youtu.be"],
        "bilibili" => &["bilibili.com", "b23.tv"],
        "instagram" => &["instagram.com"],
        "facebook" => &["facebook.com", "fb.watch"],
        "twitter" => &["x.com", "twitter.com", "t.co"],
        _ => &[],
    }
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

// Cookie names alone are not proof of server-side validity. UI deliberately says detected, not verified.
fn session_marker(platform: &str, names: &HashSet<&str>) -> bool {
    match platform {
        "douyin" | "tiktok" => names.contains("sessionid") || names.contains("sessionid_ss"),
        "youtube" => names.contains("SID") && (names.contains("SAPISID") || names.contains("__Secure-3PAPISID")),
        "bilibili" => names.contains("SESSDATA"),
        "instagram" => names.contains("sessionid"),
        "facebook" => names.contains("c_user") && names.contains("xs"),
        "twitter" => names.contains("auth_token"),
        _ => false,
    }
}
fn platform_jar(source: &str, platform: &str, at: u64) -> Option<String> {
    let mut names = HashSet::new();
    let mut lines = Vec::new();
    for line in source.lines() {
        if line.starts_with('#') && !line.starts_with("#HttpOnly_") { continue; }
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 7 || fields[6].is_empty() { continue; }
        let domain = fields[0].trim_start_matches("#HttpOnly_").trim_start_matches('.').to_ascii_lowercase();
        if !domains(platform).iter().any(|d| domain_matches(&domain, d)) { continue; }
        let expiry = if fields[4].is_empty() { 0 } else { match fields[4].parse::<u64>() { Ok(v) => v, Err(_) => continue } };
        if expiry != 0 && expiry <= at { continue; }
        if !matches!(fields[1], "TRUE" | "FALSE") || !matches!(fields[3], "TRUE" | "FALSE") || !fields[2].starts_with('/') { continue; }
        names.insert(fields[5]); lines.push(line);
    }
    session_marker(platform, &names).then(|| format!("# Netscape HTTP Cookie File\n{}\n", lines.join("\n")))
}
fn load(root: &Path) -> Result<HashMap<String, String>, String> {
    let path = root.join("platform-sessions.dpapi");
    if !path.exists() { return Ok(HashMap::new()); }
    if fs::metadata(&path).map_err(|_| "无法读取保存的会话")?.len() > 16 * 1024 * 1024 { return Err("保存的会话文件过大".into()); }
    let encrypted = fs::read_to_string(path).map_err(|_| "无法读取保存的会话")?;
    let text = unprotect_secret(&encrypted).map_err(|_| "本机无法解密保存的会话，请重新同步")?;
    serde_json::from_str(&text).map_err(|_| "保存的会话格式无效，请重新同步".into())
}
fn export(root: &Path, engine: &Path) -> Result<(), String> {
    if !root.join("Default/Network/Cookies").is_file() && !root.join("Default/Cookies").is_file() { return Ok(()); }
    let temp = temporary(root)?;
    let mut command = Command::new(engine);
    command.args(["--ignore-config", "--no-color", "--encoding", "utf-8", "--cookies-from-browser"])
        .arg(format!("edge:{}", root.join("Default").display())).arg("--cookies").arg(&temp.0);
    // No URL is passed: this only exports the application's local browser profile.
    let output = live::capture(&mut command, Duration::from_secs(15), &AtomicBool::new(false))?;
    let error = String::from_utf8_lossy(&output.stderr).to_lowercase();
    if error.contains("could not copy") || error.contains("permission denied") || error.contains("database is locked") {
        return Err("登录窗口正在占用会话，请关闭工坊打开的官方登录窗口后点“刷新状态”；不会关闭你的其他浏览器".into());
    }
    if error.contains("decrypt") || error.contains("dpapi") {
        return Err("浏览器会话解密失败，暂不能复用本次登录；公开内容仍可尝试匿名下载".into());
    }
    if fs::metadata(&temp.0).map_err(|_| "无法读取导出的会话")?.len() > 8 * 1024 * 1024 { return Err("导出的会话文件过大".into()); }
    let text = fs::read_to_string(&temp.0).map_err(|_| "无法读取导出的会话")?;
    // yt-dlp may report no URLs after successfully writing the requested cookie file.
    if (!output.status.success() && !error.contains("you must provide at least one url"))
        || (!text.starts_with("# Netscape HTTP Cookie File") && !text.starts_with("# HTTP Cookie File")) {
        return Err("没有读到有效会话，请关闭官方登录窗口后重新同步".into());
    }
    let sessions: HashMap<_, _> = PLATFORMS.into_iter().filter_map(|p| platform_jar(&text, p, now()).map(|jar| (p, jar))).collect();
    let encrypted = protect_secret(&serde_json::to_string(&sessions).map_err(|_| "会话序列化失败")?).map_err(|_| "无法加密保存会话")?;
    // The original browser profile remains intact even if this derived cache cannot be saved.
    let encrypted_temp = temporary(root)?;
    fs::write(&encrypted_temp.0, encrypted).map_err(|_| "无法保存加密会话")?;
    team::move_owned(&encrypted_temp.0, &root.join("platform-sessions.dpapi"), true).map_err(|_| "无法更新加密会话")?;
    Ok(())
}
pub fn sync(app: &tauri::AppHandle, force: bool) -> Result<(), String> {
    let root = root(app)?;
    let mut last = SYNC.lock().map_err(|_| "会话检查忙")?;
    if !force {
        if let Some((path, time, result)) = last.as_ref() {
            if path == &root && time.elapsed() < Duration::from_secs(5) { return result.clone(); }
        }
    }
    let result = find_tool(app, "yt-dlp.exe").ok_or("下载引擎未就绪".into()).and_then(|engine| export(&root, &engine));
    *last = Some((root, std::time::Instant::now(), result.clone()));
    result
}
pub fn has_session(app: &tauri::AppHandle, platform: &str) -> bool {
    root(app).ok().and_then(|r| load(&r).ok()).and_then(|s| s.get(platform).and_then(|jar| platform_jar(jar, platform, now()))).is_some()
}
pub fn for_download(app: &tauri::AppHandle, source: &str) -> Option<CookieLease> {
    let platform = platform_for_url(source)?;
    if let Err(error) = sync(app, false) { runtime_log(app, format!("account_sync_pending platform={platform} detail={error}")); }
    let root = root(app).ok()?;
    let sessions = load(&root).ok()?;
    let jar = platform_jar(sessions.get(platform)?, platform, now())?;
    let temp = temporary(&root).ok()?;
    fs::write(&temp.0, jar).ok()?;
    Some(temp)
}
#[tauri::command]
pub async fn account_statuses(app: tauri::AppHandle, refresh: Option<bool>) -> Result<Vec<AccountStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = sync(&app, refresh.unwrap_or(false));
        let sessions = load(&root(&app)?)?;
        Ok(PLATFORMS.into_iter().map(|platform| {
            let detected = sessions.get(platform).and_then(|s| platform_jar(s, platform, now())).is_some();
            let (state, detail) = match (&result, detected) {
                (Ok(()), true) => ("detected", "已检测到登录会话；是否有效以平台实际响应为准".into()),
                (Ok(()), false) => ("anonymous", "未检测到登录会话，可下载允许匿名访问的公开内容".into()),
                (Err(error), true) => ("cached", format!("已保存会话，暂未同步最新状态。{error}")),
                (Err(error), false) => ("pending", error.clone()),
            };
            AccountStatus { platform: platform.into(), state: state.into(), detail }
        }).collect())
    }).await.map_err(|_| "会话检查任务异常".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cookie(domain: &str, name: &str, expiry: u64) -> String { format!("{domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\tunit-value\n") }
    #[test] fn anonymous_cookie_is_not_login() { assert!(platform_jar(&cookie(".douyin.com", "ttwid", 0), "douyin", 10).is_none()); }
    #[test] fn sessions_are_platform_scoped() {
        let jar = cookie(".douyin.com", "sessionid", 0) + &cookie(".tiktok.com", "sessionid", 0);
        let scoped = platform_jar(&jar, "douyin", 10).unwrap();
        assert!(scoped.contains(".douyin.com")); assert!(!scoped.contains("tiktok"));
        assert!(platform_jar(&jar, "instagram", 10).is_none());
    }
    #[test] fn expired_and_untrusted_domains_are_not_login() {
        for jar in [cookie(".douyin.com", "sessionid", 5), cookie(".douyin.com.evil.test", "sessionid", 0), cookie(".notdouyin.com", "sessionid", 0)] { assert!(platform_jar(&jar, "douyin", 10).is_none()); }
        assert!(platform_for_url("https://douyin.com.evil.test/video/1").is_none());
    }
    #[test] fn supports_http_only_and_short_links() {
        assert!(platform_jar(&cookie("#HttpOnly_.bilibili.com", "SESSDATA", 0), "bilibili", 10).is_some());
        assert_eq!(platform_for_url("https://b23.tv/test"), Some("bilibili"));
        assert_eq!(platform_for_url("https://youtu.be/test"), Some("youtube"));
    }
    #[test] fn facebook_requires_both_session_parts() {
        let jar = cookie(".facebook.com", "c_user", 0);
        assert!(platform_jar(&jar, "facebook", 1).is_none());
        assert!(platform_jar(&(jar + &cookie(".facebook.com", "xs", 0)), "facebook", 1).is_some());
    }
    #[test] fn temporary_cookie_is_removed_on_drop() {
        let root = std::env::temp_dir().join(format!("paoliang-cookie-test-{}", uuid::Uuid::new_v4()));
        let file = temporary(&root).unwrap(); let path = file.0.clone(); assert!(path.exists()); drop(file); assert!(!path.exists());
        fs::remove_dir(root.join("session-transfer")).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[cfg(target_os = "windows")]
    #[test] fn locked_browser_db_preserves_encrypted_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/bin/yt-dlp.exe");
        if !engine.is_file() { return; }
        let root = std::env::temp_dir().join(format!("paoliang-lock-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("Default/Network")).unwrap();
        let cookie_path = root.join("Default/Network/Cookies");
        let mut locked = OpenOptions::new().create_new(true).write(true).share_mode(0).open(&cookie_path).unwrap();
        locked.write_all(b"test-locked-db").unwrap();
        let jar = platform_jar(&cookie(".douyin.com", "sessionid", 0), "douyin", now()).unwrap();
        let stored = serde_json::to_string(&HashMap::from([("douyin", jar)])).unwrap();
        fs::write(root.join("platform-sessions.dpapi"), protect_secret(&stored).unwrap()).unwrap();
        assert!(export(&root, &engine).unwrap_err().contains("占用会话"));
        assert!(load(&root).unwrap().contains_key("douyin"));
        assert_eq!(fs::read_dir(root.join("session-transfer")).unwrap().count(), 0);
        drop(locked);
        for file in [cookie_path, root.join("platform-sessions.dpapi")] { fs::remove_file(file).unwrap(); }
        for dir in [root.join("Default/Network"), root.join("Default"), root.join("session-transfer"), root] { fs::remove_dir(dir).unwrap(); }
    }
}

/// Opt-in native reproduction: app-owned trial session only, no Feishu worker or user job mutation.
#[cfg(feature = "team-smoke")]
pub fn run_smoke() {
    assert_eq!(std::env::var("PAOLIANG_ACCOUNT_SMOKE").as_deref(), Ok("1"), "explicit opt-in required");
    let urls: Vec<String> = std::env::var("PAOLIANG_ACCOUNT_URLS").expect("test URLs required").split('|').map(str::to_string).collect();
    let output = std::env::var("PAOLIANG_ACCOUNT_OUTPUT").expect("test output directory required");
    let exit = Arc::new(std::sync::atomic::AtomicI32::new(3)); let final_exit = exit.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "org.yinglian.desktop.preview".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(move |app| {
        network::init(app.handle())?;
        let app = app.handle().clone();
        thread::spawn(move || {
            let statuses = tauri::async_runtime::block_on(account_statuses(app.clone(), Some(true)));
            match statuses {
                Ok(rows) => { for row in rows { println!("ACCOUNT platform={} state={} detail={}", row.platform, row.state, row.detail); } }
                Err(error) => println!("ACCOUNT_FAIL {error}"),
            }
            let engine = find_tool(&app, "yt-dlp.exe").expect("download engine required");
            let state = RuntimeState { processes: Arc::default(), cancelled: Arc::default(), cancel_model: Arc::new(AtomicBool::new(false)), model_root: Arc::new(RwLock::new(PathBuf::from(&output))), model_server_url: String::new() };
            app.manage(state.clone());
            let mut passed = true;
            for (index, url) in urls.into_iter().enumerate() {
                let begin = std::time::Instant::now();
                if std::env::var_os("PAOLIANG_INBOX_REPLAY").is_some() {
                    match team::replay_download(&app,&url,&output) {
                        Ok(path) => println!("INBOX_REPLAY_PASS index={index} seconds={} output={path}",begin.elapsed().as_secs()),
                        Err(error) => { passed=false; println!("INBOX_REPLAY_FAIL index={index} error={error}"); }
                    }
                    continue;
                }
                let preview = inspect_item(&app, &engine, url.clone());
                if let Some(error) = preview.error { println!("PREVIEW_FAIL index={index} error={error}"); passed = false; continue; }
                println!("PREVIEW_PASS index={index} seconds={} thumbnail={}", begin.elapsed().as_secs(), preview.thumbnail.is_some());
                let request = DownloadRequest { job_id: uuid::Uuid::new_v4().to_string(), url,
                    options: DownloadOptions { download_dir: output.clone(), category: Some("登录修复验收".into()), quality: "720".into(), include_video: true, include_thumbnail: true, include_original_subtitle: false, transcript_mode: "off".into(), language: "auto".into(), model_id: "small".into() } };
                match execute_download(app.clone(), state.clone(), request) {
                    Ok(result) => {
                        let path = PathBuf::from(&result.output_dir);
                        let files: Vec<_> = fs::read_dir(&path).unwrap().filter_map(Result::ok).map(|f| f.path()).collect();
                        let videos: Vec<_> = files.iter().filter(|p| p.extension().and_then(|v| v.to_str()).is_some_and(|v| ["mp4", "mkv", "webm"].contains(&v))).collect();
                        let cover = ["封面.jpg", "封面.jpeg", "封面.png", "封面.webp"].iter().any(|name| path.join(name).is_file());
                        if videos.is_empty() || !cover { passed = false; }
                        println!("DOWNLOAD_PASS index={index} seconds={} videos={} cover={cover} output={}", begin.elapsed().as_secs(), videos.len(), result.output_dir);
                    }
                    Err(error) => { passed = false; println!("DOWNLOAD_FAIL index={index} error={error}"); }
                }
            }
            let code = if passed { 0 } else { 1 }; exit.store(code, Ordering::SeqCst); app.exit(code);
        }); Ok(())
    }).run(context).expect("account acceptance application");
    process::exit(final_exit.load(Ordering::SeqCst));
}
