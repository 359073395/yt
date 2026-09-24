//! One local HTTP proxy route shared by extraction, media transfer and live recording.
//! Never changes OS/v2rayN settings and never persists proxy credentials.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config { pub mode: String, pub address: String, pub overseas_only: bool }
impl Default for Config {
    fn default() -> Self { Self { mode: "system".into(), address: "http://127.0.0.1:10808".into(), overseas_only: true } }
}
static CONFIG: std::sync::OnceLock<RwLock<Config>> = std::sync::OnceLock::new();
fn config() -> Config { CONFIG.get_or_init(|| RwLock::new(Config::default())).read().unwrap_or_else(|p| p.into_inner()).clone() }
fn validate_address(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "请输入本机 HTTP 代理，例如 http://127.0.0.1:10808")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || url.port().is_none() || url.port() == Some(0) || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("仅支持本机 HTTP/混合代理端口（不支持 SOCKS 专用端口、账号密码或远程代理）；请查看 v2rayN 的本地监听端口".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
fn validate(mut value: Config) -> Result<Config, String> {
    if !matches!(value.mode.as_str(), "system" | "direct" | "manual") { return Err("代理模式无效".into()); }
    if value.mode == "manual" { value.address = validate_address(&value.address)?; }
    else { value.address = validate_address(&value.address).unwrap_or_else(|_| Config::default().address); }
    Ok(value)
}
fn system_address() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("reg.exe");
        command.args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"]);
        let output = live::capture(&mut command, Duration::from_secs(2), &AtomicBool::new(false)).ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let enabled = text.lines().find(|l| l.split_whitespace().next() == Some("ProxyEnable"))?;
        if enabled.split_whitespace().last() != Some("0x1") { return None; }
        let line = text.lines().find(|l| l.split_whitespace().next() == Some("ProxyServer"))?;
        parse_system_proxy(line.split("REG_SZ").nth(1)?.trim())
    }
    #[cfg(not(target_os = "windows"))]
    { None }
}
fn parse_system_proxy(raw: &str) -> Option<String> {
    let address = if raw.contains('=') {
        raw.split(';').find_map(|v| v.trim().strip_prefix("http="))?
    } else { raw };
    validate_address(&if address.starts_with("http://") { address.into() } else { format!("http://{address}") }).ok()
}
fn domestic(source: &str) -> bool {
    matches!(accounts::platform_for_url(source), Some("douyin" | "bilibili"))
}
fn route(value: &Config, source: &str) -> Option<String> {
    if value.overseas_only && domestic(source) { return None; }
    match value.mode.as_str() { "manual" => validate_address(&value.address).ok(), "system" => system_address(), _ => None }
}
pub fn endpoint(source: &str) -> Option<String> { route(&config(), source) }
pub fn client(source: &str) -> reqwest::blocking::ClientBuilder {
    client_at(endpoint(source).as_deref())
}
pub fn client_at(endpoint: Option<&str>) -> reqwest::blocking::ClientBuilder {
    let builder = reqwest::blocking::Client::builder().no_proxy();
    match endpoint.and_then(|url| reqwest::Proxy::all(url).ok()) { Some(proxy) => builder.proxy(proxy), None => builder }
}
fn clear_env(command: &mut Command) {
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] { command.env_remove(name); }
}
pub fn yt(command: &mut Command, source: &str) {
    clear_env(command);
    command.arg("--proxy").arg(endpoint(source).unwrap_or_default());
}
pub fn ffmpeg(command: &mut Command, endpoint: Option<&str>) {
    clear_env(command);
    if let Some(address) = endpoint {
        command.args(["-http_proxy", address]).env("http_proxy", address).env("https_proxy", address);
    }
}
pub fn browser(command: &mut Command, source: &str) {
    if let Some(address) = endpoint(source) { command.arg(format!("--proxy-server={address}")); }
    else { command.arg("--no-proxy-server"); }
}
#[derive(Serialize, Deserialize)]
struct Snapshot { generation: u64, config: Config }
fn load(root: &Path) -> Result<(Config, u64), String> {
    let mut latest: Option<Snapshot> = None;
    let mut found = false;
    for slot in 0..2 {
        let path = root.join(format!("network.{slot}.json"));
        if !path.exists() { continue; }
        found = true;
        if let Some(snapshot) = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok()) {
            if validate(snapshot.config.clone()).is_ok() && latest.as_ref().map_or(true, |v| snapshot.generation > v.generation) { latest = Some(snapshot); }
        }
    }
    if let Some(snapshot) = latest { return Ok((validate(snapshot.config)?, snapshot.generation)); }
    let legacy = root.join("network.json");
    if legacy.is_file() {
        return Ok((validate(serde_json::from_slice(&fs::read(legacy).map_err(|e| e.to_string())?).map_err(|_| "代理配置格式无效，原配置未覆盖")?)?, 0));
    }
    if found { return Err("代理配置损坏，原文件未覆盖".into()); }
    Ok((Config::default(), 0))
}
fn persist(root: &Path, value: &Config) -> Result<(), String> {
    // Flushed alternating snapshots also work on Windows EFS folders that reject
    // same-directory renames. Never truncate the last known-good snapshot.
    let generation = load(root)?.1.checked_add(1).ok_or("代理配置版本溢出")?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&Snapshot { generation, config: value.clone() }).map_err(|e| e.to_string())?;
    let mut file = File::create(root.join(format!("network.{}.json", generation % 2))).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())
}
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let value = load(&app.path().app_local_data_dir().map_err(|e| e.to_string())?)?.0;
    *CONFIG.get_or_init(|| RwLock::new(Config::default())).write().map_err(|_| "网络配置忙")? = value;
    Ok(())
}
#[tauri::command]
pub async fn network_settings() -> Result<Config, String> { Ok(config()) }
#[tauri::command]
pub async fn save_network_settings(app: tauri::AppHandle, request: Config) -> Result<Config, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = validate(request)?;
        let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let mut current = CONFIG.get_or_init(|| RwLock::new(Config::default())).write().map_err(|_| "网络配置忙")?;
        persist(&root, &value)?;
        *current = value.clone();
        Ok(value)
    }).await.map_err(|_| "网络配置保存任务异常".to_string())?
}
#[tauri::command]
pub async fn detect_local_proxy() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| system_address().ok_or_else(|| "未检测到启用的本机 HTTP 系统代理，请填写 v2rayN 显示的 HTTP/混合端口；不会自动修改系统设置".into())).await.map_err(|_| "读取本机代理失败".to_string())?
}
#[tauri::command]
pub async fn test_network_proxy(request: Config) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = validate(request)?;
        let endpoint = route(&value, "https://www.tiktok.com/");
        let mut builder = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(12));
        if let Some(address) = &endpoint { builder = builder.proxy(reqwest::Proxy::all(address).map_err(|_| "代理地址无效")?); }
        let response = builder.build().map_err(|_| "无法创建网络测试")?.get("https://www.tiktok.com/").header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT).send()
            .map_err(|_| "TikTok 连接失败：请确认 v2rayN 已运行、端口正确，且当前节点能访问 TikTok")?;
        if !response.status().is_success() { return Err(format!("已连接网络，但 TikTok 返回 HTTP {}；这不代表直播可录", response.status().as_u16())); }
        Ok(format!("TikTok 网页可连接（{}）。此测试不等于直播录制成功；保存后对新任务生效。", endpoint.unwrap_or_else(|| "直连".into())))
    }).await.map_err(|_| "代理测试任务异常".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn proxy_config_survives_restart_and_interrupted_write() {
        let root = std::env::temp_dir().join(format!("yinglian-network-test-{}", uuid::Uuid::new_v4()));
        let manual = Config { mode: "manual".into(), ..Config::default() };
        persist(&root, &manual).unwrap();
        assert_eq!(load(&root).unwrap(), (manual.clone(), 1));
        let direct = Config { mode: "direct".into(), ..manual.clone() };
        persist(&root, &direct).unwrap();
        assert_eq!(load(&root).unwrap(), (direct, 2));
        fs::write(root.join("network.0.json"), b"{interrupted").unwrap();
        assert_eq!(load(&root).unwrap(), (manual, 1));
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn accepts_only_loopback_http_ports() {
        assert_eq!(validate_address("http://127.0.0.1:10808/").unwrap(), "http://127.0.0.1:10808");
        for address in ["socks5://127.0.0.1:10808", "http://example.com:8080", "http://127.0.0.1:0", "http://a:b@127.0.0.1:10808", "http://127.0.0.1:10808/path", "http://127.0.0.1:10808?token=secret"] { assert!(validate_address(address).is_err()); }
    }
    #[test] fn system_proxy_and_domestic_routing() {
        assert_eq!(parse_system_proxy("http=127.0.0.1:10808;https=127.0.0.1:10808"), Some("http://127.0.0.1:10808".into()));
        let manual = Config { mode: "manual".into(), ..Config::default() };
        assert!(route(&manual, "https://v.douyin.com/test").is_none());
        assert!(route(&manual, "https://b23.tv/test").is_none());
        assert!(route(&manual, "https://www.tiktok.com/@test/live").is_some());
        assert!(route(&Config { mode: "direct".into(), ..manual }, "https://www.tiktok.com/").is_none());
    }
    #[test] fn ffmpeg_uses_explicit_proxy_and_clears_inherited_routes() {
        let mut command = Command::new("ffmpeg"); ffmpeg(&mut command, Some("http://127.0.0.1:10808"));
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec!["-http_proxy", "http://127.0.0.1:10808"]);
        assert!(command.get_envs().any(|(name,value)| name == "ALL_PROXY" && value.is_none()));
    }
}
