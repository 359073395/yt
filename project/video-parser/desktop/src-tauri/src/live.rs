//! Copy live audio/video without re-encoding. Signed media URLs stay in memory.
use super::*;
use automation::{AutomationState, LiveRequest};
use std::time::Instant;

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard { fn drop(&mut self) {
    if matches!(self.0.try_wait(), Ok(None)) {
        #[cfg(target_os="windows")]
        { let _ = hidden(Command::new("taskkill").args(["/PID", &self.0.id().to_string(), "/T", "/F"])).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
        let _ = self.0.kill();
    }
    let _ = self.0.wait();
} }
fn drain(mut reader: impl Read + Send + 'static, max: usize) -> mpsc::Receiver<Vec<u8>> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = vec![]; let mut buffer = [0u8;8192];
        while let Ok(n) = reader.read(&mut buffer) { if n == 0 { break; } let keep = n.min(max.saturating_sub(bytes.len())); bytes.extend_from_slice(&buffer[..keep]); }
        let _ = send.send(bytes);
    }); receive
}
pub fn capture(command: &mut Command, timeout: Duration, stop: &AtomicBool) -> Result<std::process::Output, String> {
    if stop.load(Ordering::Relaxed) { return Err("已取消连接".into()); }
    let mut child = ChildGuard(hidden(command).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("引擎启动失败：{e}"))?);
    let stdout = drain(child.0.stdout.take().unwrap(),16 * 1024 * 1024);
    let stderr = drain(child.0.stderr.take().unwrap(),64 * 1024);
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? { break status; }
        if stop.load(Ordering::Relaxed) { return Err("已取消连接".into()); }
        if start.elapsed() >= timeout { return Err("平台连接超时，请检查网络或在账号页面重新登录".into()); }
        thread::sleep(Duration::from_millis(100));
    };
    Ok(std::process::Output { status, stdout:stdout.recv_timeout(Duration::from_secs(2)).unwrap_or_default(), stderr:stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default() })
}
fn room_in(value: &Value, depth: usize) -> Option<&Value> {
    if depth > 30 { return None; }
    if value.get("stream_url").is_some() { return Some(value); }
    match value { Value::Object(map) => map.values().find_map(|v| room_in(v,depth+1)), Value::Array(items) => items.iter().find_map(|v| room_in(v,depth+1)), _ => None }
}
fn room_stream(room: &Value) -> Result<String, String> {
    if room.get("status").and_then(Value::as_u64) != Some(2) { return Err("直播间当前未开播".into()); }
    for field in ["flv_pull_url","hls_pull_url_map"] {
        if let Some(map) = room["stream_url"][field].as_object() {
            for quality in ["ORIGIN","FULL_HD1","FULL_HD","HD1","HD","SD1","SD","LD1","LD"] {
                if let Some(url) = map.get(quality).and_then(Value::as_str) { if media_url(url) { return Ok(url.into()); } }
            }
            if let Some(url) = map.values().filter_map(Value::as_str).find(|u| media_url(u)) { return Ok(url.into()); }
        }
    }
    if let Some(url) = room["stream_url"]["hls_pull_url"].as_str().filter(|u| media_url(u)) { return Ok(url.into()); }
    Err("直播间没有可用的公开音视频流；请确认账号权限或稍后重试".into())
}
fn media_url(raw: &str) -> bool { Url::parse(raw).map(|u| matches!(u.scheme(),"https"|"http") && u.host_str().is_some() && u.username().is_empty() && u.password().is_none()).unwrap_or(false) }
fn stream_from_html(html: &str) -> Result<String, String> {
    let pattern = regex::Regex::new(r#"(?s)self\.__pace_f\.push\((.*?)\)\s*;?\s*</script>"#).map_err(|e| e.to_string())?;
    let mut room_error = None;
    for captures in pattern.captures_iter(html) {
        let Ok(payload) = serde_json::from_str::<Value>(&captures[1]) else { continue; };
        let Some(raw) = payload.get(1).and_then(Value::as_str) else { continue; };
        // Flight chunk identifiers are hexadecimal and change between page builds.
        let Some((chunk,json)) = raw.split_once(':') else { continue; };
        if chunk.is_empty() || !chunk.bytes().all(|b| b.is_ascii_hexdigit()) { continue; }
        if let Ok(data) = serde_json::from_str::<Value>(json) {
            if let Some(room) = room_in(&data,0) {
                match room_stream(room) { Ok(stream) => return Ok(stream), Err(error) => room_error = Some(error) }
            }
        }
    }
    Err(room_error.unwrap_or_else(|| "抖音未返回公开直播流；请确认直播间已开播。受登录/风控限制的房间暂不能录制".into()))
}
fn get_text(client: &reqwest::blocking::Client, url: &str) -> Result<String,String> {
    let mut response = client.get(url).header(reqwest::header::USER_AGENT,BROWSER_USER_AGENT).header(reqwest::header::REFERER,"https://live.douyin.com/")
        .send().and_then(reqwest::blocking::Response::error_for_status).map_err(|_| "官方直播页面暂时不可访问；可能需要登录或受网络限制")?.take(8 * 1024 * 1024);
    let mut text = String::new(); response.read_to_string(&mut text).map_err(|_| "直播页面格式无效")?; Ok(text)
}
fn douyin_stream(url: &Url, stop: &AtomicBool, proxy: Option<&str>) -> Result<String,String> {
    let room_id = url.path().trim_matches('/');
    if room_id.is_empty() || !room_id.bytes().all(|b| b.is_ascii_digit()) { return Err("请粘贴 live.douyin.com 后带数字房间号的直播链接".into()); }
    let client = network::client_at(proxy).timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::limited(3)).build().map_err(|e| e.to_string())?;
    let api = format!("https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_source=&is_need_double_stream=false&cookie_enabled=true&web_rid={room_id}");
    if let Ok(text) = get_text(&client,&api) {
        if let Ok(data) = serde_json::from_str::<Value>(&text) {
            if let Some(room) = room_in(&data,0) { return room_stream(room); }
        }
    }
    if stop.load(Ordering::Relaxed) { return Err("已取消连接".into()); }
    let html = get_text(&client,&format!("https://live.douyin.com/{room_id}"))?;
    stream_from_html(&html)
}
fn resolve(app: &tauri::AppHandle, source: &str, stop: &AtomicBool, proxy: Option<&str>) -> Result<(String,String),String> {
    let url = Url::parse(source).map_err(|_| "直播链接无效")?;
    if url.host_str() == Some("live.douyin.com") { return douyin_stream(&url,stop,proxy).map(|u| (u,"https://live.douyin.com/".into())); }
    let engine = find_tool(app,"yt-dlp.exe").ok_or("下载引擎尚未就绪")?;
    let mut command = Command::new(engine);
    // TikTok's HLS can contain untimestamped packets that Matroska cannot copy.
    // Prefer the equivalent official FLV stream, without re-encoding or dropping audio.
    let format = if is_tiktok_url(source) { "best[ext=flv][format_id!=flv-ao]/best[acodec!=none][vcodec!=none]/best" } else { "best[acodec!=none][vcodec!=none]/best" };
    command.args(["--ignore-config","--skip-download","--dump-single-json","--no-playlist","--no-warnings","--socket-timeout","15","--retries","1","--extractor-retries","1","-f",format,source]);
    let _cookies = add_cookie_args(app,&mut command,source);
    // Freeze the route for the whole recording, even if settings change during extraction.
    command.arg("--proxy").arg(proxy.unwrap_or(""));
    let output = capture(&mut command,Duration::from_secs(60),stop)?;
    if !output.status.success() { return Err(format!("直播解析失败：{}", safe_error(&user_error(&String::from_utf8_lossy(&output.stderr))))); }
    let info: Value = serde_json::from_slice(&output.stdout).map_err(|_| "直播数据不完整")?;
    if info["is_live"] != true { return Err("该链接不是正在进行的直播；普通视频请使用视频任务".into()); }
    let stream = info["url"].as_str().filter(|s| media_url(s)).ok_or("该直播没有可用的合并音视频流")?;
    let referer = info["http_headers"]["Referer"].as_str().unwrap_or(source).replace(['\r','\n'],"");
    Ok((stream.into(),referer))
}
pub fn folder_bytes(directory: &Path) -> u64 {
    fs::read_dir(directory).into_iter().flatten().filter_map(Result::ok).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}
fn enough_space(directory: &Path) -> Result<bool,String> {
    #[cfg(target_os="windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let path: Vec<u16> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(path.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok == 0 { return Err("无法检查保存盘剩余空间，未继续录制".into()); }
        Ok(available > 512 * 1024 * 1024)
    }
    #[cfg(not(target_os="windows"))]
    { let _ = directory; Ok(true) }
}
fn recorder_command(ffmpeg: &Path, stream: &str, referer: &str, output: &Path, proxy: Option<&str>) -> Command {
    let mut cmd = Command::new(ffmpeg);
    network::ffmpeg(&mut cmd, proxy);
    hidden(&mut cmd).args(["-hide_banner","-loglevel","error","-fflags","+genpts+discardcorrupt","-rw_timeout","15000000","-user_agent",BROWSER_USER_AGENT]);
    if !referer.is_empty() { cmd.args(["-headers", &format!("Referer: {}\r\n",referer.replace(['\r','\n'],""))]); }
    cmd.args(["-i",stream,"-map","0:v?","-map","0:a?","-c","copy","-avoid_negative_ts","make_zero","-f","segment","-segment_time","600","-reset_timestamps","1","-segment_format","matroska"])
        .arg(output.join("直播_%04d.mkv")).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()); cmd
}
pub fn record(app: &tauri::AppHandle, id: &str, request: &LiveRequest, output: &Path, stop: &AtomicBool) -> Result<(),String> {
    if !enough_space(output)? { return Err("保存盘剩余空间不足 512 MB，未开始录制".into()); }
    let proxy = network::endpoint(&request.url);
    let (stream,referer) = resolve(app,&request.url,stop,proxy.as_deref())?;
    if stop.load(Ordering::Relaxed) { return Err("已取消连接".into()); }
    let ffmpeg = find_tool(app,"ffmpeg.exe").ok_or("FFmpeg 尚未就绪")?;
    let state = app.state::<AutomationState>();
    runtime_log(app, format!("live_start job={id} proxy={}", proxy.is_some()));
    run_recorder(recorder_command(&ffmpeg,&stream,&referer,output,proxy.as_deref()),output,stop,Duration::from_secs(request.minutes*60),request.max_gb*1024*1024*1024, |status,detail,elapsed,bytes| {
        if matches!(status, "failed" | "partial" | "completed") { runtime_log(app, format!("live_end job={id} status={status} bytes={bytes} detail={}", safe_error(detail))); }
        state.update_record(id,status,detail,elapsed,bytes)
    })
}
pub fn safe_error(raw: &str) -> String {
    static URLS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let urls = URLS.get_or_init(|| regex::Regex::new(r#"https?://[^\s<>\"']+"#).expect("static URL pattern"));
    raw.lines().filter(|line| { let low=line.to_ascii_lowercase(); !low.contains("cookie:") && !low.contains("authorization:") })
        .map(|line| urls.replace_all(line, "[媒体地址]").into_owned()).collect::<Vec<_>>().join(" ").chars().take(600).collect()
}
fn failed_detail(raw: &str, bytes: u64) -> String {
    let lower = raw.to_ascii_lowercase();
    let cause = if lower.contains("10054") || lower.contains("handshake") { "直播连接被重置/TLS 握手失败；请在“账号 → 网络代理”选择本机代理，并确认 v2rayN 节点可访问 TikTok" }
        else if lower.contains("403") || lower.contains("401") { "直播源拒绝访问；可能是地区、账号权限或签名失效，代理连通不代表有直播访问权限" }
        else if lower.contains("timed out") || lower.contains("timeout") { "直播连接超时；请检查代理端口、节点和直播间是否仍在开播" }
        else { "直播源中断或录制引擎失败" };
    let files = if bytes > 0 { "已写入分段保留，可打开文件夹检查" } else { "未生成录制文件（0 字节）" };
    let detail = safe_error(raw);
    format!("{cause}；{files}{}", if detail.is_empty() { String::new() } else { format!("。引擎：{detail}") })
}
fn run_recorder(mut command: Command, output: &Path, stop: &AtomicBool, duration: Duration, max_bytes: u64,
    mut update: impl FnMut(&str,&str,u64,u64)->Result<(),String>) -> Result<(),String> {
    let mut child = ChildGuard(command.spawn().map_err(|e| format!("录制引擎启动失败：{e}"))?);
    let errors = drain(child.0.stderr.take().ok_or("录制日志管道未就绪")?, 16*1024);
    let start = Instant::now(); let mut last_update = Instant::now()-Duration::from_secs(5);
    let mut last_disk_check = Instant::now()-Duration::from_secs(5);
    let mut last_bytes = 0; let mut last_data = Instant::now(); let mut stopping: Option<Instant> = None;
    let mut reason = String::new(); let mut stalled = false;
    loop {
        let elapsed = start.elapsed().as_secs(); let bytes = folder_bytes(output);
        if bytes > last_bytes { last_data = Instant::now(); last_bytes = bytes; }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            let normal = status.success() && bytes > 0 && !stalled;
            let error = errors.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
            let detail = if !reason.is_empty() { reason.clone() } else if normal { "直播结束，分段已保存".into() } else { failed_detail(&String::from_utf8_lossy(&error), bytes) };
            return update(if normal { "completed" } else if bytes > 0 { "partial" } else { "failed" }, &detail,elapsed,bytes);
        }
        if stopping.is_none() {
            let disk_low = if last_disk_check.elapsed() >= Duration::from_secs(5) { last_disk_check = Instant::now(); !enough_space(output)? } else { false };
            stalled = last_data.elapsed() > Duration::from_secs(45);
            reason = if stop.load(Ordering::Relaxed) { "已停止录制，已有分段保留".into() }
                else if start.elapsed() >= duration { "已达到录制时长上限".into() }
                else if bytes >= max_bytes { "已达到录制容量上限".into() }
                else if stalled { "45 秒未收到直播数据，已停止；请检查网络后重试".into() }
                else if disk_low { "剩余空间不足 512 MB，已停止".into() } else { String::new() };
            if !reason.is_empty() {
                if let Some(mut input) = child.0.stdin.take() { let _ = input.write_all(b"q\n"); }
                stopping = Some(Instant::now());
            }
        }
        if stopping.map(|t| t.elapsed() >= Duration::from_secs(5)).unwrap_or(false) {
            let _ = child.0.kill(); let _ = child.0.wait();
            return update(if bytes > 0 { "partial" } else { "cancelled" },"录制已强制停止，已有分段保留待检查",elapsed,folder_bytes(output));
        }
        if last_update.elapsed() >= Duration::from_secs(2) {
            update(if stopping.is_some() { "stopping" } else { "recording" }, if stopping.is_some() { &reason } else { "正在录制 · 每 10 分钟保存一段 MKV" },elapsed,bytes)?;
            last_update = Instant::now();
        }
        thread::sleep(Duration::from_millis(200));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn failure_preserves_cause_without_leaking_signed_urls() {
        let detail = failed_detail("[tls] Failed to read handshake response\nError -10054 https://cdn.example/live?token=secret\nCookie: secret", 0);
        assert!(detail.contains("TLS")); assert!(detail.contains("0 字节"));
        assert!(!detail.contains("secret")); assert!(!detail.contains("已有分段"));
        assert!(failed_detail("HTTP 403", 1000).contains("分段保留"));
    }
    #[test]
    fn live_stream_status_quality_and_protocol_validation() {
        let room = serde_json::json!({"status":2,"stream_url":{"flv_pull_url":{"SD":"https://cdn.example/sd.flv","ORIGIN":"https://cdn.example/best.flv"}}});
        assert_eq!(room_stream(&room).unwrap(),"https://cdn.example/best.flv");
        assert!(room_stream(&serde_json::json!({"status":4,"stream_url":{}})).is_err());
        assert!(!media_url("file:///c:/secret")); assert!(!media_url("https://user:pass@example.com"));
        let json=serde_json::json!({"a":[{"room":room}]}).to_string();
        let html=format!("<script>self.__pace_f.push({});</script>",serde_json::json!([1,format!("d:{json}")]));
        assert_eq!(stream_from_html(&html).unwrap(),"https://cdn.example/best.flv");
    }
    #[test]
    fn bounded_process_times_out_and_can_be_cancelled() {
        let mut command=Command::new("cmd.exe"); command.args(["/c","ping -n 6 127.0.0.1 >nul"]);
        assert!(capture(&mut command,Duration::from_millis(200),&AtomicBool::new(false)).unwrap_err().contains("超时"));
        assert!(capture(&mut command,Duration::from_secs(1),&AtomicBool::new(true)).unwrap_err().contains("取消"));
    }
    #[test]
    fn real_ffmpeg_records_and_stops_without_losing_file() {
        let ffmpeg=Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bin/ffmpeg.exe");
        assert!(ffmpeg.exists(),"本地录制验收需要打包用的 FFmpeg");
        let root=std::env::temp_dir().join(format!("live-smoke-{}",uuid::Uuid::new_v4())); fs::create_dir(&root).unwrap();
        let mut cmd=Command::new(&ffmpeg);
        hidden(&mut cmd).args(["-hide_banner","-loglevel","error","-re","-f","lavfi","-i","testsrc=size=160x120:rate=10","-c:v","mpeg4","-f","segment","-segment_time","1","-reset_timestamps","1"])
            .arg(root.join("test_%04d.mkv")).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut final_status=String::new();
        run_recorder(cmd,&root,&AtomicBool::new(false),Duration::from_secs(3),100*1024*1024,|status,_,_,_| { final_status=status.into(); Ok(()) }).unwrap();
        assert_eq!(final_status,"completed"); assert!(folder_bytes(&root)>1000);
        let probe=Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/bin/ffprobe.exe");
        for entry in fs::read_dir(&root).unwrap() { let path=entry.unwrap().path(); let result=hidden(Command::new(&probe).args(["-v","error","-show_entries","format=duration"]).arg(&path)).output().unwrap(); assert!(result.status.success()); fs::remove_file(path).unwrap(); }
        fs::remove_dir(root).unwrap();
    }
}
