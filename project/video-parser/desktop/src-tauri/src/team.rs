//! Personal Feishu inbox. No relay server or shared company credentials.
#[path = "feishu.rs"]
mod feishu;
#[path = "feishu_registration.rs"]
mod registration;
use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;

// Windows EFS can reject std::fs::rename with ERROR_NOT_SAME_DEVICE within a directory.
pub(super) fn move_owned(source: &Path, target: &Path, replace: bool) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let flags = MOVEFILE_WRITE_THROUGH
            | if replace {
                MOVEFILE_REPLACE_EXISTING
            } else {
                0
            };
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if !replace && target.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "target exists",
            ));
        }
        fs::rename(source, target)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub app_id: String,
    pub device_name: String,
    pub root: String,
    pub enabled: bool,
    pub copy: bool,
    pub provider: String,
    pub model_id: String,
    pub quality: String,
    pub language: String,
    pub subtitle: bool,
    pub transcript_mode: String,
    #[serde(default)]
    proof: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    chat_id: String,
    #[serde(default)]
    history_until: u64,
    #[serde(default)]
    bound_at: u64,
    #[serde(default)]
    session: Value,
    onboarding: bool,
    setup_message_sent: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            device_name: std::env::var("COMPUTERNAME").unwrap_or("我的电脑".into()),
            root: String::new(),
            enabled: false,
            copy: true,
            provider: "api".into(),
            model_id: "small".into(),
            quality: "1080".into(),
            language: "auto".into(),
            subtitle: true,
            transcript_mode: "auto".into(),
            proof: String::new(),
            owner: String::new(),
            chat_id: String::new(),
            history_until: 0,
            bound_at: 0,
            session: Value::Null,
            onboarding: false,
            setup_message_sent: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct LocalJob {
    id: String,
    device_id: String,
    remote: Value,
    root: String,
    category: String,
    stage: String,
    detail: String,
    lease: String,
    result: Option<DownloadResult>,
    #[serde(default)]
    options: Config,
    #[serde(default)]
    move_to: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Journal {
    config: Config,
    jobs: BTreeMap<String, LocalJob>,
    #[serde(default)]
    messages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    notices: BTreeMap<String, feishu::Notice>,
}
#[derive(Serialize, Deserialize)]
struct SnapshotFile {
    generation: u64,
    data: Journal,
}
fn load_journal(path: &Path) -> Result<(Journal, u64), String> {
    let mut latest: Option<SnapshotFile> = None;
    let mut found = false;
    for slot in [path.with_extension("0.json"), path.with_extension("1.json")] {
        if slot.exists() {
            found = true;
            if let Ok(snapshot) = fs::read(&slot)
                .ok()
                .and_then(|b| serde_json::from_slice::<SnapshotFile>(&b).ok())
                .ok_or(())
            {
                if latest
                    .as_ref()
                    .map_or(true, |v| v.generation < snapshot.generation)
                {
                    latest = Some(snapshot);
                }
            }
        }
    }
    if let Some(snapshot) = latest {
        return Ok((snapshot.data, snapshot.generation));
    }
    if path.exists() {
        return serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map(|d| (d, 0))
            .map_err(|_| "收件状态损坏，请保留文件联系管理员".into());
    }
    if found {
        return Err("两份收件快照均损坏，请保留文件联系管理员".into());
    }
    Ok((Journal::default(), 0))
}
#[derive(Clone)]
pub struct TeamState {
    data: Arc<Mutex<Journal>>,
    path: PathBuf,
    generation: Arc<AtomicU64>,
    error: Arc<Mutex<String>>,
    active: Arc<AtomicBool>,
    writing: Arc<AtomicBool>,
    connection: Arc<Mutex<String>>,
    pair: Arc<Mutex<Option<feishu::Pairing>>>,
    registration: Arc<Mutex<Option<registration::Registration>>>,
}
impl TeamState {
    fn save(&self, data: &Journal) -> Result<(), String> {
        // Alternating flushed snapshots preserve the previous complete state if a write
        // is interrupted, including on encrypted Windows folders that reject renames.
        let generation = self.generation.load(Ordering::SeqCst) + 1;
        let slot = self.path.with_extension(format!("{}.json", generation % 2));
        let bytes = serde_json::to_vec(&json!({"generation":generation,"data":data}))
            .map_err(|e| e.to_string())?;
        let mut file = File::create(&slot).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        self.generation.store(generation, Ordering::SeqCst);
        Ok(())
    }
    fn update(&self, id: &str, f: impl FnOnce(&mut LocalJob)) -> Result<(), String> {
        let mut d = self.data.lock().map_err(|_| "收件状态不可用")?;
        let mut next = d.clone();
        f(next.jobs.get_mut(id).ok_or("任务不存在")?);
        self.save(&next)?;
        *d = next;
        Ok(())
    }
    fn error(&self, text: String) {
        if let Ok(mut e) = self.error.lock() {
            *e = text;
        }
    }
}
fn safe_category(value: &str) -> Result<String, String> {
    let s = value.trim();
    if s.is_empty() || s.chars().count() > 120 || s.split('/').count() > 5 {
        return Err("分类须为 1–120 个字，最多 5 层目录".into());
    }
    for part in s.split('/') {
        let upper = part.split('.').next().unwrap_or("").to_uppercase();
        if part.is_empty()
            || part.trim() != part
            || part == "."
            || part == ".."
            || part.chars().any(|c| c < ' ' || "\\\\:*?\"<>|".contains(c))
            || part.ends_with('.')
            || matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit())
        {
            return Err("分类包含无效文件夹名称".into());
        }
    }
    Ok(s.into())
}
fn category_dir(root: &str, category: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "保存根目录不存在")?;
    let mut target = root.clone();
    for part in safe_category(category)?.split('/') {
        target.push(part);
        if target.exists()
            && !fs::canonicalize(&target)
                .map_err(|e| e.to_string())?
                .starts_with(&root)
        {
            return Err("分类目录超出保存位置".into());
        }
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
        if !target.starts_with(&root) || target == root {
            return Err("分类目录超出保存位置".into());
        }
    }
    Ok(target)
}
fn relocate(state: &TeamState, job: &LocalJob, category: &str) -> Result<(), String> {
    let mut data = state.data.lock().map_err(|_| "收件状态不可用")?;
    let job = data.jobs.get(&job.id).ok_or("任务不存在")?.clone();
    if matches!(job.stage.as_str(), "preparing" | "text_ready") {
        return Ok(());
    }
    let Some(result) = job.result.as_ref() else {
        return Ok(());
    };
    let source = PathBuf::from(&result.output_dir);
    let parent = category_dir(&job.root, category)?;
    let name = source
        .file_name()
        .ok_or("文件夹名称无效")?
        .to_string_lossy();
    let name = if source
        .components()
        .any(|p| p.as_os_str() == ".yinglian-inbox")
    {
        format!("{name}_{}", &job.id[..8])
    } else {
        name.into_owned()
    };
    let target = if let Some(pending) = job.move_to.as_ref() {
        let pending = PathBuf::from(pending);
        fs::canonicalize(pending.parent().ok_or("归档目标无效")?)
            .map_err(|e| e.to_string())?
            .join(pending.file_name().ok_or("归档目标无效")?)
    } else {
        parent.join(name)
    };
    let root = fs::canonicalize(&job.root).map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) || !target.starts_with(&root) {
        return Err("归档目标超出保存目录".into());
    }
    let already_moved =
        source.exists() && fs::canonicalize(&source).map_err(|e| e.to_string())? == target;
    data.jobs.get_mut(&job.id).unwrap().move_to = Some(visible_directory(&target));
    state.save(&data)?;
    if source.exists() && !already_moved {
        let resolved = fs::canonicalize(&source).map_err(|e| e.to_string())?;
        if !resolved.starts_with(&root) || resolved == root {
            return Err("归档来源超出保存目录".into());
        }
        if target.exists() {
            data.jobs.get_mut(&job.id).unwrap().move_to = None;
            state.save(&data)?;
            return Err("目标文件夹已存在，未覆盖任何视频".into());
        }
        if let Err(e) = move_owned(&resolved, &target, false) {
            data.jobs.get_mut(&job.id).unwrap().move_to = None;
            state.save(&data)?;
            return Err(format!("归档失败：{e}"));
        }
    } else if !target.is_dir() {
        return Err("视频文件夹已被移动或删除".into());
    }
    {
        let j = data.jobs.get_mut(&job.id).unwrap();
        j.result.as_mut().unwrap().output_dir = visible_directory(&target);
        j.category = category.to_string();
        j.move_to = None;
    }
    state.save(&data)
}
fn download(
    app: &tauri::AppHandle,
    state: &TeamState,
    config: &Config,
    remote: Value,
) -> Result<(), String> {
    let id = remote["id"].as_str().ok_or("任务编号缺失")?.to_string();
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("任务编号不合法".into());
    }
    let lease = String::new();
    let category = safe_category(remote["category"].as_str().unwrap_or("待分类"))?;
    let device_id = config.session["device_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let existing = state.data.lock().unwrap().jobs.get(&id).cloned();
    if let Some(mut j) = existing.filter(|j| j.device_id == device_id && j.result.is_some()) {
        j.lease = lease;
        j.stage = if config.copy && j.stage != "completed" {
            "downloaded"
        } else {
            "completed"
        }
        .into();
        j.detail = if j.stage == "completed" {
            "已保存的文件已确认，无需重复下载"
        } else {
            "视频已保存，等待文案处理"
        }
        .into();
        j.options = config.clone();
        j.options.proof.clear();
        j.options.owner.clear();
        j.options.chat_id.clear();
        j.options.session = Value::Null;
        state.update(&id, |v| *v = j.clone())?;
        return Ok(());
    }
    fs::create_dir_all(&config.root).map_err(|e| format!("保存位置不可用：{e}"))?;
    let root = visible_directory(&fs::canonicalize(&config.root).map_err(|e| e.to_string())?);
    let mut job = LocalJob {
        id: id.clone(),
        device_id,
        remote: remote.clone(),
        root: root.clone(),
        category: category.clone(),
        stage: "downloading".into(),
        detail: "正在下载原视频".into(),
        lease,
        result: None,
        options: config.clone(),
        move_to: None,
    };
    // Never duplicate company credentials into each task snapshot.
    job.options.proof.clear();
    job.options.owner.clear();
    job.options.chat_id.clear();
    job.options.session = Value::Null;
    {
        let mut data = state.data.lock().unwrap();
        data.jobs.insert(id.clone(), job.clone());
        state.save(&data)?;
    }
    let temporary = PathBuf::from(&root).join(".yinglian-inbox").join(&id);
    fs::create_dir_all(&temporary).map_err(|e| e.to_string())?;
    // A crash leaves this one owned staging folder. Keep it recoverable, never delete user files.
    let stale = temporary.join(format!(".yinglian-team-{id}"));
    if stale.exists() {
        let resolved = fs::canonicalize(&stale).map_err(|e| e.to_string())?;
        if !resolved.starts_with(fs::canonicalize(&temporary).map_err(|e| e.to_string())?) {
            return Err("临时目录异常".into());
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        move_owned(
            &resolved,
            &temporary.join(format!("interrupted-{stamp}")),
            false,
        )
        .map_err(|e| e.to_string())?;
    }
    let request = DownloadRequest {
        job_id: format!("team-{id}"),
        url: remote["url"].as_str().ok_or("链接缺失")?.into(),
        options: DownloadOptions {
            category: None,
            download_dir: visible_directory(&temporary),
            quality: config.quality.clone(),
            include_video: true,
            include_thumbnail: true,
            include_original_subtitle: config.subtitle,
            transcript_mode: "none".into(),
            language: config.language.clone(),
            model_id: config.model_id.clone(),
        },
    };
    let runtime = app.state::<RuntimeState>().inner().clone();
    runtime_log(app, format!("inbox_download_start job={id}"));
    let outcome = execute_download(app.clone(), runtime, request);
    match outcome {
        Ok(result) => {
            runtime_log(app, format!("inbox_download_saved job={id}"));
            job.result = Some(result);
            job.stage = "archiving".into();
            job.detail = if config.copy {
                "原视频已保存，文案待处理"
            } else {
                "视频和封面已保存"
            }
            .into();
            state.update(&id, |j| {
                job.remote = j.remote.clone();
                *j = job.clone();
            })?;
            relocate(state, &job, &category)?;
            state.update(&id, |j| {
                j.stage = if config.copy {
                    "downloaded"
                } else {
                    "completed"
                }
                .into()
            })?;
        }
        Err(e) => {
            runtime_log(app, format!("inbox_download_failed job={id} detail={}", live::safe_error(&e)));
            state.update(&id, |j| {
                j.stage = "failed".into();
                j.detail = e.chars().take(400).collect();
            })?;
        }
    }
    Ok(())
}
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Separate journal: never reuse or overwrite a company-relay pairing.
    let path = dir.join("personal-inbox.json");
    let (mut data, generation) = load_journal(&path)?;
    for job in data.jobs.values_mut() {
        if job.stage == "preparing" {
            job.stage = "downloaded".into();
        }
        if job.stage == "downloading" {
            job.stage = "queued".into();
        }
    }
    let state = TeamState {
        data: Arc::new(Mutex::new(data)),
        path,
        generation: Arc::new(AtomicU64::new(generation)),
        error: Arc::new(Mutex::new(String::new())),
        active: Arc::new(AtomicBool::new(false)),
        writing: Arc::new(AtomicBool::new(false)),
        connection: Arc::new(Mutex::new("未连接".into())),
        pair: Arc::new(Mutex::new(None)),
        registration: Arc::new(Mutex::new(None)),
    };
    app.manage(state.clone());
    feishu::start(state.clone());
    let handle = app.clone();
    thread::spawn(move || loop {
        let (config, jobs) = {
            let d = state.data.lock().unwrap();
            (
                d.config.clone(),
                d.jobs
                    .values()
                    .filter(|j| j.device_id == d.config.session["device_id"].as_str().unwrap_or(""))
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        if config.enabled && !config.owner.is_empty() {
            for job in &jobs {
                let category = job.remote["category"].as_str().unwrap_or(&job.category);
                if job.result.is_some()
                    && !matches!(job.stage.as_str(), "preparing" | "text_ready")
                    && (category != job.category
                        || job.move_to.is_some()
                        || job.stage == "archiving")
                {
                    if let Err(e) = relocate(&state, job, category) {
                        state.error(format!("归档待处理：{e}"));
                    } else if job.stage == "archiving" {
                        let _ = state.update(&job.id, |j| {
                            j.stage = if j.options.copy {
                                "downloaded"
                            } else {
                                "completed"
                            }
                            .into()
                        });
                    }
                }
            }
            let next = jobs
                .iter()
                .filter(|j| j.stage == "queued")
                .min_by_key(|j| j.remote["created"].as_u64().unwrap_or(0));
            if let Some(job) = next {
                // Claim and config edits share the journal lock, preventing unpair races.
                let may_start = {
                    let d = state.data.lock().unwrap();
                    if d.config.enabled && d.config.session == config.session {
                        state.active.store(true, Ordering::SeqCst);
                        true
                    } else {
                        false
                    }
                };
                if may_start {
                    if let Err(e) = download(&handle, &state, &config, job.remote.clone()) {
                        let _ = state.update(&job.id, |j| {
                            j.stage = if j.result.is_some() {
                                "partial"
                            } else {
                                "failed"
                            }
                            .into();
                            j.detail = e;
                        });
                    }
                    state.active.store(false, Ordering::SeqCst);
                }
            }
        }
        thread::sleep(Duration::from_secs(1));
    });
    // API translation must not depend on a hidden/minimized WebView timer.
    let handle = app.clone();
    thread::spawn(move || loop {
        let state = handle.state::<TeamState>();
        let next = {
            let d = state.data.lock().unwrap();
            d.jobs
                .values()
                .find(|j| {
                    d.config.enabled
                        && j.device_id == d.config.session["device_id"].as_str().unwrap_or("")
                        && j.options.copy
                        && j.options.provider == "api"
                        && matches!(j.stage.as_str(), "downloaded" | "text_ready")
                })
                .cloned()
        };
        if let Some(job) = next {
            finish_api_text(&handle, &job.id);
        }
        thread::sleep(Duration::from_secs(1));
    });
    Ok(())
}
fn finish_api_text(app: &tauri::AppHandle, id: &str) {
    let translated = (|| -> Result<(), String> {
        let result = tauri::async_runtime::block_on(team_prepare_text(app.clone(), id.into()))?;
        let (base_url, model, key) = saved_ai_credentials(app)?;
        let mut translations = Vec::new();
        for batch in result.segments.chunks(20) {
            translations.extend(call_ai_translation(
                &base_url,
                &model,
                &key,
                &batch.iter().map(|s| s.text.clone()).collect::<Vec<_>>(),
                &result.source_language,
            )?);
        }
        save_translation(SaveTranslationRequest {
            output_dir: result.output_dir,
            segments: result.segments,
            translations,
        })?;
        Ok(())
    })();
    let (status, detail) = match translated {
        Ok(()) => ("completed", "原视频、封面及双语文案已保存".into()),
        Err(e) => ("partial", format!("视频已保存；{e}")),
    };
    let _ = team_text_done(app.state(), id.into(), status.into(), detail);
}
pub fn enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<TeamState>()
        .map(|s| {
            let d = s.data.lock().unwrap();
            !d.config.app_id.is_empty() && !d.config.proof.is_empty()
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn team_snapshot(state: State<'_, TeamState>) -> Value {
    let data = state.data.lock().unwrap();
    let mut config = serde_json::to_value(&data.config).unwrap();
    config.as_object_mut().unwrap().remove("proof");
    let device = data.config.session["device_id"].as_str().unwrap_or("");
    let jobs:Vec<Value>=data.jobs.values().filter(|j|j.device_id==device).map(|j|json!({"id":j.id,"category":j.remote["category"].as_str().unwrap_or(&j.category),"note":j.remote["note"],"url":j.remote["url"],"stage":j.stage,"detail":j.detail,"result":j.result,"created":j.remote["created"],"provider":j.options.provider,"copy":j.options.copy})).collect();
    let writing = state.writing.load(Ordering::SeqCst)
        || data.jobs.values().any(|j| {
            j.device_id == device && matches!(j.stage.as_str(), "preparing" | "text_ready")
        });
    json!({"config":config,"jobs":jobs,"error":state.error.lock().unwrap().clone(),
        "connection":state.connection.lock().unwrap().clone(), "pair":feishu::pair_status(&state),
        "registration":registration::status(&state),
        "busy":state.active.load(Ordering::SeqCst)||writing})
}
#[tauri::command]
pub fn team_confirm_pair(state: State<'_, TeamState>) -> Result<(), String> {
    feishu::confirm_pair(&state)
}
#[tauri::command]
pub fn team_register(state: State<'_, TeamState>, device_name: String) -> Result<(), String> {
    registration::start(&state, &device_name)
}
#[tauri::command]
pub fn team_cancel_register(state: State<'_, TeamState>) {
    registration::cancel(&state);
}
#[tauri::command]
pub fn team_open_registration(state: State<'_, TeamState>) -> Result<(), String> {
    registration::open_page(&state)
}
#[tauri::command]
pub fn team_save(state: State<'_, TeamState>, mut config: Config) -> Result<(), String> {
    if config.root.trim().is_empty() {
        return Err("请选择保存位置".into());
    }
    if !matches!(config.provider.as_str(), "api" | "local")
        || !matches!(config.model_id.as_str(), "base" | "small" | "medium")
    {
        return Err("请选择有效的翻译方式和语音模型".into());
    }
    fs::create_dir_all(&config.root).map_err(|e| e.to_string())?;
    config.root = visible_directory(&fs::canonicalize(&config.root).map_err(|e| e.to_string())?);
    let mut data = state.data.lock().unwrap();
    if config.enabled
        && (data.config.owner.is_empty()
            || data.config.onboarding
            || data.config.session["device_id"].as_str().is_none())
    {
        return Err("请先完成飞书配对".into());
    }
    config.app_id = data.config.app_id.clone();
    config.proof = data.config.proof.clone();
    config.owner = data.config.owner.clone();
    config.chat_id = data.config.chat_id.clone();
    config.history_until = data.config.history_until;
    config.bound_at = data.config.bound_at;
    config.session = data.config.session.clone();
    config.onboarding = data.config.onboarding;
    config.setup_message_sent = data.config.setup_message_sent;
    let mut next = data.clone();
    next.config = config;
    state.save(&next)?;
    *data = next;
    Ok(())
}
#[tauri::command]
pub async fn team_action(
    app: tauri::AppHandle,
    action: String,
    body: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TeamState>();
        if action == "renew_pair" {
            feishu::renew_pair(&state)?;
            return Ok(json!({}));
        }
        let mut data = state.data.lock().unwrap();
        if action == "disconnect" {
            feishu::ensure_idle(&state, &data)?;
            registration::cancel(&state);
            let mut next = data.clone();
            next.config.enabled = false;
            next.config.app_id.clear();
            next.config.proof.clear();
            next.config.owner.clear();
            next.config.chat_id.clear();
            next.config.session = Value::Null;
            next.config.onboarding = false;
            next.config.setup_message_sent = false;
            state.save(&next)?;
            *data = next;
            state.save(&data)?; // Clear credentials from both recovery snapshots.
            *state.pair.lock().unwrap() = None;
            *state.connection.lock().unwrap() = "未连接".into();
            state.error(String::new());
            return Ok(json!({}));
        }
        if action != "edit" {
            return Err("不支持的操作".into());
        }
        let id = body["id"].as_str().ok_or("任务编号缺失")?;
        let mut next = data.clone();
        let j = next.jobs.get_mut(id).ok_or("任务不存在")?;
        if j.device_id != data.config.session["device_id"].as_str().unwrap_or("") {
            return Err("任务不属于当前配对".into());
        }
        if let Some(category) = body["category"].as_str() {
            j.remote["category"] = json!(safe_category(category)?);
        }
        if let Some(note) = body["note"].as_str() {
            j.remote["note"] = json!(note.chars().take(1000).collect::<String>());
        }
        if body["retry"] == true {
            if !matches!(j.stage.as_str(), "failed" | "partial") {
                return Err("当前任务不能重试".into());
            }
            j.stage = if j.result.is_some() {
                "downloaded"
            } else {
                "queued"
            }
            .into();
            j.detail.clear();
            j.options.provider = data.config.provider.clone();
            j.options.model_id = data.config.model_id.clone();
        }
        state.save(&next)?;
        *data = next;
        Ok(json!({}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn team_prepare_text(
    app: tauri::AppHandle,
    id: String,
) -> Result<DownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TeamState>();
        if state.writing.swap(true, Ordering::SeqCst) {
            return Err("文案队列忙碌".into());
        }
        let mut started = false;
        let outcome = (|| -> Result<DownloadResult, String> {
            let job = {
                let mut d = state.data.lock().unwrap();
                let j = d.jobs.get(&id).ok_or("任务不存在")?;
                if j.device_id != d.config.session["device_id"].as_str().unwrap_or("") {
                    return Err("任务属于另一台电脑".into());
                }
                if !matches!(j.stage.as_str(), "downloaded" | "text_ready") {
                    return Err("任务尚未准备好生成文案".into());
                }
                let job = j.clone();
                started = true;
                d.jobs.get_mut(&id).unwrap().stage =
                    if job.result.as_ref().is_some_and(|r| r.transcript_available) {
                        "text_ready"
                    } else {
                        "preparing"
                    }
                    .into();
                state.save(&d)?;
                job
            };
            let mut result = job.result.clone().ok_or("视频尚未保存")?;
            if result.transcript_available {
                return Ok(result);
            }
            let c = &job.options;
            let dir = PathBuf::from(&result.output_dir);
            let root = fs::canonicalize(&job.root).map_err(|e| e.to_string())?;
            if !fs::canonicalize(&dir)
                .map_err(|e| e.to_string())?
                .starts_with(root)
            {
                return Err("视频目录超出保存位置".into());
            }
            let native = dir.join("原版字幕.srt");
            if c.transcript_mode != "ai" && native.is_file() {
                result.segments = parse_srt(&native)?;
            }
            if result.segments.is_empty() && c.transcript_mode != "native" {
                let media = fs::read_dir(&dir)
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .map(|e| e.path())
                    .find(|p| {
                        matches!(
                            p.extension().and_then(|e| e.to_str()),
                            Some("mp4" | "mkv" | "webm")
                        )
                    })
                    .ok_or("原视频文件不存在")?;
                let req = DownloadRequest {
                    job_id: format!("team-{id}"),
                    url: job.remote["url"].as_str().unwrap_or("").into(),
                    options: DownloadOptions {
                        category: None,
                        download_dir: job.root.clone(),
                        quality: c.quality.clone(),
                        include_video: true,
                        include_thumbnail: true,
                        include_original_subtitle: c.subtitle,
                        transcript_mode: c.transcript_mode.clone(),
                        language: c.language.clone(),
                        model_id: c.model_id.clone(),
                    },
                };
                let (lang, segments) =
                    transcribe(&app, app.state::<RuntimeState>().inner(), &req, &media)?;
                result.source_language = lang;
                result.segments = segments;
            }
            result.transcript_available = !result.segments.is_empty();
            if !result.transcript_available {
                return Err("没有可用语音或原版字幕".into());
            }
            state.update(&id, |j| {
                j.result = Some(result.clone());
                j.stage = "text_ready".into();
            })?;
            Ok(result)
        })();
        if let (true, Err(ref e)) = (started, &outcome) {
            let _ = state.update(&id, |j| {
                j.stage = "partial".into();
                j.detail = format!("视频已保存；{e}");
            });
        }
        state.writing.store(false, Ordering::SeqCst);
        outcome
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn team_text_done(
    state: State<'_, TeamState>,
    id: String,
    status: String,
    detail: String,
) -> Result<(), String> {
    if !matches!(status.as_str(), "completed" | "partial") {
        return Err("状态无效".into());
    }
    {
        let d = state.data.lock().unwrap();
        let j = d.jobs.get(&id).ok_or("任务不存在")?;
        if j.device_id != d.config.session["device_id"].as_str().unwrap_or("") {
            return Err("任务属于另一台电脑".into());
        }
    }
    state.update(&id, |j| {
        j.stage = status;
        j.detail = detail;
    })
}

// Native integration harness. Excluded from all normal/release builds. It reuses
// the real worker, downloader, ASR, translator and file writer without driving UI.
#[cfg(feature = "team-smoke")]
pub fn replay_download(app: &tauri::AppHandle, url: &str, output: &str) -> Result<String, String> {
    // No Feishu threads or network API calls: use the real ingest + worker functions
    // with synthetic identities and a unique test journal, never the user's inbox.
    let directory = PathBuf::from(output).join(format!("inbox-replay-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let config = Config { app_id:"cli_local_fixture".into(), owner:"ou_fixture".into(), chat_id:"oc_fixture".into(),
        session:json!({"device_id":"local-fixture"}), root:visible_directory(&directory), enabled:true, copy:false, subtitle:true, ..Config::default() };
    let state = TeamState { data:Arc::new(Mutex::new(Journal { config:config.clone(), ..Journal::default() })),
        path:directory.join("journal.json"), generation:Arc::new(AtomicU64::new(0)), error:Arc::default(), active:Arc::new(AtomicBool::new(false)), writing:Arc::new(AtomicBool::new(false)), connection:Arc::default(), pair:Arc::default(), registration:Arc::default() };
    let event = json!({"sender":{"sender_type":"user","sender_id":{"open_id":"ou_fixture"}},
        "message":{"message_id":"local-message","chat_id":"oc_fixture","chat_type":"p2p","message_type":"text",
        "content":json!({"text":format!("复制分享 {url}\n分类：闪退验收\n备注：中文和特殊空格回归")}).to_string()}});
    feishu::ingest(&state,"cli_local_fixture",&event)?;
    feishu::ingest(&state,"cli_local_fixture",&event)?;
    let jobs: Vec<_> = state.data.lock().unwrap().jobs.values().cloned().collect();
    if jobs.len()!=1 { return Err("收件重放未正确去重".into()); }
    download(app,&state,&config,jobs[0].remote.clone())?;
    let saved = load_journal(&state.path)?.0;
    let job = saved.jobs.values().next().ok_or("任务未持久化")?;
    if job.stage!="completed" { return Err(format!("{} {}",job.stage,job.detail)); }
    let result = job.result.as_ref().ok_or("缺少下载结果")?;
    let target=PathBuf::from(&result.output_dir);
    if !target.starts_with(directory.join("闪退验收")) || !target.join("视频.mp4").is_file() { return Err("未正确归档视频".into()); }
    Ok(result.output_dir.clone())
}
#[cfg(feature = "team-smoke")]
pub fn run_smoke() {
    let exit_status = Arc::new(std::sync::atomic::AtomicI32::new(3));
    let final_status = exit_status.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "org.yinglian.personal-smoke".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let model_root = Arc::new(RwLock::new(model_dir(app.handle())?));
            let model_server_url = start_model_server(model_root.clone())?;
            app.manage(RuntimeState {
                processes: Arc::new(Mutex::new(HashMap::new())),
                cancelled: Arc::new(Mutex::new(HashSet::new())),
                cancel_model: Arc::new(AtomicBool::new(false)),
                model_root,
                model_server_url,
            });
            start(app.handle())?;
            feishu::seed_smoke(&app.state::<TeamState>())?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                let begin = std::time::Instant::now();
                let mut previous = String::new();
                loop {
                    let state = handle.state::<TeamState>();
                    let (config, jobs) = {
                        let d = state.data.lock().unwrap();
                        (
                            d.config.clone(),
                            d.jobs.values().cloned().collect::<Vec<_>>(),
                        )
                    };
                    if !config.root.contains("yinglian-personal-qa") {
                        eprintln!("Refusing non-fixture integration settings");
                        exit_status.store(2, Ordering::SeqCst);
                        handle.exit(2);
                        break;
                    }
                    let status = jobs
                        .iter()
                        .map(|j| format!("{}: {} {}", j.id, j.stage, j.detail))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if status != previous {
                        println!("{status}");
                        previous = status;
                    }
                    let expected = std::env::var("YINGLIAN_SMOKE_EXPECTED")
                        .ok()
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(1);
                    let done = jobs.len() >= expected
                        && jobs.iter().all(|j| {
                            matches!(j.stage.as_str(), "completed" | "failed" | "partial")
                        });
                    if done {
                        let code = if jobs.iter().all(|j| j.stage == "completed") {
                            0
                        } else {
                            1
                        };
                        exit_status.store(code, Ordering::SeqCst);
                        handle.exit(code);
                        break;
                    }
                    if begin.elapsed() > Duration::from_secs(420) {
                        eprintln!("Integration timeout");
                        handle.exit(3);
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .run(context)
        .expect("native integration application");
    process::exit(final_status.load(Ordering::SeqCst));
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn fixture_state() -> TeamState {
        let dir = std::env::temp_dir().join(format!(
            "yinglian-team-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        TeamState {
            data: Arc::new(Mutex::new(Journal::default())),
            path: dir.join("journal.json"),
            generation: Arc::new(AtomicU64::new(0)),
            error: Arc::new(Mutex::new(String::new())),
            active: Arc::new(AtomicBool::new(false)),
            writing: Arc::new(AtomicBool::new(false)),
            connection: Arc::new(Mutex::new(String::new())),
            pair: Arc::new(Mutex::new(None)),
            registration: Arc::new(Mutex::new(None)),
        }
    }
    fn fixture_job(state: &TeamState) -> LocalJob {
        let root = state.path.parent().unwrap();
        let source = root.join(".yinglian-inbox").join("job").join("Test video");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("视频.mp4"), b"test payload").unwrap();
        let result = DownloadResult {
            output_dir: visible_directory(&source),
            title: "Test video".into(),
            platform: "test".into(),
            thumbnail: None,
            uploader: "test".into(),
            duration: Some(1.0),
            transcript_available: false,
            source_language: "en".into(),
            segments: vec![],
            warning: None,
        };
        let job = LocalJob {
            id: "00000000-0000-0000-0000-000000000001".into(),
            device_id: "test".into(),
            remote: json!({}),
            root: visible_directory(root),
            category: "待分类".into(),
            stage: "completed".into(),
            detail: String::new(),
            lease: String::new(),
            result: Some(result),
            options: Config::default(),
            move_to: None,
        };
        state
            .data
            .lock()
            .unwrap()
            .jobs
            .insert(job.id.clone(), job.clone());
        job
    }
    #[test]
    fn classify_moves_whole_folder_without_overwriting_and_defers_while_translating() {
        let state = fixture_state();
        let job = fixture_job(&state);
        let original = PathBuf::from(&job.result.as_ref().unwrap().output_dir);
        relocate(&state, &job, "带货").unwrap();
        assert!(!original.exists());
        let moved = state.data.lock().unwrap().jobs[&job.id].clone();
        let moved_path = PathBuf::from(&moved.result.as_ref().unwrap().output_dir);
        assert_eq!(
            fs::read(moved_path.join("视频.mp4")).unwrap(),
            b"test payload"
        );
        state
            .update(&job.id, |j| j.stage = "text_ready".into())
            .unwrap();
        relocate(&state, &job, "好开头").unwrap();
        assert!(moved_path.exists());
        state
            .update(&job.id, |j| j.stage = "completed".into())
            .unwrap();
        relocate(&state, &job, "好开头").unwrap();
        assert!(!moved_path.exists());
        let moved = state.data.lock().unwrap().jobs[&job.id].clone();
        let source = PathBuf::from(&moved.result.as_ref().unwrap().output_dir);
        let collision = category_dir(&moved.root, "冲突")
            .unwrap()
            .join(source.file_name().unwrap());
        fs::create_dir_all(&collision).unwrap();
        fs::write(collision.join("用户文件.txt"), b"keep").unwrap();
        assert!(relocate(&state, &job, "冲突").is_err());
        assert!(source.exists());
        assert_eq!(fs::read(collision.join("用户文件.txt")).unwrap(), b"keep");
    }
    #[test]
    fn interrupted_move_is_recovered_without_downloading_again() {
        let state = fixture_state();
        let job = fixture_job(&state);
        let source = PathBuf::from(&job.result.as_ref().unwrap().output_dir);
        let target = category_dir(&job.root, "待分类")
            .unwrap()
            .join("Test video_00000000");
        state
            .update(&job.id, |j| j.move_to = Some(visible_directory(&target)))
            .unwrap();
        move_owned(&source, &target, false).unwrap();
        relocate(&state, &job, "待分类").unwrap();
        let recovered = state.data.lock().unwrap().jobs[&job.id].clone();
        assert!(recovered.move_to.is_none());
        assert_eq!(
            PathBuf::from(&recovered.result.unwrap().output_dir)
                .canonicalize()
                .unwrap(),
            target
        );
    }
    #[test]
    fn journal_replaces_itself_in_windows_appdata() {
        let dir = PathBuf::from(
            std::env::var("LOCALAPPDATA")
                .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned()),
        )
        .join("org.yinglian.team-qa")
        .join(format!(
            "journal-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let state = TeamState {
            data: Arc::new(Mutex::new(Journal::default())),
            path: dir.join("journal.json"),
            generation: Arc::new(AtomicU64::new(0)),
            error: Arc::new(Mutex::new(String::new())),
            active: Arc::new(AtomicBool::new(false)),
            writing: Arc::new(AtomicBool::new(false)),
            connection: Arc::new(Mutex::new(String::new())),
            pair: Arc::new(Mutex::new(None)),
            registration: Arc::new(Mutex::new(None)),
        };
        let mut data = Journal::default();
        state.save(&data).unwrap();
        data.config.device_name = "second save".into();
        state.save(&data).unwrap();
        let (saved, generation) = load_journal(&state.path).unwrap();
        assert_eq!(saved.config.device_name, "second save");
        assert_eq!(generation, 2);
        fs::write(state.path.with_extension("0.json"), b"{partial write").unwrap();
        let (recovered, generation) = load_journal(&state.path).unwrap();
        assert_ne!(recovered.config.device_name, "second save");
        assert_eq!(generation, 1);
    }
    #[test]
    fn categories_cannot_escape_or_use_windows_devices() {
        for v in [
            "../test",
            "/absolute",
            "a//b",
            "a/../b",
            "C:\\tmp",
            "CON",
            "con.txt",
            "LPT1",
            "a.",
            "",
        ] {
            assert!(safe_category(v).is_err(), "{v}");
        }
        assert_eq!(safe_category("润唇膏"), Ok("润唇膏".into()));
    }
}
