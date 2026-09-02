use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tiny_http::{Header, Response, Server, StatusCode};
use tungstenite::{connect, stream::MaybeTlsStream, Message};
use url::Url;

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const TRANSLATION_BASE_URL: &str =
    "https://huggingface.co/Xenova/m2m100_418M/resolve/9c374f0b7aca709787cea97b047bfbbd1559d177";
const TRANSLATION_MODEL_BYTES: u64 = 646_109_073;
const TRANSLATION_MODEL_FILES: [(&str, u64); 9] = [
    ("config.json", 908),
    ("generation_config.json", 233),
    ("tokenizer_config.json", 1_813),
    ("tokenizer.json", 7_988_527),
    ("special_tokens_map.json", 1_559),
    ("vocab.json", 3_708_092),
    ("sentencepiece.bpe.model", 2_423_393),
    ("onnx/encoder_model_quantized.onnx", 287_856_370),
    ("onnx/decoder_model_merged_quantized.onnx", 344_128_178),
];
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

fn runtime_log(app: &tauri::AppHandle, event: impl AsRef<str>) {
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("yinglian.log"))
    else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let event = event.as_ref().replace(['\r', '\n'], " ");
    let _ = writeln!(file, "{timestamp}\t{event}");
}

#[derive(Clone)]
struct RuntimeState {
    processes: Arc<Mutex<HashMap<String, u32>>>,
    cancel_model: Arc<AtomicBool>,
    model_root: Arc<RwLock<PathBuf>>,
    model_server_url: String,
}

#[derive(Clone, Serialize)]
struct ModelInfo {
    id: &'static str,
    name: &'static str,
    size_bytes: u64,
    installed: bool,
    recommended: bool,
}

#[derive(Serialize)]
struct RuntimeInfo {
    version: &'static str,
    default_download_dir: String,
    yt_dlp_available: bool,
    ffmpeg_available: bool,
    whisper_available: bool,
    models: Vec<ModelInfo>,
    selected_model: String,
    model_dir: String,
    model_server_url: String,
    translation_model_installed: bool,
    translation_model_size_bytes: u64,
    login_profile_available: bool,
}

#[derive(Clone, Deserialize)]
struct DownloadOptions {
    download_dir: String,
    quality: String,
    include_video: bool,
    include_thumbnail: bool,
    include_description: bool,
    transcript_mode: String,
    language: String,
    model_id: String,
    #[allow(dead_code)]
    translation_target: Option<String>,
}

#[derive(Clone, Deserialize)]
struct DownloadRequest {
    job_id: String,
    url: String,
    options: DownloadOptions,
}

#[derive(Serialize)]
struct DownloadResult {
    output_dir: String,
    title: String,
    platform: String,
    transcript_available: bool,
    source_language: String,
    warning: Option<String>,
}

#[derive(Deserialize)]
struct ProfileRequest {
    url: String,
    limit: usize,
}

#[derive(Serialize)]
struct ProfileItem {
    url: String,
    title: String,
    id: String,
}

#[derive(Serialize)]
struct MediaPreview {
    url: String,
    title: String,
    platform: String,
    uploader: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    size_bytes: Option<u64>,
    error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TranslationSegment {
    index: usize,
    start: String,
    end: String,
    text: String,
}

#[derive(Serialize)]
struct TranslationInput {
    source_language: String,
    segments: Vec<TranslationSegment>,
}

#[derive(Deserialize)]
struct TranslationInputRequest {
    output_dir: String,
    source_language: String,
}

#[derive(Deserialize)]
struct SaveTranslationRequest {
    output_dir: String,
    segments: Vec<TranslationSegment>,
    translations: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    job_id: String,
    phase: String,
    percent: f64,
    message: String,
}

#[derive(Clone, Serialize)]
struct ModelProgress {
    model_id: String,
    percent: f64,
    downloaded: u64,
    total: u64,
    message: String,
}

#[derive(Default)]
struct ProcessOutput {
    lines: Vec<String>,
    errors: VecDeque<String>,
    output_file: Option<PathBuf>,
}

fn model_specs() -> [(&'static str, &'static str, u64, bool); 3] {
    [
        ("base", "Base · 极速", 147_951_465, false),
        ("small", "Small · 推荐", 487_601_967, true),
        ("medium", "Medium · 高精度", 1_533_775_901, false),
    ]
}

fn default_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("models"))
}

fn model_location_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("model-location.txt"))
}

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let location_file = model_location_file(app)?;
    let dir = fs::read_to_string(location_file)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(default_model_dir(app)?);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建模型目录：{error}"))?;
    Ok(dir)
}

fn model_path(app: &tauri::AppHandle, model_id: &str) -> Result<PathBuf, String> {
    if !model_specs().iter().any(|model| model.0 == model_id) {
        return Err("不支持的模型".into());
    }
    Ok(model_dir(app)?.join(format!("ggml-{model_id}.bin")))
}

fn translation_model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(model_dir(app)?.join("Xenova").join("m2m100_418M"))
}

fn translation_model_installed(app: &tauri::AppHandle) -> bool {
    let Ok(root) = translation_model_dir(app) else {
        return false;
    };
    TRANSLATION_MODEL_FILES.iter().all(|(name, minimum)| {
        fs::metadata(root.join(name))
            .map(|item| item.len() >= *minimum)
            .unwrap_or(false)
    })
}

fn start_model_server(model_root: Arc<RwLock<PathBuf>>) -> Result<String, String> {
    let server =
        Server::http("127.0.0.1:0").map_err(|error| format!("无法启动本地模型服务：{error}"))?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or("无法读取本地模型服务地址")?;
    let base_url = format!("http://127.0.0.1:{}", address.port());
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let requested = request
                .url()
                .split('?')
                .next()
                .unwrap_or("")
                .trim_start_matches('/');
            let safe = Path::new(requested)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)));
            let cors = Header::from_bytes("Access-Control-Allow-Origin", "*").ok();
            if !safe || requested.is_empty() {
                let mut response =
                    Response::from_string("invalid model path").with_status_code(StatusCode(400));
                if let Some(header) = cors {
                    response.add_header(header);
                }
                let _ = request.respond(response);
                continue;
            }
            let root = match model_root.read() {
                Ok(value) => value.clone(),
                Err(_) => {
                    let _ = request.respond(
                        Response::from_string("model storage unavailable")
                            .with_status_code(StatusCode(500)),
                    );
                    continue;
                }
            };
            let file_path = root.join(requested);
            match File::open(file_path) {
                Ok(file) => {
                    let mut response = Response::from_file(file);
                    if let Some(header) = cors {
                        response.add_header(header);
                    }
                    let _ = request.respond(response);
                }
                Err(_) => {
                    let mut response = Response::from_string("model file not found")
                        .with_status_code(StatusCode(404));
                    if let Some(header) = cors {
                        response.add_header(header);
                    }
                    let _ = request.respond(response);
                }
            }
        }
    });
    Ok(base_url)
}

fn resource_bin_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.join("resources").join("bin"));
        dirs.push(resource.join("bin"));
    }
    dirs.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin"),
    );
    dirs
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn find_tool(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    for dir in resource_bin_dirs(app) {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut where_command = Command::new("where.exe");
    hidden(&mut where_command).arg(name);
    let output = where_command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

fn default_download_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|error| error.to_string())?;
    Ok(base.join("影链工坊"))
}

fn edge_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser")
        .join("edge-user-data"))
}

fn login_profile_exists(app: &tauri::AppHandle) -> bool {
    edge_profile_dir(app)
        .map(|dir| {
            dir.join("Default")
                .join("Network")
                .join("Cookies")
                .is_file()
                || dir.join("Default").join("Cookies").is_file()
        })
        .unwrap_or(false)
}

#[tauri::command]
fn runtime_info(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<RuntimeInfo, String> {
    let models = model_specs()
        .into_iter()
        .map(|(id, name, size_bytes, recommended)| ModelInfo {
            id,
            name,
            size_bytes,
            installed: model_path(&app, id)
                .map(|path| path.is_file())
                .unwrap_or(false),
            recommended,
        })
        .collect::<Vec<_>>();
    let selected_model = models
        .iter()
        .find(|model| model.recommended && model.installed)
        .or_else(|| models.iter().find(|model| model.installed))
        .map(|model| model.id)
        .unwrap_or("small")
        .to_string();

    Ok(RuntimeInfo {
        version: env!("CARGO_PKG_VERSION"),
        default_download_dir: default_download_dir(&app)?.to_string_lossy().into_owned(),
        yt_dlp_available: find_tool(&app, "yt-dlp.exe").is_some(),
        ffmpeg_available: find_tool(&app, "ffmpeg.exe").is_some(),
        whisper_available: find_tool(&app, "whisper-cli.exe").is_some(),
        models,
        selected_model,
        model_dir: model_dir(&app)?.to_string_lossy().into_owned(),
        model_server_url: state.model_server_url.clone(),
        translation_model_installed: translation_model_installed(&app),
        translation_model_size_bytes: TRANSLATION_MODEL_BYTES,
        login_profile_available: login_profile_exists(&app),
    })
}

#[tauri::command]
fn choose_download_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择下载目录")
        .blocking_pick_folder();
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn choose_model_dir(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择模型存储目录")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok());
    let Some(path) = picked else {
        return Ok(None);
    };
    fs::create_dir_all(&path).map_err(|error| format!("无法使用所选模型目录：{error}"))?;
    let config = model_location_file(&app)?;
    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法保存模型设置：{error}"))?;
    }
    fs::write(&config, path.to_string_lossy().as_bytes())
        .map_err(|error| format!("无法保存模型位置：{error}"))?;
    *state.model_root.write().map_err(|_| "无法更新模型目录")? = path.clone();
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    let directory = PathBuf::from(path);
    if !directory.is_dir() {
        return Err("下载目录不存在".into());
    }
    let mut command = Command::new("explorer.exe");
    hidden(&mut command).arg(directory);
    command
        .spawn()
        .map_err(|error| format!("无法打开目录：{error}"))?;
    Ok(())
}

fn find_edge() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            candidates.push(
                PathBuf::from(root)
                    .join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            let mut command = Command::new("where.exe");
            hidden(&mut command).arg("msedge.exe");
            let output = command.output().ok()?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(PathBuf::from)
        })
}

#[tauri::command]
fn launch_login(app: tauri::AppHandle, platform: String) -> Result<String, String> {
    let url = match platform.as_str() {
        "douyin" => "https://www.douyin.com/",
        "tiktok" => "https://www.tiktok.com/login",
        "youtube" => "https://www.youtube.com/",
        "bilibili" => "https://passport.bilibili.com/login",
        "instagram" => "https://www.instagram.com/accounts/login/",
        "facebook" => "https://www.facebook.com/login/",
        "twitter" => "https://x.com/i/flow/login",
        _ => return Err("不支持的平台".into()),
    };
    let edge = find_edge().ok_or("未找到 Microsoft Edge，无法打开官方登录窗口")?;
    let profile = edge_profile_dir(&app)?;
    fs::create_dir_all(&profile).map_err(|error| format!("无法创建登录会话目录：{error}"))?;
    let mut command = Command::new(edge);
    hidden(&mut command)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--disable-features=msEdgeFirstRunExperience")
        .arg(format!("--app={url}"));
    command
        .spawn()
        .map_err(|error| format!("官方登录窗口启动失败：{error}"))?;
    Ok("官方登录窗口已打开；完成登录后直接关闭该窗口，软件会复用本地会话。".into())
}

fn add_cookie_args(app: &tauri::AppHandle, command: &mut Command) {
    if let Some(cookie_file) = public_edge_profile_dir(app)
        .ok()
        .map(|profile| profile.join("yinglian-public-cookies.txt"))
        .filter(|path| path.is_file())
    {
        command.arg("--cookies").arg(cookie_file);
    } else if login_profile_exists(app) {
        let Some(profile) = edge_profile_dir(app).ok() else {
            return;
        };
        command
            .arg("--cookies-from-browser")
            .arg(format!("edge:{}", profile.join("Default").display()));
    }
}

fn is_douyin_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .map(|host| {
            host == "douyin.com"
                || host.ends_with(".douyin.com")
                || host == "iesdouyin.com"
                || host.ends_with(".iesdouyin.com")
        })
        .unwrap_or(false)
}

fn resolve_douyin_url(value: &str) -> Result<Url, String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(value)
        .header(
            reqwest::header::USER_AGENT,
            "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        )
        .send()
        .map_err(|error| format!("抖音短链接展开失败：{error}"))?;
    let resolved = response.url().clone();
    let host = resolved.host_str().unwrap_or_default().to_lowercase();
    if host != "douyin.com"
        && !host.ends_with(".douyin.com")
        && host != "iesdouyin.com"
        && !host.ends_with(".iesdouyin.com")
    {
        return Err("抖音短链接跳转到了非抖音站点".into());
    }
    Ok(resolved)
}

fn douyin_sec_uid(url: &Url) -> Option<String> {
    let segments = url.path_segments()?.collect::<Vec<_>>();
    for pair in segments.windows(2) {
        if pair[0] == "user" && pair[1].starts_with("MS4wLjABAAAA") {
            return Some(pair[1].to_string());
        }
    }
    url.query_pairs()
        .find(|(name, value)| {
            (name == "sec_uid" || name == "sec_user_id") && value.starts_with("MS4wLjABAAAA")
        })
        .map(|(_, value)| value.into_owned())
}

fn public_edge_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser")
        .join("public-edge-user-data"))
}

fn public_session_fresh(profile: &Path) -> bool {
    profile
        .join("yinglian-public-cookies.txt")
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|age| age < Duration::from_secs(90))
        .unwrap_or(false)
}

fn export_douyin_cookies<S: Read + Write>(
    socket: &mut tungstenite::WebSocket<S>,
    profile: &Path,
) -> Result<(), String> {
    socket
        .send(Message::Text(
            serde_json::json!({"id": 98, "method": "Network.getAllCookies"})
                .to_string()
                .into(),
        ))
        .map_err(|error| format!("公开会话读取失败：{error}"))?;
    loop {
        let message = socket
            .read()
            .map_err(|error| format!("公开会话读取中断：{error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let payload: Value =
            serde_json::from_str(text.as_str()).map_err(|_| "公开会话返回了无效数据")?;
        if payload.get("id").and_then(Value::as_i64) != Some(98) {
            continue;
        }
        if let Some(detail) = payload.pointer("/error/message").and_then(Value::as_str) {
            return Err(format!("公开会话 Cookie 读取失败：{detail}"));
        }
        let cookies = payload
            .pointer("/result/cookies")
            .and_then(Value::as_array)
            .ok_or("官方页面没有返回公开会话 Cookie")?;
        let mut output = String::from("# Netscape HTTP Cookie File\n");
        let mut count = 0;
        for cookie in cookies {
            let Some(domain) = cookie.get("domain").and_then(Value::as_str) else {
                continue;
            };
            let plain_domain = domain.trim_start_matches('.').to_lowercase();
            if plain_domain != "douyin.com" && !plain_domain.ends_with(".douyin.com") {
                continue;
            }
            let Some(name) = cookie.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(value) = cookie.get("value").and_then(Value::as_str) else {
                continue;
            };
            if name.contains(['\t', '\r', '\n']) || value.contains(['\t', '\r', '\n']) {
                continue;
            }
            let path = cookie.get("path").and_then(Value::as_str).unwrap_or("/");
            let secure = if cookie
                .get("secure")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "TRUE"
            } else {
                "FALSE"
            };
            let include_subdomains = if domain.starts_with('.') {
                "TRUE"
            } else {
                "FALSE"
            };
            let expires = cookie
                .get("expires")
                .and_then(Value::as_f64)
                .filter(|value| *value > 0.0)
                .unwrap_or(0.0) as u64;
            let cookie_domain = if cookie
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                format!("#HttpOnly_{domain}")
            } else {
                domain.to_string()
            };
            output.push_str(&format!(
                "{cookie_domain}\t{include_subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n"
            ));
            count += 1;
        }
        if count == 0 {
            return Err("官方页面尚未建立抖音公开会话，请稍后重试".into());
        }
        let target = profile.join("yinglian-public-cookies.txt");
        let temporary = profile.join("yinglian-public-cookies.tmp");
        fs::write(&temporary, output).map_err(|error| format!("公开会话保存失败：{error}"))?;
        let _ = fs::remove_file(&target);
        if let Err(rename_error) = fs::rename(&temporary, &target) {
            fs::copy(&temporary, &target).map_err(|copy_error| {
                format!("公开会话保存失败：{rename_error}；复制回退也失败：{copy_error}")
            })?;
            fs::remove_file(&temporary)
                .map_err(|error| format!("公开会话临时文件清理失败：{error}"))?;
        }
        return Ok(());
    }
}

fn scan_profile_with_edge(
    edge: &Path,
    profile: &Path,
    target: &str,
    limit: usize,
) -> Result<Vec<ProfileItem>, String> {
    fs::create_dir_all(profile).map_err(|error| format!("无法创建公开会话目录：{error}"))?;
    let active_port = profile.join("DevToolsActivePort");
    let _ = fs::remove_file(&active_port);
    let mut command = Command::new(edge);
    hidden(&mut command)
        .arg("--disable-gpu")
        .arg("--disable-blink-features=AutomationControlled")
        .arg("--no-first-run")
        .arg("--start-minimized")
        .arg("--remote-debugging-port=0")
        .arg("--remote-allow-origins=*")
        .arg("--window-size=1280,900")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("https://www.douyin.com/")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("官方公开主页启动失败：{error}"))?;

    let result = (|| {
        let mut port = None;
        for _ in 0..60 {
            if let Ok(content) = fs::read_to_string(&active_port) {
                port = content
                    .lines()
                    .next()
                    .and_then(|value| value.trim().parse::<u16>().ok());
                if port.is_some() {
                    break;
                }
            }
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
        let port = port.ok_or("官方公开主页没有正常启动")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|error| error.to_string())?;
        let mut websocket = None;
        for _ in 0..40 {
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/json/list"))
                .send()
            {
                if let Ok(bytes) = response.bytes() {
                    if let Ok(tabs) = serde_json::from_slice::<Value>(&bytes) {
                        websocket = tabs.as_array().and_then(|items| {
                            items.iter().find_map(|item| {
                                let page_url =
                                    item.get("url").and_then(Value::as_str).unwrap_or_default();
                                let page_type =
                                    item.get("type").and_then(Value::as_str).unwrap_or_default();
                                if page_type == "page"
                                    && (page_url.contains("douyin.com")
                                        || page_url.contains("iesdouyin.com"))
                                {
                                    item.get("webSocketDebuggerUrl")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                } else {
                                    None
                                }
                            })
                        });
                    }
                }
            }
            if websocket.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        let websocket = websocket.ok_or("无法连接官方公开主页")?;
        let (mut socket, _) = connect(websocket.as_str())
            .map_err(|error| format!("公开主页读取通道失败：{error}"))?;
        // Establish the same first-party visitor session as a normal homepage visit,
        // then navigate to the requested work/profile inside that browser context.
        thread::sleep(Duration::from_secs(5));
        socket
            .send(Message::Text(
                serde_json::json!({
                    "id": 97,
                    "method": "Page.navigate",
                    "params": { "url": target }
                })
                .to_string()
                .into(),
            ))
            .map_err(|error| format!("官方公开页面跳转失败：{error}"))?;
        loop {
            let Message::Text(text) = socket
                .read()
                .map_err(|error| format!("官方公开页面跳转中断：{error}"))?
            else {
                continue;
            };
            let payload: Value =
                serde_json::from_str(text.as_str()).map_err(|_| "官方公开页面返回了无效数据")?;
            if payload.get("id").and_then(Value::as_i64) == Some(97) {
                if let Some(detail) = payload.pointer("/error/message").and_then(Value::as_str) {
                    return Err(format!("官方公开页面跳转失败：{detail}"));
                }
                break;
            }
        }
        thread::sleep(Duration::from_secs(5));
        if limit == 0 {
            export_douyin_cookies(&mut socket, profile)?;
            let _ = socket.send(Message::Text(
                serde_json::json!({"id": 99, "method": "Browser.close"})
                    .to_string()
                    .into(),
            ));
            return Ok(Vec::new());
        }
        let rounds = if limit > 100 {
            80
        } else if limit > 30 {
            50
        } else {
            30
        };
        let expression = format!(
            r#"(async () => {{
              const found = new Map();
              let unchanged = 0;
              let previous = -1;
              for (let round = 0; round < {rounds}; round++) {{
                document.querySelectorAll('a[href*="/video/"]').forEach(anchor => {{
                  const match = anchor.href.match(/https?:\/\/(?:www\.)?douyin\.com\/video\/(\d{{10,24}})/);
                  if (!match) return;
                  const title = (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.innerText || anchor.textContent || '').trim();
                  found.set(match[1], {{ url: `https://www.douyin.com/video/${{match[1]}}`, title }});
                }});
                if (found.size >= {limit}) break;
                unchanged = found.size === previous ? unchanged + 1 : 0;
                if (unchanged >= (found.size ? 5 : 12)) break;
                previous = found.size;
                window.scrollTo(0, document.documentElement.scrollHeight);
                await new Promise(resolve => setTimeout(resolve, 900));
              }}
              return JSON.stringify([...found.values()].slice(0, {limit}));
            }})()"#
        );
        let request = serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true
            }
        });
        socket
            .send(Message::Text(request.to_string().into()))
            .map_err(|error| format!("公开主页扫描启动失败：{error}"))?;
        loop {
            let message = socket
                .read()
                .map_err(|error| format!("公开主页扫描中断：{error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let payload: Value =
                serde_json::from_str(text.as_str()).map_err(|_| "公开主页返回了无效数据")?;
            if payload.get("id").and_then(Value::as_i64) != Some(1) {
                continue;
            }
            if payload.get("error").is_some()
                || payload.pointer("/result/exceptionDetails").is_some()
            {
                let detail = payload
                    .pointer("/result/exceptionDetails/exception/description")
                    .or_else(|| payload.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知脚本错误");
                return Err(format!("官方主页脚本执行失败：{detail}"));
            }
            let value = payload
                .pointer("/result/result/value")
                .and_then(Value::as_str)
                .ok_or("官方主页没有返回作品列表")?;
            let entries: Vec<Value> =
                serde_json::from_str(value).map_err(|_| "官方主页作品列表格式无效")?;
            let items = entries
                .into_iter()
                .filter_map(|entry| {
                    let url = entry.get("url")?.as_str()?.to_string();
                    let id = url.rsplit('/').next()?.to_string();
                    Some(ProfileItem {
                        url,
                        id: id.clone(),
                        title: entry
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|title| !title.trim().is_empty())
                            .unwrap_or("抖音视频")
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>();
            export_douyin_cookies(&mut socket, profile)?;
            let _ = socket.send(Message::Text(
                serde_json::json!({"id": 99, "method": "Browser.close"})
                    .to_string()
                    .into(),
            ));
            return if items.is_empty() {
                Err("抖音公开主页没有返回作品；可打开“平台登录”完成验证后重试".into())
            } else {
                Ok(items)
            };
        }
    })();
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn scan_douyin_profile(
    app: &tauri::AppHandle,
    source: &str,
    limit: usize,
) -> Result<Vec<ProfileItem>, String> {
    let resolved = resolve_douyin_url(source)?;
    let sec_uid =
        douyin_sec_uid(&resolved).ok_or("没有识别出抖音博主主页，请复制作者主页分享链接后重试")?;
    let target = format!("https://www.douyin.com/user/{sec_uid}");
    let edge = find_edge().ok_or("未找到 Windows 自带的 Microsoft Edge")?;
    let profile = if login_profile_exists(app) {
        edge_profile_dir(app)?
    } else {
        public_edge_profile_dir(app)?
    };
    scan_profile_with_edge(&edge, &profile, &target, limit)
}

#[tauri::command]
async fn scan_profile(
    app: tauri::AppHandle,
    request: ProfileRequest,
) -> Result<Vec<ProfileItem>, String> {
    if request.limit == 0 || request.limit > 500 {
        return Err("主页数量必须在 1 到 500 之间".into());
    }
    let url = validate_url(&request.url)?;
    let yt_dlp = find_tool(&app, "yt-dlp.exe").ok_or("下载引擎尚未就绪")?;
    tauri::async_runtime::spawn_blocking(move || {
        if is_douyin_url(&url) {
            return scan_douyin_profile(&app, &url, request.limit);
        }
        let mut command = Command::new(yt_dlp);
        hidden(&mut command)
            .arg("--flat-playlist")
            .arg("--dump-single-json")
            .arg("--no-warnings")
            .arg("--playlist-end")
            .arg(request.limit.to_string())
            .arg(url);
        add_cookie_args(&app, &mut command);
        let output = command
            .output()
            .map_err(|error| format!("主页扫描启动失败：{error}"))?;
        if !output.status.success() {
            return Err(user_error(&String::from_utf8_lossy(&output.stderr)));
        }
        let payload: Value =
            serde_json::from_slice(&output.stdout).map_err(|_| "平台没有返回可识别的主页列表")?;
        let entries = payload
            .get("entries")
            .and_then(Value::as_array)
            .ok_or("该链接不是可扫描的公开主页或播放列表")?;
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for entry in entries {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            let extractor = entry
                .get("extractor_key")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let raw_url = entry
                .get("webpage_url")
                .or_else(|| entry.get("original_url"))
                .or_else(|| entry.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let item_url = if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
                raw_url.to_string()
            } else if extractor.to_lowercase().contains("youtube") && !id.is_empty() {
                format!("https://www.youtube.com/watch?v={id}")
            } else {
                continue;
            };
            if seen.insert(item_url.clone()) {
                items.push(ProfileItem {
                    url: item_url,
                    title: entry
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名视频")
                        .to_string(),
                    id: id.to_string(),
                });
            }
        }
        if items.is_empty() {
            return Err(
                "没有扫描到可下载的公开视频；该平台可能要求先登录或暂不开放主页列表".into(),
            );
        }
        Ok(items)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn platform_from_preview(source: &str, payload: &Value) -> String {
    let extractor = payload
        .get("extractor_key")
        .or_else(|| payload.get("extractor"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let host = Url::parse(source)
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .unwrap_or_default();
    if extractor.contains("douyin") || host.contains("douyin.com") {
        "抖音".into()
    } else if extractor.contains("tiktok") || host.contains("tiktok.com") {
        "TikTok".into()
    } else if extractor.contains("youtube")
        || host.contains("youtube.com")
        || host.contains("youtu.be")
    {
        "YouTube".into()
    } else if extractor.contains("bilibili")
        || host.contains("bilibili.com")
        || host.contains("b23.tv")
    {
        "哔哩哔哩".into()
    } else if extractor.contains("instagram") || host.contains("instagram.com") {
        "Instagram".into()
    } else if extractor.contains("facebook")
        || host.contains("facebook.com")
        || host.contains("fb.watch")
    {
        "Facebook".into()
    } else if extractor.contains("twitter")
        || host.contains("twitter.com")
        || host.contains("x.com")
    {
        "X / Twitter".into()
    } else {
        "自动识别".into()
    }
}

fn preview_from_payload(source: String, payload: Value) -> MediaPreview {
    let thumbnail = payload
        .get("thumbnail")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("thumbnails")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().rev().find_map(|item| item.get("url")))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let size_bytes = payload
        .get("filesize")
        .or_else(|| payload.get("filesize_approx"))
        .and_then(Value::as_u64);
    MediaPreview {
        platform: platform_from_preview(&source, &payload),
        url: source,
        title: payload
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("未命名视频")
            .to_string(),
        uploader: payload
            .get("uploader")
            .or_else(|| payload.get("channel"))
            .or_else(|| payload.get("creator"))
            .and_then(Value::as_str)
            .unwrap_or("未知作者")
            .to_string(),
        thumbnail,
        duration: payload.get("duration").and_then(Value::as_f64),
        size_bytes,
        error: None,
    }
}

fn inspect_item(app: &tauri::AppHandle, yt_dlp: &Path, source: String) -> MediaPreview {
    let fallback = |message: String| MediaPreview {
        platform: platform_from_preview(&source, &Value::Null),
        url: source.clone(),
        title: "等待下载时读取详情".into(),
        uploader: "公开作品".into(),
        thumbnail: None,
        duration: None,
        size_bytes: None,
        error: Some(message),
    };
    let url = match validate_url(&source) {
        Ok(url) => url,
        Err(error) => return fallback(error),
    };
    if is_douyin_url(&url) && !login_profile_exists(app) {
        let profile = match public_edge_profile_dir(app) {
            Ok(profile) => profile,
            Err(error) => return fallback(error),
        };
        if !public_session_fresh(&profile) {
            let edge = match find_edge() {
                Some(edge) => edge,
                None => return fallback("未找到 Windows 自带的 Microsoft Edge".into()),
            };
            if let Err(error) = scan_profile_with_edge(&edge, &profile, &url, 0) {
                return fallback(error);
            }
        }
    }
    if is_tiktok_url(&url) {
        let cache = match app.path().app_cache_dir() {
            Ok(cache) => cache,
            Err(error) => return fallback(error.to_string()),
        };
        if let Err(error) = fs::create_dir_all(&cache) {
            return fallback(format!("无法创建预览缓存：{error}"));
        }
        let path = cache.join(format!(
            "preview-tiktok-{}.json",
            tiktok_video_id(&url).unwrap_or_default()
        ));
        let result = prepare_tiktok_info_json(app, &url, &path, false)
            .and_then(|prepared| fs::read(&prepared.info_path).map_err(|error| error.to_string()))
            .and_then(|bytes| {
                serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())
            });
        let _ = fs::remove_file(path);
        return match result {
            Ok(payload) => preview_from_payload(url, payload),
            Err(error) => fallback(error),
        };
    }
    let mut command = Command::new(yt_dlp);
    hidden(&mut command)
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg(&url);
    add_cookie_args(app, &mut command);
    let output = match command.output() {
        Ok(output) => output,
        Err(error) => return fallback(format!("解析启动失败：{error}")),
    };
    if !output.status.success() {
        return fallback(user_error(&String::from_utf8_lossy(&output.stderr)));
    }
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(payload) => preview_from_payload(url, payload),
        Err(_) => fallback("平台没有返回可识别的视频信息".into()),
    }
}

#[tauri::command]
async fn inspect_items(
    app: tauri::AppHandle,
    urls: Vec<String>,
) -> Result<Vec<MediaPreview>, String> {
    if urls.is_empty() || urls.len() > 50 {
        return Err("一次可以解析 1 到 50 条作品".into());
    }
    let yt_dlp = find_tool(&app, "yt-dlp.exe").ok_or("下载引擎尚未就绪")?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(urls
            .into_iter()
            .map(|url| inspect_item(&app, &yt_dlp, url))
            .collect::<Vec<_>>())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn is_tiktok_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .map(|host| host == "tiktok.com" || host.ends_with(".tiktok.com"))
        .unwrap_or(false)
}

fn tiktok_video_id(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let parts = url.path_segments()?.collect::<Vec<_>>();
    parts.windows(2).find_map(|pair| {
        if pair[0] == "video"
            && pair[1].len() >= 10
            && pair[1].chars().all(|character| character.is_ascii_digit())
        {
            Some(pair[1].to_string())
        } else {
            None
        }
    })
}

fn tiktok_media_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .map(|url| {
            let host = url.host_str().unwrap_or_default().to_lowercase();
            host.ends_with("-webapp-prime.tiktok.com")
                || host == "webapp-prime.tiktok.com"
                || (host.ends_with(".com") && host.contains(".tiktokcdn-"))
                || [
                    "tiktokcdn.com",
                    "tiktokv.com",
                    "byteoversea.com",
                    "ibytedtos.com",
                ]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
        .unwrap_or(false)
}

fn tiktok_media_from_public_fallback(payload: &Value, video_id: &str) -> Option<String> {
    if payload.get("code").and_then(Value::as_i64) != Some(0)
        || payload.pointer("/data/id").and_then(Value::as_str) != Some(video_id)
    {
        return None;
    }
    ["/data/hdplay", "/data/play"]
        .into_iter()
        .filter_map(|pointer| payload.pointer(pointer).and_then(Value::as_str))
        .find(|candidate| tiktok_media_url(candidate))
        .map(str::to_string)
}

fn tiktok_media_with_public_fallback(
    client: &reqwest::blocking::Client,
    page_url: &str,
    video_id: &str,
) -> Result<String, String> {
    let body = client
        .post("https://www.tikwm.com/api/")
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .form(&[("url", page_url), ("hd", "1")])
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::text)
        .map_err(|error| format!("TikTok 公开解析回退失败：{error}"))?;
    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| format!("TikTok 公开解析回退数据无效：{error}"))?;
    tiktok_media_from_public_fallback(&payload, video_id)
        .ok_or_else(|| "TikTok 公开解析回退没有返回安全的视频地址".into())
}

fn tiktok_embed_state(html: &str) -> Result<Value, String> {
    let marker = "__FRONTITY_CONNECT_STATE__";
    let marker_at = html
        .find(marker)
        .ok_or("TikTok 官方嵌入页没有返回作品状态")?;
    let script_at = html[..marker_at]
        .rfind("<script")
        .ok_or("TikTok 官方嵌入页结构无效")?;
    let content_at = html[script_at..]
        .find('>')
        .map(|offset| script_at + offset + 1)
        .ok_or("TikTok 官方嵌入页脚本无效")?;
    let end_at = html[content_at..]
        .find("</script>")
        .map(|offset| content_at + offset)
        .ok_or("TikTok 官方嵌入页脚本不完整")?;
    serde_json::from_str(&html[content_at..end_at]).map_err(|_| "TikTok 官方嵌入页数据无效".into())
}

fn cdp_call<S: Read + Write>(
    socket: &mut tungstenite::WebSocket<S>,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    socket
        .send(Message::Text(
            serde_json::json!({ "id": id, "method": method, "params": params })
                .to_string()
                .into(),
        ))
        .map_err(|error| format!("浏览器会话请求失败：{error}"))?;
    loop {
        let message = socket
            .read()
            .map_err(|error| format!("浏览器会话读取失败：{error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let payload: Value =
            serde_json::from_str(text.as_str()).map_err(|_| "浏览器会话返回了无效数据")?;
        if payload.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(detail) = payload.pointer("/error/message").and_then(Value::as_str) {
            return Err(format!("浏览器会话执行失败：{detail}"));
        }
        return Ok(payload);
    }
}

struct PreparedTikTok {
    info_path: PathBuf,
    cookie_path: Option<PathBuf>,
}

fn tiktok_media_with_edge(
    app: &tauri::AppHandle,
    page_url: &str,
    embed_url: &str,
) -> Result<(String, String), String> {
    let edge = find_edge().ok_or("未找到 Windows 自带的 Microsoft Edge")?;
    let session_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let profile = public_edge_profile_dir(app)?
        .join("tiktok-sessions")
        .join(format!("{}-{session_id}", process::id()));
    fs::create_dir_all(&profile).map_err(|error| format!("无法创建 TikTok 公开会话：{error}"))?;
    let active_port = profile.join("DevToolsActivePort");
    let _ = fs::remove_file(&active_port);
    let mut command = Command::new(edge);
    hidden(&mut command)
        .arg("--headless=new")
        .arg("--edge-skip-compat-layer-relaunch")
        .arg("--disable-gpu")
        .arg("--disable-extensions")
        .arg("--disable-background-networking")
        .arg("--disable-component-update")
        .arg("--disable-sync")
        .arg("--disable-default-apps")
        .arg("--disable-blink-features=AutomationControlled")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--remote-debugging-port=0")
        .arg("--remote-allow-origins=*")
        .arg("--window-size=720,960")
        .arg("--autoplay-policy=no-user-gesture-required")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(page_url)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("TikTok 官方播放器启动失败：{error}"))?;

    let mut browser_socket = None;
    let result = (|| {
        let mut port = None;
        for _ in 0..60 {
            if let Ok(content) = fs::read_to_string(&active_port) {
                port = content
                    .lines()
                    .next()
                    .and_then(|value| value.trim().parse::<u16>().ok());
                if port.is_some() {
                    break;
                }
            }
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
        let port = port.ok_or("TikTok 官方播放器没有正常启动")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|error| error.to_string())?;
        let mut websocket = None;
        for _ in 0..40 {
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/json/list"))
                .send()
            {
                if let Ok(tabs) = response
                    .text()
                    .ok()
                    .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                    .ok_or(())
                {
                    websocket = tabs.as_array().and_then(|items| {
                        items.iter().find_map(|item| {
                            let page_url = item.get("url").and_then(Value::as_str)?;
                            if item.get("type").and_then(Value::as_str) == Some("page")
                                && page_url.starts_with("https://www.tiktok.com/")
                            {
                                item.get("webSocketDebuggerUrl")
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                            } else {
                                None
                            }
                        })
                    });
                }
            }
            if websocket.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        let websocket = websocket.ok_or("无法连接 TikTok 官方播放器")?;
        let (mut socket, _) = connect(websocket.as_str())
            .map_err(|error| format!("TikTok 播放器读取通道失败：{error}"))?;
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .map_err(|error| format!("TikTok 播放器读取超时设置失败：{error}"))?;
            stream
                .set_write_timeout(Some(Duration::from_secs(4)))
                .map_err(|error| format!("TikTok 播放器写入超时设置失败：{error}"))?;
        }
        browser_socket = Some(socket);
        let socket = browser_socket
            .as_mut()
            .ok_or("TikTok 播放器读取通道不可用")?;
        let mut playback_session = false;
        for id in 1..=60 {
            let payload = cdp_call(socket, id, "Network.getAllCookies", serde_json::json!({}))?;
            playback_session = payload
                .pointer("/result/cookies")
                .and_then(Value::as_array)
                .is_some_and(|cookies| {
                    cookies.iter().any(|cookie| {
                        cookie.get("name").and_then(Value::as_str) == Some("tt_chain_token")
                    })
                });
            if playback_session {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if !playback_session {
            return Err("TikTok 官方页面没有建立播放会话".into());
        }
        cdp_call(
            socket,
            70,
            "Page.navigate",
            serde_json::json!({ "url": embed_url }),
        )?;
        let expression = r#"JSON.stringify({url: Array.from(document.querySelectorAll('video')).map(video => video.currentSrc || video.src).find(value => { try { const host = new URL(value).hostname; return host.endsWith('tiktokcdn.com') || host.endsWith('tiktokv.com') || host.endsWith('byteoversea.com') || host.endsWith('ibytedtos.com') || host.endsWith('-webapp-prime.tiktok.com'); } catch { return false; } }) || ''})"#;
        let mut media_url = None;
        for id in 100..=160 {
            let payload = cdp_call(
                socket,
                id,
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": expression,
                    "returnByValue": true
                }),
            )?;
            let value = payload
                .pointer("/result/result/value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let data = serde_json::from_str::<Value>(value).ok();
            let candidate = data
                .as_ref()
                .and_then(|data| data.get("url").and_then(Value::as_str).map(str::to_string));
            if candidate.as_deref().is_some_and(tiktok_media_url) {
                media_url = candidate;
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        let media_url = media_url.ok_or("TikTok 官方播放器没有生成视频地址")?;
        let payload = cdp_call(socket, 200, "Network.getAllCookies", serde_json::json!({}))?;
        let mut cookie_file = String::from("# Netscape HTTP Cookie File\n");
        let cookie_lines = payload
            .pointer("/result/cookies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|cookie| {
                let domain = cookie.get("domain")?.as_str()?.trim_start_matches('.');
                if domain != "tiktok.com" && !domain.ends_with(".tiktok.com") {
                    return None;
                }
                let name = cookie.get("name")?.as_str()?;
                let value = cookie.get("value")?.as_str()?;
                if name.contains(['\t', '\r', '\n']) || value.contains(['\t', '\r', '\n']) {
                    return None;
                }
                let expires = cookie
                    .get("expires")
                    .and_then(Value::as_f64)
                    .filter(|value| *value > 0.0)
                    .unwrap_or(0.0) as u64;
                Some(format!(
                    ".tiktok.com\tTRUE\t/\tTRUE\t{expires}\t{name}\t{value}\n"
                ))
            })
            .collect::<Vec<_>>();
        if cookie_lines.is_empty() {
            return Err("TikTok 官方播放器没有建立匿名会话".into());
        }
        cookie_file.push_str(&cookie_lines.concat());
        Ok((media_url, cookie_file))
    })();
    if let Some(socket) = browser_socket.as_mut() {
        let _ = socket.send(Message::Text(
            serde_json::json!({"id": 9999, "method": "Browser.close"})
                .to_string()
                .into(),
        ));
    }
    drop(browser_socket);
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    let mut removed = false;
    for _ in 0..40 {
        match fs::remove_dir_all(&profile) {
            Ok(()) => {
                removed = true;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                removed = true;
                break;
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
    if !removed {
        runtime_log(
            app,
            format!(
                "tiktok_session_cleanup_failed profile={}",
                profile.display()
            ),
        );
    }
    result
}

fn prepare_tiktok_info_json(
    app: &tauri::AppHandle,
    source: &str,
    destination: &Path,
    browser_fallback: bool,
) -> Result<PreparedTikTok, String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| error.to_string())?;
    let mut canonical = source.to_string();
    let mut video_id = tiktok_video_id(source);
    if video_id.is_none() {
        let response = client
            .get(source)
            .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
            .send()
            .map_err(|error| format!("TikTok 短链接展开失败：{error}"))?;
        canonical = response.url().to_string();
        video_id = tiktok_video_id(&canonical);
    }
    let video_id = video_id.ok_or("没有从 TikTok 链接识别出作品 ID")?;
    let embed_url = format!("https://www.tiktok.com/embed/v2/{video_id}");
    let player_url = format!("https://www.tiktok.com/player/v1/{video_id}?autoplay=1&loop=1");
    let html = client
        .get(&embed_url)
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .and_then(reqwest::blocking::Response::text)
        .map_err(|error| format!("TikTok 官方嵌入页读取失败：{error}"))?;
    if html.len() > 4 * 1024 * 1024 {
        return Err("TikTok 官方嵌入页数据异常".into());
    }
    let state = tiktok_embed_state(&html)?;
    let entries = state
        .pointer("/source/data")
        .and_then(Value::as_object)
        .ok_or("TikTok 官方嵌入页缺少作品数据")?;
    let entry = entries
        .get(&format!("/embed/v2/{video_id}"))
        .or_else(|| {
            entries
                .values()
                .find(|value| value.get("videoData").is_some())
        })
        .ok_or("TikTok 官方嵌入页没有找到该作品")?;
    let video_data = entry
        .get("videoData")
        .ok_or("TikTok 官方嵌入页缺少视频数据")?;
    let item = video_data
        .get("itemInfos")
        .ok_or("TikTok 官方嵌入页缺少作品信息")?;
    if item.get("id").and_then(Value::as_str) != Some(video_id.as_str()) {
        return Err("TikTok 官方嵌入页返回了其他作品".into());
    }
    let video = item.get("video").ok_or("TikTok 作品缺少媒体信息")?;
    let embedded_media_url = video
        .get("urls")
        .and_then(Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .find(|candidate| tiktok_media_url(candidate))
        });
    let (media_url, cookie_file, media_referer) = if let Some(media_url) = embedded_media_url {
        (media_url.to_string(), None, embed_url.clone())
    } else if browser_fallback {
        match tiktok_media_with_public_fallback(&client, &canonical, &video_id) {
            Ok(media_url) => (media_url, None, "https://www.tiktok.com/".into()),
            Err(public_error) => {
                let (media_url, cookie_file) = tiktok_media_with_edge(app, &canonical, &player_url)
                    .map_err(|edge_error| {
                        format!("{public_error}；官方播放器回退也失败：{edge_error}")
                    })?;
                (media_url, Some(cookie_file), player_url)
            }
        }
    } else {
        return Err("TikTok 官方页面没有返回安全的视频地址".into());
    };
    let metadata = video.get("videoMeta").unwrap_or(&Value::Null);
    let title = item
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("TikTok 视频");
    let author = video_data.get("authorInfos").and_then(Value::as_object);
    let thumbnail = item
        .get("coversOrigin")
        .or_else(|| item.get("covers"))
        .and_then(Value::as_array)
        .and_then(|values| values.iter().filter_map(Value::as_str).next());
    let mut http_headers = serde_json::json!({ "Referer": media_referer });
    if cookie_file.is_none() {
        http_headers
            .as_object_mut()
            .ok_or("TikTok 请求头创建失败")?
            .insert(
                "User-Agent".into(),
                Value::String(BROWSER_USER_AGENT.into()),
            );
    }
    let info = serde_json::json!({
        "_type": "video",
        "id": video_id,
        "title": title,
        "description": title,
        "extractor": "TikTokEmbed",
        "extractor_key": "TikTokEmbed",
        "webpage_url": canonical,
        "original_url": source,
        "thumbnail": thumbnail,
        "uploader": author.and_then(|value| value.get("uniqueId")).and_then(Value::as_str),
        "uploader_id": author.and_then(|value| value.get("userId")).and_then(Value::as_str),
        "timestamp": item.get("createTime").and_then(Value::as_i64),
        "duration": metadata.get("duration").and_then(Value::as_f64),
        "formats": [{
            "format_id": "official-embed",
            "format_note": "官方嵌入页原始画质",
            "url": media_url,
            "ext": "mp4",
            "protocol": "https",
            "width": metadata.get("width").and_then(Value::as_i64),
            "height": metadata.get("height").and_then(Value::as_i64),
            "vcodec": "h264",
            "acodec": "aac",
            "http_headers": http_headers
        }],
        "subtitles": {}
    });
    let cookie_path = cookie_file
        .map(|body| {
            let path = destination.with_extension("cookies.txt");
            fs::write(&path, body)
                .map(|_| path)
                .map_err(|error| format!("无法准备 TikTok 匿名会话：{error}"))
        })
        .transpose()?;
    if let Err(error) = fs::write(
        destination,
        serde_json::to_vec(&info).map_err(|error| error.to_string())?,
    ) {
        if let Some(path) = cookie_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        return Err(format!("无法准备 TikTok 下载信息：{error}"));
    }
    Ok(PreparedTikTok {
        info_path: destination.to_path_buf(),
        cookie_path,
    })
}

fn validate_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() > 4096 || !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err("请输入有效的 HTTP/HTTPS 链接".into());
    }
    Ok(value.to_string())
}

fn quality_selector(value: &str) -> &'static str {
    match value {
        "2160" => {
            "bv*[height<=2160]+ba/b[height<=2160]/bv*[width<=2160]+ba/b[width<=2160]/bv*+ba/b"
        }
        "1440" => {
            "bv*[height<=1440]+ba/b[height<=1440]/bv*[width<=1440]+ba/b[width<=1440]/bv*+ba/b"
        }
        "1080" => {
            "bv*[height<=1080]+ba/b[height<=1080]/bv*[width<=1080]+ba/b[width<=1080]/bv*+ba/b"
        }
        "720" => "bv*[height<=720]+ba/b[height<=720]/bv*[width<=720]+ba/b[width<=720]/bv*+ba/b",
        "480" => "bv*[height<=480]+ba/b[height<=480]/bv*[width<=480]+ba/b[width<=480]/bv*+ba/b",
        _ => "bv*+ba/b",
    }
}

fn find_tiktok_media_file(root: &Path, video_id: &str) -> Option<PathBuf> {
    let mut pending = VecDeque::from([(root.to_path_buf(), 0_u8)]);
    let mut matches = Vec::new();
    while let Some((directory, depth)) = pending.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() && depth < 3 {
                pending.push_back((path, depth + 1));
                continue;
            }
            if !file_type.is_file() || !path.to_string_lossy().contains(video_id) {
                continue;
            }
            let is_media = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| {
                    ["mp4", "webm", "mkv", "mov", "m4v"]
                        .iter()
                        .any(|extension| value.eq_ignore_ascii_case(extension))
                })
                .unwrap_or(false);
            if is_media {
                matches.push(path);
            }
        }
    }
    matches.into_iter().max_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    })
}

fn emit_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    phase: &str,
    percent: f64,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "job-progress",
        ProgressEvent {
            job_id: job_id.to_string(),
            phase: phase.to_string(),
            percent,
            message: message.into(),
        },
    );
}

fn parse_percent(line: &str) -> Option<f64> {
    let marker = line.find('%')?;
    let prefix = &line[..marker];
    let start = prefix
        .rfind(|character: char| !(character.is_ascii_digit() || character == '.'))
        .map(|index| index + 1)
        .unwrap_or(0);
    prefix[start..].trim().parse().ok()
}

fn run_streaming(
    app: &tauri::AppHandle,
    state: &RuntimeState,
    job_id: &str,
    phase: &str,
    command: &mut Command,
) -> Result<ProcessOutput, String> {
    hidden(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("任务启动失败：{error}"))?;
    state
        .processes
        .lock()
        .map_err(|_| "任务状态不可用")?
        .insert(job_id.to_string(), child.id());
    let stdout = child.stdout.take().ok_or("无法读取任务输出")?;
    let stderr = child.stderr.take().ok_or("无法读取错误信息")?;
    let (sender, receiver) = mpsc::channel::<(bool, String)>();
    let stdout_sender = sender.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = stdout_sender.send((false, line));
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = sender.send((true, line));
        }
    });

    let mut result = ProcessOutput::default();
    for (is_error, line) in receiver {
        if let Some(path) = line.strip_prefix("__YINGLIAN_FILE__") {
            result.output_file = Some(PathBuf::from(path.trim()));
        }
        if let Some(percent) = parse_percent(&line) {
            emit_progress(app, job_id, phase, percent, line.trim());
        }
        if is_error {
            if result.errors.len() >= 30 {
                result.errors.pop_front();
            }
            result.errors.push_back(line.clone());
        }
        result.lines.push(line);
    }
    let status = child
        .wait()
        .map_err(|error| format!("无法读取任务结果：{error}"))?;
    state
        .processes
        .lock()
        .map_err(|_| "任务状态不可用")?
        .remove(job_id);
    if !status.success() {
        let detail = result.errors.iter().cloned().collect::<Vec<_>>().join("\n");
        return Err(user_error(&detail));
    }
    Ok(result)
}

fn user_error(detail: &str) -> String {
    let lower = detail.to_lowercase();
    if lower.contains("login") || lower.contains("cookies") || lower.contains("sign in") {
        "平台要求登录或登录会话已经失效；请先打开对应平台的官方登录窗口。".into()
    } else if lower.contains("unsupported url") {
        "当前下载引擎暂不支持该链接；请确认粘贴的是公开作品或主页链接。".into()
    } else if lower.contains("private") || lower.contains("not available") {
        "该内容不是公开可用状态，或受到地区/账号权限限制。".into()
    } else if lower.contains("unable to extract") {
        "平台页面已经变化，当前解析引擎暂时无法读取；请更新影链工坊后重试。".into()
    } else {
        detail
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("任务失败")
            .trim()
            .to_string()
    }
}

fn make_platform_text(info: &Value) -> String {
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("未命名视频");
    let uploader = info
        .get("uploader")
        .or_else(|| info.get("channel"))
        .and_then(Value::as_str)
        .unwrap_or("未知作者");
    let source = info
        .get("webpage_url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let description = info
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tags = info
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|tag| format!("#{tag}"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    format!("标题：{title}\n作者：{uploader}\n来源：{source}\n\n{description}\n\n{tags}\n")
}

fn strip_subtitle(path: &Path) -> Result<String, String> {
    let source = fs::read_to_string(path).map_err(|error| format!("无法读取字幕：{error}"))?;
    let mut output = Vec::new();
    let mut previous = String::new();
    for raw in source.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line == "WEBVTT"
            || line.chars().all(|character| character.is_ascii_digit())
            || line.contains("-->")
        {
            continue;
        }
        let mut clean = String::new();
        let mut in_tag = false;
        for character in line.chars() {
            match character {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => clean.push(character),
                _ => {}
            }
        }
        let clean = clean.trim();
        if !clean.is_empty() && clean != previous {
            output.push(clean.to_string());
            previous = clean.to_string();
        }
    }
    Ok(output.join("\n"))
}

fn parse_srt(path: &Path) -> Result<Vec<TranslationSegment>, String> {
    let source = fs::read_to_string(path).map_err(|error| format!("无法读取字幕：{error}"))?;
    let normalized = source.replace("\r\n", "\n");
    let mut segments = Vec::new();
    for block in normalized.split("\n\n") {
        let lines = block
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        let timing_index = lines.iter().position(|line| line.contains("-->"));
        let Some(timing_index) = timing_index else {
            continue;
        };
        let timing = lines[timing_index]
            .split("-->")
            .map(str::trim)
            .collect::<Vec<_>>();
        if timing.len() != 2 {
            continue;
        }
        let text = lines[(timing_index + 1)..].join(" ");
        if text.is_empty() {
            continue;
        }
        segments.push(TranslationSegment {
            index: segments.len() + 1,
            start: timing[0].to_string(),
            end: timing[1].to_string(),
            text,
        });
    }
    Ok(segments)
}

fn language_from_subtitle(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let candidate = stem.rsplit('.').next()?;
    if candidate.eq_ignore_ascii_case("视频") || candidate.len() > 16 {
        None
    } else {
        Some(
            candidate
                .split('-')
                .next()
                .unwrap_or(candidate)
                .to_lowercase(),
        )
    }
}

fn detect_whisper_language(lines: &[String]) -> Option<String> {
    for line in lines {
        let lower = line.to_lowercase();
        if let Some(index) = lower.find("auto-detected language:") {
            return line[(index + "auto-detected language:".len())..]
                .split_whitespace()
                .next()
                .map(|value| {
                    value
                        .trim_matches(|character: char| !character.is_ascii_alphabetic())
                        .to_lowercase()
                })
                .filter(|value| !value.is_empty());
        }
    }
    None
}

#[tauri::command]
fn translation_input(request: TranslationInputRequest) -> Result<TranslationInput, String> {
    let output_dir = PathBuf::from(request.output_dir);
    if !output_dir.is_dir() {
        return Err("任务输出目录不存在".into());
    }
    let preferred = ["语音识别字幕.srt", "字幕.srt"];
    let subtitle = preferred
        .iter()
        .map(|name| output_dir.join(name))
        .find(|path| path.is_file())
        .or_else(|| {
            fs::read_dir(&output_dir)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .find(|path| {
                    path.extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.eq_ignore_ascii_case("srt"))
                        .unwrap_or(false)
                })
        });
    let segments = if let Some(path) = subtitle {
        parse_srt(&path)?
    } else {
        let text_path = ["语音识别文案.txt", "字幕文案.txt"]
            .iter()
            .map(|name| output_dir.join(name))
            .find(|path| path.is_file())
            .ok_or("没有找到可翻译的语音文案")?;
        fs::read_to_string(text_path)
            .map_err(|error| format!("无法读取语音文案：{error}"))?
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .enumerate()
            .map(|(index, text)| TranslationSegment {
                index: index + 1,
                start: String::new(),
                end: String::new(),
                text: text.to_string(),
            })
            .collect()
    };
    if segments.is_empty() {
        return Err("文案内容为空，无法翻译".into());
    }
    Ok(TranslationInput {
        source_language: request.source_language,
        segments,
    })
}

#[tauri::command]
fn save_translation(request: SaveTranslationRequest) -> Result<(), String> {
    if request.segments.is_empty() || request.segments.len() != request.translations.len() {
        return Err("翻译结果数量不完整".into());
    }
    let output_dir = PathBuf::from(request.output_dir);
    if !output_dir.is_dir() {
        return Err("任务输出目录不存在".into());
    }
    let chinese = request.translations.join("\n");
    let bilingual = request
        .segments
        .iter()
        .zip(&request.translations)
        .map(|(segment, translated)| format!("{}\n{}", segment.text, translated))
        .collect::<Vec<_>>()
        .join("\n\n");
    fs::write(output_dir.join("中文翻译.txt"), chinese)
        .map_err(|error| format!("无法保存中文翻译：{error}"))?;
    fs::write(output_dir.join("双语文案.txt"), bilingual)
        .map_err(|error| format!("无法保存双语文案：{error}"))?;

    if request
        .segments
        .iter()
        .all(|segment| !segment.start.is_empty() && !segment.end.is_empty())
    {
        let subtitles = request
            .segments
            .iter()
            .zip(&request.translations)
            .map(|(segment, translated)| {
                format!(
                    "{}\n{} --> {}\n{}\n{}",
                    segment.index, segment.start, segment.end, segment.text, translated
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        fs::write(output_dir.join("双语字幕.srt"), format!("{subtitles}\n"))
            .map_err(|error| format!("无法保存双语字幕：{error}"))?;
    }
    Ok(())
}

fn postprocess_metadata(
    job_dir: &Path,
    include_description: bool,
) -> Result<(String, String, Option<PathBuf>), String> {
    let mut title = "未命名视频".to_string();
    let mut platform = "自动识别".to_string();
    let mut native_subtitle = None;
    let entries = fs::read_dir(job_dir).map_err(|error| format!("无法读取下载目录：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        if name.ends_with(".info.json") {
            if let Ok(payload) = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .ok_or(())
            {
                title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&title)
                    .to_string();
                platform = payload
                    .get("extractor_key")
                    .or_else(|| payload.get("extractor"))
                    .and_then(Value::as_str)
                    .unwrap_or(&platform)
                    .to_string();
                if include_description {
                    fs::write(
                        job_dir.join("平台原文文案.txt"),
                        make_platform_text(&payload),
                    )
                    .map_err(|error| format!("无法保存平台文案：{error}"))?;
                }
            }
            let _ = fs::rename(&path, job_dir.join("视频信息.json"));
        } else if name.ends_with(".description") {
            let _ = fs::remove_file(&path);
        } else if ["jpg", "jpeg", "png", "webp"].iter().any(|extension| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case(extension))
                .unwrap_or(false)
        }) {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("jpg");
            let _ = fs::rename(&path, job_dir.join(format!("封面.{extension}")));
        } else if (name.ends_with(".srt") || name.ends_with(".vtt")) && native_subtitle.is_none() {
            native_subtitle = Some(path);
        }
    }
    Ok((title, platform, native_subtitle))
}

fn transcribe(
    app: &tauri::AppHandle,
    state: &RuntimeState,
    request: &DownloadRequest,
    media_file: &Path,
    job_dir: &Path,
) -> Result<String, String> {
    let ffmpeg = find_tool(app, "ffmpeg.exe").ok_or("缺少 FFmpeg，无法提取语音")?;
    let whisper = find_tool(app, "whisper-cli.exe").ok_or("本地转写引擎尚未就绪")?;
    let model = model_path(app, &request.options.model_id)?;
    if !model.is_file() {
        return Err(format!("尚未下载 {} 模型", request.options.model_id));
    }
    let scratch_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let scratch = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("transcribe")
        .join(format!("{}-{scratch_id}", process::id()));
    fs::create_dir_all(&scratch).map_err(|error| format!("无法创建语音识别临时目录：{error}"))?;
    let result = (|| {
        let audio = scratch.join("audio.wav");
        emit_progress(app, &request.job_id, "transcribing", 2.0, "正在提取音轨");
        let mut ffmpeg_command = Command::new(ffmpeg);
        hidden(&mut ffmpeg_command)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-y")
            .arg("-i")
            .arg(media_file)
            .arg("-vn")
            .arg("-ar")
            .arg("16000")
            .arg("-ac")
            .arg("1")
            .arg("-c:a")
            .arg("pcm_s16le")
            .arg(&audio);
        let status = ffmpeg_command
            .status()
            .map_err(|error| format!("音轨提取启动失败：{error}"))?;
        if !status.success() {
            return Err("无法从视频中提取语音".into());
        }

        emit_progress(
            app,
            &request.job_id,
            "transcribing",
            8.0,
            "正在识别视频语言和语音",
        );
        let output_base = scratch.join("result");
        let mut whisper_command = Command::new(whisper);
        whisper_command
            .arg("-m")
            .arg(model)
            .arg("-f")
            .arg(&audio)
            .arg("-otxt")
            .arg("-osrt")
            .arg("-of")
            .arg(&output_base)
            .arg("-l")
            .arg(if request.options.language.trim().is_empty() {
                "auto"
            } else {
                request.options.language.as_str()
            });
        let process_output = run_streaming(
            app,
            state,
            &request.job_id,
            "transcribing",
            &mut whisper_command,
        )?;
        let text = output_base.with_extension("txt");
        let subtitle = output_base.with_extension("srt");
        if !text.is_file() || !subtitle.is_file() {
            return Err("语音识别完成但没有生成文案或字幕".into());
        }
        let transcript_text =
            fs::read(&text).map_err(|error| format!("无法读取语音识别文案：{error}"))?;
        fs::write(job_dir.join("语音识别文案.txt"), transcript_text)
            .map_err(|error| format!("无法保存语音识别文案：{error}"))?;
        let subtitle_text =
            fs::read(&subtitle).map_err(|error| format!("无法读取语音识别字幕：{error}"))?;
        fs::write(job_dir.join("语音识别字幕.srt"), subtitle_text)
            .map_err(|error| format!("无法保存语音识别字幕：{error}"))?;
        Ok(
            detect_whisper_language(&process_output.lines).unwrap_or_else(|| {
                if request.options.language == "auto" {
                    "unknown".into()
                } else {
                    request.options.language.clone()
                }
            }),
        )
    })();
    let _ = fs::remove_dir_all(&scratch);
    result
}

fn execute_download(
    app: tauri::AppHandle,
    state: RuntimeState,
    request: DownloadRequest,
) -> Result<DownloadResult, String> {
    let url = validate_url(&request.url)?;
    let output_root = PathBuf::from(request.options.download_dir.trim());
    if output_root.as_os_str().is_empty() {
        return Err("请选择下载目录".into());
    }
    fs::create_dir_all(&output_root).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let yt_dlp = find_tool(&app, "yt-dlp.exe").ok_or("下载引擎尚未就绪")?;
    let ffmpeg = find_tool(&app, "ffmpeg.exe").ok_or("媒体处理引擎尚未就绪")?;
    emit_progress(
        &app,
        &request.job_id,
        "downloading",
        0.0,
        "正在读取视频信息",
    );

    if is_douyin_url(&url) {
        let profile = public_edge_profile_dir(&app)?;
        if !public_session_fresh(&profile) {
            emit_progress(
                &app,
                &request.job_id,
                "downloading",
                0.0,
                "正在建立抖音匿名访客会话",
            );
            let edge = find_edge().ok_or("未找到 Windows 自带的 Microsoft Edge")?;
            scan_profile_with_edge(&edge, &profile, &url, 0)?;
        }
    }

    let tiktok_info = if is_tiktok_url(&url) {
        emit_progress(
            &app,
            &request.job_id,
            "downloading",
            0.0,
            "正在解析 TikTok 官方播放器",
        );
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&cache).map_err(|error| format!("无法创建任务缓存目录：{error}"))?;
        Some(prepare_tiktok_info_json(
            &app,
            &url,
            &cache.join(format!("tiktok-{}.json", request.job_id)),
            true,
        )?)
    } else {
        None
    };

    let mut command = Command::new(yt_dlp);
    command
        .arg("--encoding")
        .arg("utf-8")
        .arg("--newline")
        .arg("--no-color")
        .arg("--no-playlist")
        .arg("--continue")
        .arg("--windows-filenames")
        .arg("--trim-filenames")
        .arg("140")
        .arg("--ffmpeg-location")
        .arg(ffmpeg.parent().unwrap_or(Path::new(".")))
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--format")
        .arg(quality_selector(&request.options.quality))
        .arg("--write-info-json")
        .arg("--clean-info-json")
        .arg("--progress-template")
        .arg("download:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .arg("--print")
        .arg("after_move:__YINGLIAN_FILE__%(filepath)s")
        .arg("--paths")
        .arg(&output_root)
        .arg("--output")
        .arg("%(uploader,uploader_id|未知作者)s/%(upload_date>%Y-%m-%d)s_%(title).80B_[%(id)s]/视频.%(ext)s");
    if request.options.include_thumbnail {
        command
            .arg("--write-thumbnail")
            .arg("--convert-thumbnails")
            .arg("jpg");
    }
    if request.options.include_description {
        command.arg("--write-description");
    }
    if request.options.transcript_mode != "none" {
        command
            .arg("--write-subs")
            .arg("--write-auto-subs")
            .arg("--sub-langs")
            .arg("all,-live_chat")
            .arg("--convert-subs")
            .arg("srt");
    }
    if let Some(prepared) = tiktok_info.as_ref() {
        if let Some(cookie_path) = prepared.cookie_path.as_ref() {
            command
                .arg("--impersonate")
                .arg("Edge-101:Windows-10")
                .arg("--cookies")
                .arg(cookie_path)
                .arg("--http-chunk-size")
                .arg("1M");
        } else {
            add_cookie_args(&app, &mut command);
        }
        command.arg("--load-info-json").arg(&prepared.info_path);
    } else {
        add_cookie_args(&app, &mut command);
        command.arg(&url);
    }
    let download = run_streaming(&app, &state, &request.job_id, "downloading", &mut command);
    if let Some(prepared) = tiktok_info {
        let _ = fs::remove_file(prepared.info_path);
        if let Some(path) = prepared.cookie_path {
            let _ = fs::remove_file(path);
        }
    }
    let output = download?;
    let media_file = output
        .output_file
        .or_else(|| {
            tiktok_video_id(&url)
                .and_then(|video_id| find_tiktok_media_file(&output_root, &video_id))
        })
        .ok_or("下载完成但没有找到输出文件")?;
    let job_dir = media_file.parent().ok_or("输出目录无效")?.to_path_buf();
    let (title, platform, native_subtitle) =
        postprocess_metadata(&job_dir, request.options.include_description)?;
    let mut warning = None;
    let mut source_language = if request.options.language == "auto" {
        native_subtitle
            .as_ref()
            .and_then(|path| language_from_subtitle(path))
            .unwrap_or_else(|| "unknown".into())
    } else {
        request.options.language.clone()
    };
    let mut transcript_available = false;

    if request.options.transcript_mode == "native" || request.options.transcript_mode == "auto" {
        if let Some(subtitle) = native_subtitle.as_ref() {
            match strip_subtitle(subtitle) {
                Ok(text) => {
                    fs::write(job_dir.join("字幕文案.txt"), text)
                        .map_err(|error| format!("无法保存字幕文案：{error}"))?;
                    transcript_available = true;
                }
                Err(error) => warning = Some(error),
            }
        } else if request.options.transcript_mode == "native" {
            warning = Some("平台没有提供原生字幕".into());
        }
    }
    let needs_ai = request.options.transcript_mode == "ai"
        || (request.options.transcript_mode == "auto" && native_subtitle.is_none());
    if needs_ai {
        match transcribe(&app, &state, &request, &media_file, &job_dir) {
            Ok(detected) => {
                source_language = detected;
                transcript_available = true;
            }
            Err(error) => warning = Some(format!("视频已下载，AI 文案未生成：{error}")),
        }
    }
    if !request.options.include_video {
        fs::remove_file(&media_file).map_err(|error| format!("无法移除临时视频文件：{error}"))?;
    }
    emit_progress(&app, &request.job_id, "completed", 100.0, "所选内容已保存");
    Ok(DownloadResult {
        output_dir: job_dir.to_string_lossy().into_owned(),
        title,
        platform,
        transcript_available,
        source_language,
        warning,
    })
}

#[tauri::command]
async fn download_item(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    request: DownloadRequest,
) -> Result<DownloadResult, String> {
    let runtime = state.inner().clone();
    let log_app = app.clone();
    let job_id = request.job_id.clone();
    let platform = if is_tiktok_url(&request.url) {
        "tiktok"
    } else if is_douyin_url(&request.url) {
        "douyin"
    } else {
        "other"
    };
    runtime_log(
        &log_app,
        format!("download_start job={job_id} platform={platform}"),
    );
    let result =
        tauri::async_runtime::spawn_blocking(move || execute_download(app, runtime, request))
            .await
            .map_err(|error| error.to_string())?;
    match &result {
        Ok(download) => runtime_log(
            &log_app,
            format!(
                "download_complete job={job_id} platform={} transcript={} language={} warning={} output={}",
                download.platform,
                download.transcript_available,
                download.source_language,
                download.warning.as_deref().unwrap_or("none"),
                download.output_dir
            ),
        ),
        Err(error) => runtime_log(
            &log_app,
            format!("download_failed job={job_id} platform={platform} error={error}"),
        ),
    }
    result
}

#[tauri::command]
fn cancel_job(state: State<'_, RuntimeState>, job_id: String) -> Result<(), String> {
    let process_id = state
        .processes
        .lock()
        .map_err(|_| "任务状态不可用")?
        .get(&job_id)
        .copied()
        .ok_or("任务已经结束")?;
    let mut command = Command::new("taskkill.exe");
    hidden(&mut command)
        .arg("/PID")
        .arg(process_id.to_string())
        .arg("/T")
        .arg("/F");
    command
        .status()
        .map_err(|error| format!("取消任务失败：{error}"))?;
    Ok(())
}

#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
    model_id: String,
) -> Result<(), String> {
    let target = model_path(&app, &model_id)?;
    if target.is_file() {
        return Ok(());
    }
    let spec = model_specs()
        .into_iter()
        .find(|model| model.0 == model_id)
        .ok_or("不支持的模型")?;
    let cancel = state.cancel_model.clone();
    cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let partial = target.with_extension("bin.part");
        let url = format!("{MODEL_BASE_URL}/ggml-{model_id}.bin");
        let mut response = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| error.to_string())?
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("模型下载失败：{error}"))?;
        let total = response.content_length().unwrap_or(spec.2);
        let mut file =
            File::create(&partial).map_err(|error| format!("无法创建模型文件：{error}"))?;
        let mut buffer = vec![0u8; 128 * 1024];
        let mut downloaded = 0u64;
        let mut last_percent = -1i64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = fs::remove_file(&partial);
                return Err("模型下载已取消".into());
            }
            let size = response
                .read(&mut buffer)
                .map_err(|error| format!("模型下载中断：{error}"))?;
            if size == 0 {
                break;
            }
            file.write_all(&buffer[..size])
                .map_err(|error| format!("模型写入失败：{error}"))?;
            downloaded += size as u64;
            let percent = downloaded
                .saturating_mul(100)
                .checked_div(total)
                .unwrap_or(0) as i64;
            if percent != last_percent {
                last_percent = percent;
                let _ = app.emit(
                    "model-progress",
                    ModelProgress {
                        model_id: model_id.clone(),
                        percent: percent as f64,
                        downloaded,
                        total,
                        message: format!("正在下载 {} 模型", spec.1),
                    },
                );
            }
        }
        file.sync_all()
            .map_err(|error| format!("模型保存失败：{error}"))?;
        if downloaded < spec.2.saturating_mul(9) / 10 {
            let _ = fs::remove_file(&partial);
            return Err("模型文件不完整，请重新下载".into());
        }
        fs::rename(&partial, &target).map_err(|error| format!("模型安装失败：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn download_translation_model(
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    if translation_model_installed(&app) {
        return Ok(());
    }
    let root = translation_model_dir(&app)?;
    let cancel = state.cancel_model.clone();
    cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| error.to_string())?;
        let mut completed = TRANSLATION_MODEL_FILES
            .iter()
            .filter_map(|(name, expected)| {
                fs::metadata(root.join(name))
                    .ok()
                    .filter(|item| item.len() >= *expected)
                    .map(|_| *expected)
            })
            .sum::<u64>();

        for (name, expected) in TRANSLATION_MODEL_FILES {
            if cancel.load(Ordering::Relaxed) {
                return Err("模型下载已取消".into());
            }
            let target = root.join(name);
            if fs::metadata(&target)
                .map(|item| item.len() >= expected)
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("无法创建翻译模型目录：{error}"))?;
            }
            let partial = PathBuf::from(format!("{}.part", target.to_string_lossy()));
            let _ = fs::remove_file(&partial);
            let url = format!("{TRANSLATION_BASE_URL}/{name}");
            let mut response = client
                .get(url)
                .send()
                .and_then(reqwest::blocking::Response::error_for_status)
                .map_err(|error| format!("翻译模型下载失败（{name}）：{error}"))?;
            let mut file =
                File::create(&partial).map_err(|error| format!("无法创建翻译模型文件：{error}"))?;
            let mut current = 0u64;
            let mut buffer = vec![0u8; 128 * 1024];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    drop(file);
                    let _ = fs::remove_file(&partial);
                    return Err("模型下载已取消".into());
                }
                let size = response
                    .read(&mut buffer)
                    .map_err(|error| format!("翻译模型下载中断：{error}"))?;
                if size == 0 {
                    break;
                }
                file.write_all(&buffer[..size])
                    .map_err(|error| format!("翻译模型写入失败：{error}"))?;
                current += size as u64;
                let downloaded = completed.saturating_add(current);
                let _ = app.emit(
                    "model-progress",
                    ModelProgress {
                        model_id: "translation".into(),
                        percent: (downloaded.saturating_mul(100) / TRANSLATION_MODEL_BYTES).min(100)
                            as f64,
                        downloaded,
                        total: TRANSLATION_MODEL_BYTES,
                        message: "正在下载中文翻译模型".into(),
                    },
                );
            }
            file.sync_all()
                .map_err(|error| format!("翻译模型保存失败：{error}"))?;
            if current < expected {
                let _ = fs::remove_file(&partial);
                return Err(format!("翻译模型文件不完整：{name}"));
            }
            fs::rename(&partial, &target).map_err(|error| format!("翻译模型安装失败：{error}"))?;
            completed = completed.saturating_add(expected);
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_model_download(state: State<'_, RuntimeState>) {
    state.cancel_model.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn delete_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let path = model_path(&app, &model_id)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| format!("无法删除模型：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_translation_model(app: tauri::AppHandle) -> Result<(), String> {
    let path = translation_model_dir(&app)?;
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("无法删除翻译模型：{error}"))?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let model_root = Arc::new(RwLock::new(model_dir(app.handle())?));
            let model_server_url = start_model_server(model_root.clone())?;
            app.manage(RuntimeState {
                processes: Arc::new(Mutex::new(HashMap::new())),
                cancel_model: Arc::new(AtomicBool::new(false)),
                model_root,
                model_server_url,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            choose_download_dir,
            choose_model_dir,
            open_directory,
            launch_login,
            scan_profile,
            inspect_items,
            download_item,
            cancel_job,
            download_model,
            download_translation_model,
            cancel_model_download,
            delete_model,
            delete_translation_model,
            translation_input,
            save_translation
        ])
        .run(tauri::generate_context!())
        .expect("影链工坊启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_uses_public_metadata() {
        let preview = preview_from_payload(
            "https://www.tiktok.com/@creator/video/1234567890123456789".into(),
            serde_json::json!({
                "title": "测试作品",
                "uploader": "creator",
                "thumbnail": "https://example.com/cover.jpg",
                "duration": 12.5,
                "filesize_approx": 1024_u64
            }),
        );
        assert_eq!(preview.platform, "TikTok");
        assert_eq!(preview.title, "测试作品");
        assert_eq!(preview.uploader, "creator");
        assert_eq!(preview.duration, Some(12.5));
        assert_eq!(preview.size_bytes, Some(1024));
        assert!(preview.error.is_none());
    }

    #[test]
    fn tiktok_media_hosts_are_strictly_limited() {
        assert!(tiktok_media_url(
            "https://v16-webapp-prime.tiktok.com/video/tos/example"
        ));
        assert!(tiktok_media_url(
            "https://v19.tiktokcdn.com/video/tos/example"
        ));
        assert!(tiktok_media_url(
            "https://v16m.tiktokcdn-us.com/video/tos/example"
        ));
        assert!(!tiktok_media_url(
            "https://v16-webapp-prime.tiktok.com.evil.example/video"
        ));
        assert!(!tiktok_media_url(
            "https://www.tiktok.com/@creator/video/1234567890123456789"
        ));
        assert!(!tiktok_media_url(
            "https://www.tiktok.com/aweme/v1/play/?item_id=123&tk=tt_chain_token"
        ));
    }

    #[test]
    fn tiktok_public_fallback_requires_matching_id_and_safe_cdn() {
        let payload = serde_json::json!({
            "code": 0,
            "data": {
                "id": "1234567890123456789",
                "hdplay": "https://v16m.tiktokcdn-us.com/video/tos/example",
                "play": "https://untrusted.example/video.mp4"
            }
        });
        assert_eq!(
            tiktok_media_from_public_fallback(&payload, "1234567890123456789").as_deref(),
            Some("https://v16m.tiktokcdn-us.com/video/tos/example")
        );
        assert!(tiktok_media_from_public_fallback(&payload, "9876543210123456789").is_none());
    }

    #[test]
    fn limited_quality_keeps_portrait_and_best_fallbacks() {
        let selector = quality_selector("480");
        assert!(selector.contains("height<=480"));
        assert!(selector.contains("width<=480"));
        assert!(selector.ends_with("/bv*+ba/b"));
    }
}
