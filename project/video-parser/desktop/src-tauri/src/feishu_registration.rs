//! Official Feishu app-registration device flow, ported from the official SDK.
//! https://github.com/larksuite/node-sdk#app-registration (MIT)
//! Credentials/device_code never cross IPC. No Node sidecar or relay is required.
use super::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use flate2::{write::GzEncoder, Compression};
use qrcode::{render::svg, QrCode};
use uuid::Uuid;

const ENDPOINT: &str = "https://accounts.feishu.cn/oauth/v1/app/registration";
const MAX_RESPONSE: u64 = 64 * 1024;

#[derive(Clone, Serialize)]
pub(super) struct Registration {
    #[serde(skip)]
    id: String,
    status: String,
    message: String,
    url: String,
    qr: String,
    expires: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn status(state: &TeamState) -> Value {
    let mut value = state.registration.lock().unwrap();
    if let Some(r) = value.as_mut() {
        expire(r);
    }
    serde_json::to_value(value.as_ref()).unwrap_or(Value::Null)
}
fn expire(r: &mut Registration) {
    if r.expires <= now() && matches!(r.status.as_str(), "starting" | "waiting") {
        r.status = "expired".into();
        r.message = "二维码已过期，请重新生成".into();
        r.url.clear();
        r.qr.clear();
    }
}
fn current(r: &Registration, id: &str) -> bool {
    r.id == id && r.expires > now() && matches!(r.status.as_str(), "starting" | "waiting")
}
pub(super) fn cancel(state: &TeamState) {
    if let Some(r) = state.registration.lock().unwrap().as_mut() {
        r.status = "cancelled".into();
        r.message = "本机已取消等待。若已在飞书确认创建，远端机器人不会自动删除。".into();
        r.url.clear();
        r.qr.clear();
    }
}
fn active(state: &TeamState, id: &str) -> bool {
    let mut reg = state.registration.lock().unwrap();
    reg.as_mut().is_some_and(|r| {
        expire(r);
        current(r, id)
    })
}
fn update(state: &TeamState, id: &str, work: impl FnOnce(&mut Registration)) {
    if let Some(r) = state
        .registration
        .lock()
        .unwrap()
        .as_mut()
        .filter(|r| current(r, id))
    {
        work(r);
    }
}
fn fail(state: &TeamState, id: &str, message: String) {
    update(state, id, |r| {
        r.status = "failed".into();
        r.message = message;
        r.qr.clear();
        r.url.clear();
    });
}
fn begin_body() -> String {
    "action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id"
        .into()
}
fn poll_body(code: &str) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("action", "poll")
        .append_pair("device_code", code)
        .finish()
}
fn request_at(endpoint: &str, body: &str) -> Result<Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化飞书授权连接")?
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body.to_owned())
        .send()
        .map_err(|_| "连接飞书授权服务失败，请检查网络")?;
    let http = response.status();
    // Device flow pending/slow_down are valid HTTP 400 responses (RFC 8628).
    if !http.is_success() && http.as_u16() != 400 {
        return Err(format!("飞书授权服务暂不可用（HTTP {}）", http.as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取飞书授权响应")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("飞书授权响应过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "飞书授权响应格式异常".into())
}
fn addons() -> Value {
    json!({"preset":false,
        "scopes":{"tenant":["im:message.p2p_msg:readonly","im:message:readonly","im:message:send_as_bot"]},
        "events":{"items":{"tenant":["im.message.receive_v1"]}}})
}
fn verification_url(raw: &str) -> Result<String, String> {
    let mut url = url::Url::parse(raw).map_err(|_| "飞书授权地址格式异常")?;
    if url.scheme() != "https"
        || url.host_str() != Some("open.feishu.cn")
        || url.path() != "/page/launcher"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || raw.len() > 4096
    {
        return Err("拒绝打开非预期的飞书官方授权地址".into());
    }
    // Remove potentially conflicting provider parameters before adding ours once.
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| {
            !matches!(
                k.as_ref(),
                "from" | "source" | "tp" | "name" | "desc" | "addons" | "createOnly" | "clientID"
            )
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.set_query(None);
    let mut compressed = GzEncoder::new(Vec::new(), Compression::default());
    compressed
        .write_all(addons().to_string().as_bytes())
        .map_err(|_| "无法生成授权配置")?;
    let encoded = URL_SAFE_NO_PAD.encode(compressed.finish().map_err(|_| "无法生成授权配置")?);
    url.query_pairs_mut()
        .extend_pairs(retained)
        .append_pair("from", "sdk")
        .append_pair("source", "yinglian-desktop")
        .append_pair("tp", "sdk")
        .append_pair("name", "{user}的视频助手")
        .append_pair(
            "desc",
            "将分享链接和分类备注发送到自己的电脑下载，仅处理本人私聊。",
        )
        .append_pair("addons", &encoded)
        .append_pair("createOnly", "true");
    Ok(url.into())
}
fn qr_image(url: &str) -> Result<String, String> {
    let svg = QrCode::new(url.as_bytes())
        .map_err(|_| "授权地址过长，无法生成二维码")?
        .render::<svg::Color>()
        .min_dimensions(300, 300)
        .quiet_zone(true)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}
struct Ticket {
    code: String,
    url: String,
    qr: String,
    seconds: u64,
    interval: u64,
}
fn ticket(v: &Value) -> Result<Ticket, String> {
    let code = v["device_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or("飞书未返回授权会话，请稍后重试")?
        .to_owned();
    let url = verification_url(
        v["verification_uri_complete"]
            .as_str()
            .ok_or("飞书未返回授权地址")?,
    )?;
    let qr = qr_image(&url)?;
    let seconds = v["expires_in"].as_u64().unwrap_or(600);
    let interval = v["interval"].as_u64().unwrap_or(5);
    if !(1..=7200).contains(&seconds) || !(1..=120).contains(&interval) {
        return Err("飞书授权会话有效期异常".into());
    }
    Ok(Ticket {
        code,
        url,
        qr,
        seconds,
        interval,
    })
}
enum Poll {
    Pending,
    Slow,
    Authorized,
    Failed(&'static str),
}
fn classify(v: &Value) -> Poll {
    if v["user_info"]["tenant_brand"] == "lark" {
        return Poll::Failed("当前版本仅支持国内飞书，请使用飞书账号；尚不支持国际版 Lark");
    }
    if v["client_id"].as_str().is_some() && v["client_secret"].as_str().is_some() {
        return Poll::Authorized;
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::Slow,
        Some("access_denied") => Poll::Failed("你已拒绝授权，未绑定此电脑"),
        Some("expired_token") => Poll::Failed("二维码已过期，请重新生成"),
        _ => Poll::Failed("飞书未完成授权，请检查官方页面上的企业审批提示后重试"),
    }
}
fn store_authorized(state: &TeamState, id: &str, name: &str, v: &Value) -> Result<(), String> {
    let app = v["client_id"].as_str().unwrap_or("");
    let secret = v["client_secret"].as_str().unwrap_or("");
    if !app.starts_with("cli_")
        || !(8..=80).contains(&app.len())
        || !app.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || !(8..=256).contains(&secret.len())
        || secret.chars().any(char::is_whitespace)
    {
        return Err("飞书返回的应用凭证无效，未保存".into());
    }
    let owner = v["user_info"]["open_id"].as_str().unwrap_or("");
    if !owner.is_empty()
        && (!owner.starts_with("ou_")
            || owner.len() > 128
            || !owner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_'))
    {
        return Err("飞书返回的账号标识无效，未保存".into());
    }
    let proof = protect_secret(secret)?;
    // Fixed lock order: journal -> registration. Cancellation races cannot commit
    // a stale authorization after a newer attempt or overwrite an existing bot.
    let mut data = state.data.lock().unwrap();
    let mut registration = state.registration.lock().unwrap();
    let Some(r) = registration.as_mut().filter(|r| current(r, id)) else {
        return Ok(());
    };
    if !data.config.app_id.is_empty() {
        return Err("已有机器人配置，未覆盖；请先解除旧配对".into());
    }
    feishu::ensure_idle(state, &data)?;
    let mut next = data.clone();
    let c = &mut next.config;
    c.app_id = app.into();
    c.proof = proof;
    c.owner = owner.into();
    c.chat_id.clear();
    c.device_name = name.into();
    c.enabled = false;
    c.onboarding = true;
    c.setup_message_sent = false;
    c.bound_at = now();
    c.history_until = c.bound_at;
    c.session = if owner.is_empty() {
        Value::Null
    } else {
        json!({"device_id":Uuid::new_v4().to_string(), "user_name":format!("飞书账号 · {}", &owner[owner.len().saturating_sub(8)..]),"device_name":name})
    };
    state.save(&next)?;
    *data = next;
    r.status = "authorized".into();
    r.message = "官方授权已完成，正在验证机器人收发消息".into();
    r.url.clear();
    r.qr.clear();
    drop(registration);
    drop(data);
    state.error(String::new());
    if owner.is_empty() {
        feishu::renew_pair(state)?;
    }
    Ok(())
}
fn run(state: TeamState, id: String, name: String) -> Result<(), String> {
    let begin = ticket(&request_at(ENDPOINT, &begin_body())?)?;
    update(&state, &id, |r| {
        r.status = "waiting".into();
        r.message = "用飞书扫一扫，在官方页面确认创建专属机器人".into();
        r.expires = now() + begin.seconds * 1000;
        r.url = begin.url;
        r.qr = begin.qr;
    });
    let mut interval = begin.interval;
    while active(&state, &id) {
        // Short waits make cancellation responsive, without keeping the UI busy.
        for _ in 0..interval * 4 {
            if !active(&state, &id) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        let response = request_at(ENDPOINT, &poll_body(&begin.code));
        if !active(&state, &id) {
            return Ok(());
        }
        let v = match response {
            Ok(v) => v,
            Err(_) => {
                update(&state, &id, |r| {
                    r.message = "授权连接暂时中断，正在重试；可以取消后重新生成".into()
                });
                continue;
            }
        };
        match classify(&v) {
            Poll::Pending => update(&state, &id, |r| {
                r.message = "等待你在飞书官方页面确认授权".into()
            }),
            Poll::Slow => {
                interval = (interval + 5).min(120);
                update(&state, &id, |r| {
                    r.message = "飞书要求降低查询频率，仍在等待授权".into()
                });
            }
            Poll::Failed(message) => return Err(message.into()),
            Poll::Authorized => return store_authorized(&state, &id, &name, &v),
        }
    }
    Ok(())
}
pub(super) fn start(state: &TeamState, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("请填写电脑名称（最多 80 字）".into());
    }
    let data = state.data.lock().unwrap();
    feishu::ensure_idle(state, &data)?;
    if !data.config.app_id.is_empty() {
        return Err("此电脑已有机器人配置，请继续连接验证或先解除配对".into());
    }
    let mut reg = state.registration.lock().unwrap();
    if reg.as_ref().is_some_and(|r| current(r, &r.id)) {
        return Err("请先完成或取消当前扫码".into());
    }
    let id = Uuid::new_v4().to_string();
    *reg = Some(Registration {
        id: id.clone(),
        status: "starting".into(),
        message: "正在向飞书获取官方授权二维码…".into(),
        url: String::new(),
        qr: String::new(),
        expires: now() + 30_000,
    });
    drop(reg);
    drop(data);
    let state = state.clone();
    let name = name.to_owned();
    thread::spawn(move || {
        if let Err(message) = run(state.clone(), id.clone(), name) {
            fail(&state, &id, message);
        }
    });
    Ok(())
}
pub(super) fn open_page(state: &TeamState) -> Result<(), String> {
    let reg = state.registration.lock().unwrap();
    let r = reg
        .as_ref()
        .filter(|r| current(r, &r.id) && !r.url.is_empty())
        .ok_or("二维码已过期，请重新生成")?;
    // No caller-supplied URL, shell interpolation, or credentials in arguments.
    let mut command = Command::new("explorer.exe");
    command.arg(&r.url);
    hidden(&mut command);
    command
        .spawn()
        .map_err(|_| "无法打开默认浏览器，请用手机扫描二维码")?;
    Ok(())
}

#[cfg(test)]
#[path = "feishu_registration_tests.rs"]
mod tests;
