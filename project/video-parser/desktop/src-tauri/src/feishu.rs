//! Minimal native Feishu transport. Wire schema and heartbeat behavior follow
//! https://github.com/larksuite/oapi-sdk-python/tree/v2_main/lark_oapi/ws
//! No Node/Python runtime, callback server, or shared company application required.
use super::*;
use prost::Message as ProtoMessage;
use regex::Regex;
use std::{
    net::{TcpStream, ToSocketAddrs},
    sync::OnceLock,
    time::Instant,
};
use uuid::Uuid;

const ORIGIN: &str = "https://open.feishu.cn";
#[cfg(test)]
#[path = "feishu_tests.rs"]
mod tests;
const MAX_BYTES: usize = 4 * 1024 * 1024;

// Synthetic Feishu input, real downloader/ASR/translation. No bot credentials or
// messages sent to Feishu. Kept out of production binaries.
#[cfg(feature = "team-smoke")]
pub(super) fn seed_smoke(state: &TeamState) -> Result<(), String> {
    let mut d = state.data.lock().unwrap();
    if d.config.app_id.is_empty() {
        d.config = Config {
            app_id: "cli_native_fixture".into(),
            owner: "ou_fixture".into(),
            chat_id: "oc_fixture".into(),
            root: "F:/820/yinglian-personal-qa/downloads".into(),
            enabled: true,
            copy: true,
            provider: "api".into(),
            model_id: "small".into(),
            session: json!({"device_id":"native-fixture","user_name":"测试账号","device_name":"原生验收"}),
            ..Default::default()
        };
        state.save(&d)?;
    }
    if d.config.app_id != "cli_native_fixture"
        || !d.config.proof.is_empty()
        || !d.config.root.contains("yinglian-personal-qa")
    {
        return Err("拒绝使用非隔离测试配置".into());
    }
    drop(d);
    let e = json!({"sender":{"sender_type":"user","sender_id":{"open_id":"ou_fixture"}},
        "message":{"message_id":"native-fixture-1","chat_id":"oc_fixture","chat_type":"p2p","message_type":"text",
            "content":json!({"text":"分类：美妆/口播参考\n备注：印尼语带货测试\nhttps://www.tiktok.com/@cisun_/video/7678218577157115156"}).to_string()}});
    ingest(state, "cli_native_fixture", &e)?;
    ingest(state, "cli_native_fixture", &e)?;
    Ok(())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Notice {
    device: String,
    text: String,
    uuid: String,
    #[serde(default)]
    sent: bool,
}
#[derive(Clone)]
pub(super) struct Pairing {
    code: String,
    expires: u64,
    pending: Option<(String, String)>,
}
pub(super) fn pair_status(state: &TeamState) -> Value {
    state
        .pair
        .lock()
        .unwrap()
        .as_ref()
        .map_or(Value::Null, |p| {
            json!({
                "code":p.code,"expires":p.expires,"expired":p.expires <= now(),
                "pending_owner":p.pending.as_ref().map(|v|v.0.clone())
            })
        })
}
pub(super) fn ensure_idle(state: &TeamState, data: &Journal) -> Result<(), String> {
    if state.active.load(Ordering::SeqCst)
        || state.writing.load(Ordering::SeqCst)
        || data
            .jobs
            .values()
            .any(|j| matches!(j.stage.as_str(), "preparing" | "text_ready"))
    {
        return Err("请等待下载和文案处理结束再更换或解除配对".into());
    }
    Ok(())
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建飞书连接".into())
}
fn response(res: reqwest::blocking::Response) -> Result<Value, String> {
    let status = res.status();
    let mut bytes = Vec::new();
    res.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "飞书响应读取失败")?;
    if bytes.len() > MAX_BYTES {
        return Err("飞书响应过大".into());
    }
    if !status.is_success() {
        return Err(format!(
            "飞书请求失败（HTTP {}），请检查网络与应用权限",
            status.as_u16()
        ));
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "飞书响应格式异常")?;
    if v["code"].as_i64() != Some(0) {
        return Err(format!(
            "飞书接口错误 {}；请检查 App ID、Secret、权限及应用发布状态",
            v["code"].as_i64().unwrap_or(-1)
        ));
    }
    Ok(v)
}
fn token(c: &Config) -> Result<String, String> {
    let secret = unprotect_secret(&c.proof)?;
    let res = client()?
        .post(format!(
            "{ORIGIN}/open-apis/auth/v3/tenant_access_token/internal"
        ))
        .header("Content-Type", "application/json")
        .body(json!({"app_id":c.app_id,"app_secret":secret}).to_string())
        .send()
        .map_err(|_| "无法连接飞书，请检查网络")?;
    response(res)?["tenant_access_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or("飞书未返回应用凭证".into())
}
fn api(method: &str, path: &str, token: &str, body: Value) -> Result<Value, String> {
    let mut request = client()?
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            format!("{ORIGIN}{path}"),
        )
        .bearer_auth(token);
    if method != "GET" {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_string());
    }
    response(request.send().map_err(|_| "飞书请求未完成，请检查网络")?)
}
pub(super) fn confirm_pair(state: &TeamState) -> Result<(), String> {
    let mut data = state.data.lock().unwrap();
    let mut pair = state.pair.lock().unwrap();
    let p = pair
        .as_ref()
        .filter(|p| p.expires > now())
        .ok_or("配对码已过期，请重新连接机器人")?;
    let (owner, chat) = p.pending.as_ref().ok_or("请先在飞书向机器人发送配对码")?;
    let mut next = data.clone();
    next.config.owner = owner.clone();
    next.config.chat_id = chat.clone();
    next.config.onboarding = false;
    next.config.history_until = now();
    next.config.bound_at = next.config.history_until;
    next.config.session = json!({"device_id":Uuid::new_v4().to_string(),"user_name":format!("飞书账号 · {}", &owner[owner.len().saturating_sub(8)..]),"device_name":next.config.device_name});
    notice(&mut next, "paired", "配对成功。请回电脑确认保存位置并开启自动下载。以后可发送：\n分类：美妆/口播参考\n备注：开头很好\n视频链接".into());
    state.save(&next)?;
    *data = next;
    *pair = None;
    Ok(())
}

pub(super) fn renew_pair(state: &TeamState) -> Result<(), String> {
    let d = state.data.lock().unwrap();
    if d.config.proof.is_empty() || !d.config.owner.is_empty() {
        return Err("请先连接尚未配对的机器人".into());
    }
    *state.pair.lock().unwrap() = Some(Pairing {
        code: Uuid::new_v4().simple().to_string()[..12].to_uppercase(),
        expires: now() + 600_000,
        pending: None,
    });
    Ok(())
}
fn notice(data: &mut Journal, key: &str, text: String) {
    let device = data.config.session["device_id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    data.notices
        .entry(format!("{device}:{key}"))
        .or_insert_with(|| Notice {
            device,
            text,
            uuid: Uuid::new_v4().simple().to_string(),
            sent: false,
        });
}

#[derive(Debug, PartialEq)]
struct SharedVideo {
    url: String,
    key: String,
}
fn url_regex() -> &'static Regex {
    static URL: OnceLock<Regex> = OnceLock::new();
    URL.get_or_init(|| Regex::new(r#"https?://[^\s<>\"'，。！？、；：）】}\]\)]+"#).unwrap())
}
fn media_urls(text: &str) -> Result<Vec<SharedVideo>, String> {
    let allowed = [
        "tiktok.com",
        "douyin.com",
        "youtube.com",
        "youtu.be",
        "bilibili.com",
        "b23.tv",
        "instagram.com",
        "facebook.com",
        "fb.watch",
        "twitter.com",
        "x.com",
    ];
    let mut found = BTreeMap::new();
    for part in url_regex().find_iter(text) {
        let raw = part.as_str().trim_end_matches(['.', ',', ';', '!', '?']);
        let Ok(mut u) = Url::parse(raw) else { continue };
        let host = u.host_str().unwrap_or("").to_owned();
        if !u.username().is_empty()
            || u.password().is_some()
            || u.port().is_some_and(|p| p != 443)
            || !allowed
                .iter()
                .any(|h| host == *h || host.ends_with(&format!(".{h}")))
        {
            continue;
        }
        let _ = u.set_scheme("https");
        u.set_fragment(None);
        let parts: Vec<_> = u.path().split('/').filter(|v| !v.is_empty()).collect();
        let id = parts
            .windows(2)
            .find(|p| matches!(p[0], "video" | "photo"))
            .map(|p| p[1]);
        let key = if host.ends_with("tiktok.com") && id.is_some() {
            format!("tiktok:{}", id.unwrap())
        } else if host.ends_with("douyin.com") && id.is_some() {
            format!("douyin:{}", id.unwrap())
        } else if host == "youtu.be" {
            format!("youtube:{}", parts.first().unwrap_or(&""))
        } else if host.ends_with("youtube.com") && u.query_pairs().any(|(k, _)| k == "v") {
            format!(
                "youtube:{}",
                u.query_pairs().find(|(k, _)| k == "v").unwrap().1
            )
        } else if host.ends_with("youtube.com")
            && parts.len() >= 2
            && matches!(parts[0], "shorts" | "embed")
        {
            format!("youtube:{}", parts[1])
        } else {
            let pairs: Vec<(String, String)> = u
                .query_pairs()
                .filter(|(k, _)| {
                    !k.starts_with("utm_")
                        && !k.starts_with("share_")
                        && !matches!(
                            k.as_ref(),
                            "si" | "fbclid" | "is_from_webapp" | "sender_device"
                        )
                })
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            u.set_query(None);
            if !pairs.is_empty() {
                u.query_pairs_mut().extend_pairs(pairs);
            }
            u.to_string()
        };
        found.entry(key.clone()).or_insert(SharedVideo {
            url: u.to_string(),
            key,
        });
    }
    if found.len() > 50 {
        return Err("一条消息最多收集 50 个视频，请分开发送".into());
    }
    Ok(found.into_values().collect())
}
#[derive(Default)]
struct MessageMetadata {
    category: Option<String>,
    note: Option<String>,
}
fn parse_metadata(text: &str) -> Result<MessageMetadata, String> {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    // Accept natural Chinese input (including share text followed by 分类 测试).
    // Keep labels explicit: never turn a platform hashtag or video title into a folder.
    let labels = LABEL.get_or_init(|| Regex::new(r"(?:^|[\s,，;；])(分类|备注)(?:[ \t]*[:：=][ \t]*|[ \t]+)").unwrap());
    let stripped = url_regex().replace_all(text, "");
    let captures: Vec<_> = labels.captures_iter(&stripped).collect();
    let mut meta = MessageMetadata::default();
    for (i, c) in captures.iter().enumerate() {
        let end = captures
            .get(i + 1)
            .map_or(stripped.len(), |c| c.get(0).unwrap().start());
        let value = stripped[c.get(0).unwrap().end()..end]
            .lines()
            .next()
            .unwrap_or("")
            .trim();
        if &c[1] == "分类" {
            let category = value.trim_matches([' ', '，', ',', ';', '；']).replace('\\', "/");
            meta.category = Some(safe_category(&category)?);
        } else {
            meta.note = Some(value.chars().take(1000).collect());
        }
    }
    Ok(meta)
}
impl MessageMetadata {
    fn new_category(&self) -> String {
        self.category.clone().or_else(|| self.note.as_ref().filter(|note| safe_category(note).is_ok()).cloned())
            .unwrap_or_else(|| "待分类".into())
    }
    fn apply(&self, job: &mut LocalJob) {
        if let Some(category) = &self.category { job.remote["category"] = json!(category); }
        if let Some(note) = &self.note { job.remote["note"] = json!(note); }
    }
    fn is_explicit(&self) -> bool { self.category.is_some() || self.note.is_some() }
}
#[cfg(test)]
fn metadata(text: &str) -> Result<(String, String), String> {
    let meta = parse_metadata(text)?;
    Ok((meta.new_category(), meta.note.unwrap_or_default()))
}
fn message_text(msg: &Value) -> Option<String> {
    let content: Value = serde_json::from_str(msg["content"].as_str()?).ok()?;
    match msg["message_type"].as_str()? {
        "text" => content["text"].as_str().map(str::to_owned),
        "post" => {
            let post = if content["content"].is_array() {
                &content
            } else {
                content
                    .as_object()?
                    .values()
                    .find(|v| v["content"].is_array())?
            };
            let mut lines = vec![post["title"].as_str().unwrap_or("").to_string()];
            for row in post["content"].as_array()? {
                let mut line = String::new();
                for node in row.as_array()? {
                    line.push_str(node["text"].as_str().unwrap_or(""));
                    if node["tag"] == "a" {
                        line.push(' ');
                        line.push_str(node["href"].as_str().unwrap_or(""));
                        line.push(' ');
                    }
                }
                lines.push(line);
            }
            Some(lines.join("\n"))
        }
        _ => None,
    }
}

// The only write path for pushed and history events: identity checks, dedupe, and
// queue insertion are committed together BEFORE acknowledging a WebSocket event.
pub(super) fn ingest(state: &TeamState, app_id: &str, event: &Value) -> Result<(), String> {
    let msg = &event["message"];
    let sender = &event["sender"];
    if sender["sender_type"] != "user" || msg["chat_type"] != "p2p" {
        return Ok(());
    }
    let owner = sender["sender_id"]["open_id"].as_str().unwrap_or("");
    let chat = msg["chat_id"].as_str().unwrap_or("");
    let id = msg["message_id"].as_str().unwrap_or("");
    if !owner.starts_with("ou_") || !owner.is_ascii() || chat.is_empty() || id.is_empty() {
        return Ok(());
    }
    let Some(text) = message_text(msg).filter(|s| s.len() <= 128 * 1024) else {
        return Ok(());
    };
    let mut data = state.data.lock().unwrap();
    if data.config.app_id != app_id {
        return Ok(());
    }
    if data.config.owner.is_empty() {
        let mut pairing = state.pair.lock().unwrap();
        if let Some(p) = pairing.as_mut().filter(|p| p.expires > now()) {
            if text
                .trim()
                .strip_prefix("配对")
                .map(str::trim)
                .is_some_and(|s| s.eq_ignore_ascii_case(&p.code))
                && p.pending.is_none()
            {
                p.pending = Some((owner.into(), chat.into()));
            }
        }
        return Ok(());
    }
    if owner != data.config.owner
        || (!data.config.chat_id.is_empty() && chat != data.config.chat_id)
    {
        return Ok(());
    }
    let created = msg["create_time"]
        .as_str()
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| msg["create_time"].as_u64());
    if data.config.bound_at > 0 && created.is_none_or(|v| v < data.config.bound_at) {
        return Ok(());
    }
    // The owner came from the official authorization response, never from the
    // first arbitrary sender. A real inbound message proves receiving works.
    if data.config.onboarding {
        if !chat.starts_with("oc_") {
            return Ok(());
        }
        let mut next = data.clone();
        next.config.chat_id = chat.into();
        next.config.onboarding = false;
        notice(
            &mut next,
            "paired",
            "收件验证成功。请回电脑选择保存位置并开启自动下载。".into(),
        );
        state.save(&next)?;
        *data = next;
    } else if data.config.chat_id.is_empty() {
        return Ok(());
    }
    let device = data.config.session["device_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let key = format!("{device}:{id}");
    if data.messages.contains_key(&key) {
        return Ok(());
    }
    let mut next = data.clone();
    let parsed = media_urls(&text).and_then(|urls| parse_metadata(&text).map(|meta| (urls, meta)));
    let mut ids = Vec::new();
    match parsed {
        Err(e) => notice(&mut next, id, e),
        Ok((urls, meta)) => {
            let category = meta.new_category();
            let note = meta.note.clone().unwrap_or_default();
            let mut added = 0;
            let mut updated = false;
            if urls.is_empty() && meta.is_explicit() {
                let parent = msg["parent_id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| msg["root_id"].as_str())
                    .unwrap_or("");
                if let Some(previous) = next.messages.get(&format!("{device}:{parent}")).cloned() {
                    for job_id in previous {
                        if let Some(job) =
                            next.jobs.get_mut(&job_id).filter(|j| j.device_id == device)
                        {
                            meta.apply(job);
                            ids.push(job_id);
                            updated = true;
                        }
                    }
                }
            }
            for video in urls {
                if let Some(job) = next
                    .jobs
                    .values_mut()
                    .find(|j| j.device_id == device && j.remote["media_key"] == video.key)
                {
                    if meta.is_explicit() { meta.apply(job); updated = true; }
                    ids.push(job.id.clone());
                    continue;
                }
                let job_id = Uuid::new_v4().to_string();
                let mut options = next.config.clone();
                options.proof.clear();
                options.owner.clear();
                options.chat_id.clear();
                options.session = Value::Null;
                next.jobs.insert(job_id.clone(), LocalJob { id: job_id.clone(), device_id: device.clone(),
                    remote: json!({"id":job_id,"url":video.url,"media_key":video.key,"category":category,"note":note,"created":now(),"message_id":id}),
                    root: String::new(), category: category.clone(), stage: "queued".into(), detail: "链接已收录，等待本机下载".into(),
                    lease: String::new(), result: None, options, move_to: None });
                ids.push(job_id);
                added += 1;
            }
            let actual_categories: std::collections::BTreeSet<_> = ids.iter()
                .filter_map(|id| next.jobs.get(id))
                .map(|job| job.remote["category"].as_str().unwrap_or(&job.category).to_owned()).collect();
            let folders = actual_categories.into_iter().collect::<Vec<_>>().join("、");
            let reply = if updated {
                format!(
                    "已收录 {added} 条新视频，已同步 {} 条记录。分类：{folders}。已有视频不会重复下载，电脑将在任务处理完成后归档。",
                    ids.len()
                )
            } else if !ids.is_empty() {
                format!(
                    "已收录 {added} 条视频，重复 {} 条。分类：{folders}。{}",
                    ids.len() - added,
                    if next.config.enabled {
                        "本机将自动下载。"
                    } else {
                        "请在电脑开启自动下载。"
                    }
                )
            } else {
                "请发送视频链接或分享文案，末尾加“分类 测试”即可自动归档（也支持“分类：测试”）。补分类请回复原链接消息，或把链接带分类再发一次。每条消息最多 50 个链接。".into()
            };
            notice(&mut next, id, reply);
        }
    }
    next.messages.insert(key, ids);
    state.save(&next)?;
    *data = next;
    Ok(())
}

#[derive(Clone, PartialEq, prost::Message)]
struct Header {
    #[prost(string, required, tag = "1")]
    key: String,
    #[prost(string, required, tag = "2")]
    value: String,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Frame {
    #[prost(uint64, required, tag = "1")]
    seq_id: u64,
    #[prost(uint64, required, tag = "2")]
    log_id: u64,
    #[prost(int32, required, tag = "3")]
    service: i32,
    #[prost(int32, required, tag = "4")]
    method: i32,
    #[prost(message, repeated, tag = "5")]
    headers: Vec<Header>,
    #[prost(string, optional, tag = "6")]
    payload_encoding: Option<String>,
    #[prost(string, optional, tag = "7")]
    payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = "8")]
    payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "9")]
    log_id_new: Option<String>,
}
impl Frame {
    fn header(&self, key: &str) -> &str {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map_or("", |h| &h.value)
    }
}
struct Parts {
    at: Instant,
    parts: Vec<Option<Vec<u8>>>,
}
#[derive(Default)]
struct Assembler {
    pending: HashMap<String, Parts>,
}
impl Assembler {
    fn payload(&mut self, f: &Frame) -> Result<Option<Vec<u8>>, String> {
        self.pending
            .retain(|_, v| v.at.elapsed() < Duration::from_secs(5));
        let sum = f.header("sum").parse::<usize>().unwrap_or(1);
        let seq = f.header("seq").parse::<usize>().unwrap_or(0);
        let bytes = f.payload.clone().unwrap_or_default();
        if sum == 0 || sum > 64 || seq >= sum || bytes.len() > MAX_BYTES {
            return Err("飞书消息分片无效".into());
        }
        if sum == 1 {
            return Ok(Some(bytes));
        }
        let id = f.header("message_id").to_string();
        if id.is_empty() || (!self.pending.contains_key(&id) && self.pending.len() >= 32) {
            return Err("飞书消息分片过多".into());
        }
        let parts = self.pending.entry(id.clone()).or_insert_with(|| Parts {
            at: Instant::now(),
            parts: vec![None; sum],
        });
        if parts.parts.len() != sum {
            return Err("飞书分片数量不一致".into());
        }
        parts.parts[seq] = Some(bytes);
        if parts.parts.iter().flatten().map(Vec::len).sum::<usize>() > MAX_BYTES {
            self.pending.remove(&id);
            return Err("飞书消息过大".into());
        }
        if parts.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        Ok(Some(
            self.pending
                .remove(&id)
                .unwrap()
                .parts
                .into_iter()
                .flatten()
                .flatten()
                .collect(),
        ))
    }
}
fn endpoint(c: &Config) -> Result<(Url, u64), String> {
    let res = client()?
        .post(format!("{ORIGIN}/callback/ws/endpoint"))
        .header("Content-Type", "application/json")
        .body(json!({"AppID":c.app_id,"AppSecret":unprotect_secret(&c.proof)?}).to_string())
        .send()
        .map_err(|_| "无法建立飞书长连接，请检查网络")?;
    let v = response(res)?;
    let u = Url::parse(v["data"]["URL"].as_str().ok_or("飞书未返回长连接地址")?)
        .map_err(|_| "飞书长连接地址无效")?;
    if u.scheme() != "wss"
        || !u
            .host_str()
            .is_some_and(|h| h == "feishu.cn" || h.ends_with(".feishu.cn"))
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("拒绝非飞书加密长连接地址".into());
    }
    Ok((
        u,
        v["data"]["ClientConfig"]["PingInterval"]
            .as_u64()
            .unwrap_or(120)
            .clamp(5, 300),
    ))
}
fn connect_ws(u: &Url) -> Result<tungstenite::WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let address = (
        u.host_str().ok_or("飞书连接地址无效")?,
        u.port_or_known_default().unwrap_or(443),
    );
    let addresses = address.to_socket_addrs().map_err(|_| "飞书域名解析失败")?;
    let mut socket = None;
    for addr in addresses.take(4) {
        if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
            socket = Some(s);
            break;
        }
    }
    let socket = socket.ok_or("连接飞书超时，请检查网络")?;
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "无法配置连接超时")?;
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "无法配置连接超时")?;
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_BYTES))
        .max_frame_size(Some(MAX_BYTES));
    tungstenite::client_tls_with_config(u.as_str(), socket, Some(config), None)
        .map(|v| v.0)
        .map_err(|_| "飞书长连接握手失败；请检查网络、应用发布状态及长连接订阅设置".into())
}
fn configured(state: &TeamState, c: &Config) -> bool {
    let d = state.data.lock().unwrap();
    d.config.app_id == c.app_id
        && d.config.proof == c.proof
        && !c.proof.is_empty()
        && (!d.config.owner.is_empty()
            || state
                .pair
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|p| p.expires > now()))
}
fn receive_ws(state: &TeamState, c: &Config) -> Result<(), String> {
    let (u, mut interval) = endpoint(c)?;
    let service = u
        .query_pairs()
        .find(|(k, _)| k == "service_id")
        .and_then(|(_, v)| v.parse::<i32>().ok())
        .ok_or("飞书未返回服务编号")?;
    let mut ws = connect_ws(&u)?;
    *state.connection.lock().unwrap() = "已连接飞书".into();
    let mut last_ping = Instant::now() - Duration::from_secs(interval);
    let mut last_received = Instant::now();
    let mut assembler = Assembler::default();
    while configured(state, c) {
        if last_received.elapsed() > Duration::from_secs(interval * 3) {
            return Err("飞书心跳超时，正在重新连接".into());
        }
        if last_ping.elapsed() >= Duration::from_secs(interval) {
            let f = Frame {
                service,
                headers: vec![Header {
                    key: "type".into(),
                    value: "ping".into(),
                }],
                ..Default::default()
            };
            ws.send(Message::Binary(f.encode_to_vec().into()))
                .map_err(|_| "飞书心跳发送失败")?;
            last_ping = Instant::now();
        }
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                last_received = Instant::now();
                let mut frame = Frame::decode(bytes.as_ref()).map_err(|_| "飞书消息帧格式异常")?;
                if frame.method == 0 {
                    if frame.header("type") == "pong" {
                        if let Ok(v) = serde_json::from_slice::<Value>(
                            frame.payload.as_deref().unwrap_or_default(),
                        ) {
                            interval = v["PingInterval"].as_u64().unwrap_or(interval).clamp(5, 300);
                        }
                    }
                    continue;
                }
                if frame.method != 1 || frame.header("type") != "event" {
                    continue;
                }
                let Some(payload) = assembler.payload(&frame)? else {
                    continue;
                };
                let started = Instant::now();
                let result = (|| -> Result<(), String> {
                    let v: Value =
                        serde_json::from_slice(&payload).map_err(|_| "飞书事件格式异常")?;
                    if v["header"]["event_type"] == "im.message.receive_v1"
                        && v["header"]["app_id"] == c.app_id
                    {
                        ingest(state, &c.app_id, &v["event"])?;
                    }
                    Ok(())
                })();
                if let Err(e) = &result {
                    state.error(e.clone());
                }
                frame.headers.push(Header {
                    key: "biz_rt".into(),
                    value: started.elapsed().as_millis().to_string(),
                });
                frame.payload = Some(
                    json!({"code":if result.is_ok(){200}else{500}})
                        .to_string()
                        .into_bytes(),
                );
                ws.send(Message::Binary(frame.encode_to_vec().into()))
                    .map_err(|_| "飞书消息确认失败")?;
            }
            Ok(Message::Close(_)) => return Err("飞书连接已断开".into()),
            Ok(_) => {
                last_received = Instant::now();
                let _ = ws.flush();
            }
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err("飞书连接中断，正在重连".into()),
        }
    }
    let _ = ws.close(None);
    Ok(())
}

fn catch_up(state: &TeamState, c: &Config, access: &str) -> Result<(), String> {
    catch_up_pages(state, c, |path| api("GET", path, access, Value::Null))
}
fn catch_up_pages(
    state: &TeamState,
    c: &Config,
    mut fetch: impl FnMut(&str) -> Result<Value, String>,
) -> Result<(), String> {
    let until = now();
    let mut page = String::new();
    for _ in 0..100 {
        let same = {
            let d = state.data.lock().unwrap();
            d.config.app_id == c.app_id
                && d.config.session == c.session
                && d.config.owner == c.owner
                && !c.owner.is_empty()
        };
        if !same {
            return Ok(());
        }
        let mut u = Url::parse(&format!("{ORIGIN}/open-apis/im/v1/messages")).unwrap();
        u.query_pairs_mut().extend_pairs([
            ("container_id_type", "chat"),
            ("container_id", c.chat_id.as_str()),
            ("sort_type", "ByCreateTimeAsc"),
            ("page_size", "50"),
            (
                "start_time",
                &(c.history_until.saturating_sub(60_000).max(c.bound_at) / 1000).to_string(),
            ),
            ("end_time", &(until / 1000).to_string()),
        ]);
        if !page.is_empty() {
            u.query_pairs_mut().append_pair("page_token", &page);
        }
        let v = fetch(&format!("{}?{}", u.path(), u.query().unwrap()))?;
        if !v["data"]["items"].is_array() || !v["data"]["has_more"].is_boolean() {
            return Err("飞书历史响应缺少列表或分页标记，未跳过消息".into());
        }
        for msg in v["data"]["items"].as_array().into_iter().flatten() {
            if msg["deleted"] == true || msg["sender"]["id_type"] != "open_id" {
                continue;
            }
            ingest(
                state,
                &c.app_id,
                &json!({"sender":{"sender_type":msg["sender"]["sender_type"],"sender_id":{"open_id":msg["sender"]["id"]}},
                "message":{"message_id":msg["message_id"],"chat_id":c.chat_id,"chat_type":"p2p","message_type":msg["msg_type"],"create_time":msg["create_time"],"parent_id":msg["parent_id"],"root_id":msg["root_id"],"content":msg["body"]["content"]}}),
            )?;
        }
        if v["data"]["has_more"] != true {
            let mut d = state.data.lock().unwrap();
            if d.config.app_id == c.app_id
                && d.config.owner == c.owner
                && d.config.session == c.session
            {
                let mut next = d.clone();
                next.config.history_until = until;
                state.save(&next)?;
                *d = next;
            }
            return Ok(());
        }
        let next = v["data"]["page_token"]
            .as_str()
            .filter(|v| !v.is_empty() && *v != page)
            .ok_or("历史消息分页异常，未跳过任何消息")?;
        page = next.into();
    }
    Err("历史消息较多，本轮未读完；进度未跳过，将再次补收".into())
}
fn flush(state: &TeamState, c: &Config, access: &str) -> Result<(), String> {
    let pending = {
        let mut d = state.data.lock().unwrap();
        if d.config.session != c.session {
            return Ok(());
        }
        let mut next = d.clone();
        for j in d.jobs.values().filter(|j| {
            j.device_id == c.session["device_id"].as_str().unwrap_or("")
                && matches!(j.stage.as_str(), "completed" | "partial" | "failed")
        }) {
            let title = j.result.as_ref().map_or("视频", |r| r.title.as_str());
            let text = match j.stage.as_str() {
                "completed" => format!(
                    "已完成：{title}\n分类：{}\n在影链工坊收件箱点击“打开文件夹”查看。",
                    j.category
                ),
                "partial" => format!("视频已保存，文案待处理：{title}\n请在电脑查看错误并重试。"),
                _ => format!(
                    "下载失败：{}\n请在电脑收件箱查看错误并重试。",
                    j.remote["url"].as_str().unwrap_or("视频")
                ),
            };
            notice(&mut next, &format!("{}:{}", j.id, j.stage), text);
        }
        if next.notices.len() != d.notices.len() {
            state.save(&next)?;
            *d = next;
        }
        d.notices
            .iter()
            .filter(|(_, n)| !n.sent && n.device == c.session["device_id"].as_str().unwrap_or(""))
            .take(10)
            .map(|(k, n)| (k.clone(), n.clone()))
            .collect::<Vec<_>>()
    };
    for (key, n) in pending {
        if !configured(state, c) {
            break;
        }
        api(
            "POST",
            "/open-apis/im/v1/messages?receive_id_type=open_id",
            access,
            json!({"receive_id":c.owner,"msg_type":"text","content":json!({"text":n.text}).to_string(),"uuid":n.uuid}),
        )?;
        let mut d = state.data.lock().unwrap();
        let mut next = d.clone();
        if let Some(n) = next.notices.get_mut(&key) {
            n.sent = true;
        }
        state.save(&next)?;
        *d = next;
    }
    Ok(())
}
fn setup_message(state: &TeamState, c: &Config, access: &str) -> Result<(), String> {
    if c.setup_message_sent {
        return Ok(());
    }
    // Retry with the same UUID if the response or durable save was interrupted.
    api("GET", "/open-apis/bot/v3/info", access, Value::Null)?;
    let result = api(
        "POST",
        "/open-apis/im/v1/messages?receive_id_type=open_id",
        access,
        json!({"receive_id":c.owner,"msg_type":"text","uuid":c.session["device_id"],
            "content":json!({"text":format!("影链工坊正在连接「{}」。请回复“连接测试”（或直接发送视频链接），电脑收到后会显示绑定完成。只接收你与此机器人的私聊。",c.device_name)}).to_string()}),
    )?;
    let chat = result["data"]["chat_id"]
        .as_str()
        .filter(|s| s.starts_with("oc_"))
        .ok_or("飞书未返回私聊会话，请在飞书直接给新机器人发一条消息")?;
    let mut d = state.data.lock().unwrap();
    if d.config.app_id == c.app_id && d.config.proof == c.proof && d.config.onboarding {
        let mut next = d.clone();
        next.config.chat_id = chat.into();
        next.config.setup_message_sent = true;
        state.save(&next)?;
        *d = next;
    }
    Ok(())
}
pub(super) fn start(state: TeamState) {
    let receiving = state.clone();
    thread::spawn(move || loop {
        let c = receiving.data.lock().unwrap().config.clone();
        if configured(&receiving, &c) {
            if let Err(e) = receive_ws(&receiving, &c) {
                *receiving.connection.lock().unwrap() = e;
                for _ in 0..10 {
                    if !configured(&receiving, &c) {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
        } else {
            let d = receiving.data.lock().unwrap();
            if d.config.app_id == c.app_id {
                *receiving.connection.lock().unwrap() = if c.app_id.is_empty() {
                    "未连接"
                } else {
                    "配对已过期，请重新生成配对码"
                }
                .into();
            }
        }
        thread::sleep(Duration::from_secs(1));
    });
    thread::spawn(move || {
        let mut access = String::new();
        let mut credential = String::new();
        let mut expires = 0;
        let mut next_history = 0;
        loop {
            let c = state.data.lock().unwrap().config.clone();
            if !c.owner.is_empty() && configured(&state, &c) {
                let outcome = (|| -> Result<(), String> {
                    if now() >= expires || credential != c.proof {
                        access = token(&c)?;
                        credential = c.proof.clone();
                        expires = now() + 3_600_000;
                        next_history = 0;
                    }
                    if c.onboarding {
                        setup_message(&state, &c, &access).map_err(|e| {
                            format!("扫码授权已保存，连接验证待重试：{e}；无需重新创建机器人")
                        })?;
                        if c.chat_id.is_empty() {
                            return Ok(());
                        }
                    }
                    let history_due = now() >= next_history;
                    let history_result = if history_due {
                        next_history = now() + 60_000;
                        catch_up(&state, &c, &access)
                    } else {
                        Ok(())
                    };
                    let flushed = flush(&state, &c, &access);
                    history_result
                        .map_err(|e| format!("离线消息补收未完成：{e}；请检查历史消息权限"))?;
                    flushed.map_err(|e| format!("飞书回执待重试：{e}"))?;
                    if history_due {
                        state.error(String::new());
                    }
                    Ok(())
                })();
                if let Err(e) = outcome {
                    state.error(e);
                }
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}
