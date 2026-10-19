//! Optional public-link resolvers. No platform cookies, API keys or browser state.
use super::*;
use reqwest::blocking::{Client, Response as HttpResponse};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Provider {
    MusicalDown,
    TikWm,
    SssTik,
}
impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::MusicalDown => "MusicalDown",
            Self::TikWm => "TikWM",
            Self::SssTik => "SSSTik",
        }
    }
    fn origin(self) -> &'static str {
        match self {
            Self::MusicalDown => "https://musicaldown.com",
            Self::TikWm => "https://www.tikwm.com",
            Self::SssTik => "https://ssstik.io",
        }
    }
}
const MAX_HTML: u64 = 2 * 1024 * 1024;

fn safe_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}
pub(super) fn media_allowed(provider: Provider, value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !safe_https(&url) {
        return false;
    }
    if tiktok_media_url(value) {
        return true;
    }
    match provider {
        Provider::MusicalDown => url.host_str() == Some("fastdl.muscdn.app"),
        Provider::SssTik => url.host_str() == Some("tikcdn.io"),
        Provider::TikWm => {
            matches!(url.host_str(), Some("www.tikwm.com" | "tikwm.com"))
                && url.path().starts_with("/video/")
        }
    }
}
fn page_allowed(provider: Provider, url: &Url) -> bool {
    safe_https(url) && url.host_str() == Url::parse(provider.origin()).unwrap().host_str()
}
fn client(source: &str, provider: Provider, media: bool) -> Result<Client, String> {
    network::client(source)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(if media { 180 } else { 15 }))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let allowed = if media {
                media_allowed(provider, attempt.url().as_str())
            } else {
                page_allowed(provider, attempt.url())
            };
            if attempt.previous().len() >= 4 || !allowed {
                attempt.error("unsafe redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "无法创建备用解析连接".into())
}
fn http_error(error: reqwest::Error) -> String {
    // reqwest errors may carry signed URLs; do not expose them in logs/UI.
    if let Some(code) = error.status() {
        format!("HTTP {}", code.as_u16())
    } else if error.is_timeout() {
        "连接超时".into()
    } else {
        "网络或响应读取失败".into()
    }
}
fn html(response: HttpResponse) -> Result<(String, String), String> {
    let response = response.error_for_status().map_err(http_error)?;
    if response.content_length().is_some_and(|n| n > MAX_HTML) {
        return Err("解析响应过大".into());
    }
    // Only the resolver's own temporary session, returned to the same origin.
    let cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|s| s.split(';').next())
        .filter(|s| !s.contains(['\r', '\n']))
        .collect::<Vec<_>>()
        .join("; ");
    let mut bytes = Vec::new();
    response
        .take(MAX_HTML + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "解析正文读取失败")?;
    if bytes.len() > MAX_HTML as usize {
        return Err("解析响应过大".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "解析文本编码异常")?;
    if text.contains("cf-chl-") || text.contains("Verify you are human") {
        return Err("服务要求人工验证，已跳过".into());
    }
    Ok((text, cookies))
}
fn decode(text: &str) -> String {
    let entities = regex::Regex::new(r"&#(x[0-9a-fA-F]+|[0-9]+);").unwrap();
    entities
        .replace_all(text, |c: &regex::Captures| {
            let n = if let Some(s) = c[1].strip_prefix('x') {
                u32::from_str_radix(s, 16).ok()
            } else {
                c[1].parse().ok()
            };
            n.and_then(char::from_u32)
                .map(|v| v.to_string())
                .unwrap_or_else(|| c[0].to_string())
        })
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
fn attrs(tag: &str) -> HashMap<String, String> {
    regex::Regex::new(r#"([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .unwrap()
        .captures_iter(tag)
        .map(|c| {
            (
                c[1].to_lowercase(),
                decode(c.get(2).or_else(|| c.get(3)).unwrap().as_str()),
            )
        })
        .collect()
}
fn tag_text(html: &str, tag: &str, class: &str) -> Option<String> {
    let pattern = format!(r"(?is)<{tag}\b([^>]*)>(.*?)</{tag}>");
    let strip = regex::Regex::new(r"<[^>]*>").unwrap();
    regex::Regex::new(&pattern)
        .unwrap()
        .captures_iter(html)
        .find_map(|c| {
            let attributes = attrs(&c[1]);
            if !class.is_empty()
                && !attributes
                    .get("class")
                    .is_some_and(|s| s.split_whitespace().any(|s| s == class))
            {
                return None;
            }
            let text = decode(&strip.replace_all(&c[2], " "))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!text.is_empty()).then_some(text)
        })
}
fn musical_form(html: &str, target: &str) -> Result<Vec<(String, String)>, String> {
    let forms = regex::Regex::new(r"(?is)<form\b[^>]*>(.*?)</form>").unwrap();
    let inputs = regex::Regex::new(r"(?is)<input\b[^>]*>").unwrap();
    for form in forms.captures_iter(html) {
        let mut fields = Vec::new();
        let mut found = false;
        for input in inputs.find_iter(&form[1]) {
            let a = attrs(input.as_str());
            let Some(name) = a.get("name") else { continue };
            match a.get("type").map(String::as_str).unwrap_or("text") {
                "hidden" => {
                    fields.push((name.clone(), a.get("value").cloned().unwrap_or_default()))
                }
                "text" | "url" if !found => {
                    fields.push((name.clone(), target.into()));
                    found = true;
                }
                _ => (),
            }
        }
        if found {
            return Ok(fields);
        }
    }
    Err("未找到公开链接解析表单".into())
}
fn page_links(provider: Provider, page: &str) -> Vec<String> {
    let tags = regex::Regex::new(r"(?is)<a\b[^>]*>").unwrap();
    let mut candidates = Vec::new();
    for tag in tags.find_iter(page) {
        let a = attrs(tag.as_str());
        let Some(url) = a.get("href") else { continue };
        let accepted = match provider {
            Provider::MusicalDown => {
                a.get("data-event").map(String::as_str) == Some("mp4_download_click")
            }
            Provider::SssTik => a
                .get("class")
                .is_some_and(|s| s.split_whitespace().any(|s| s == "without_watermark")),
            Provider::TikWm => false,
        };
        if accepted && media_allowed(provider, url) && !candidates.contains(url) {
            candidates.push(url.clone());
        }
    }
    candidates
}
fn tikwm_info(payload: &Value, id: &str, canonical: &str) -> Result<Value, String> {
    if payload["code"] != 0 || payload["data"]["id"].as_str() != Some(id) {
        return Err("作品 ID 不匹配或服务未返回作品".into());
    }
    let data = &payload["data"];
    let media = ["hdplay", "play"]
        .into_iter()
        .filter_map(|k| data[k].as_str())
        .find(|s| media_allowed(Provider::TikWm, s))
        .ok_or("没有安全的视频地址")?;
    let mut info = tiktok::media_info(id, canonical, Some(media), Provider::TikWm.origin());
    for (key, source) in [
        ("title", "title"),
        ("description", "title"),
        ("duration", "duration"),
        ("thumbnail", "cover"),
    ] {
        info[key] = data[source].clone();
    }
    info["uploader"] = data["author"]["nickname"].clone();
    info["uploader_id"] = data["author"]["unique_id"].clone();
    if !info["thumbnail"].as_str().is_some_and(tiktok_media_url) {
        info["thumbnail"] = Value::Null;
    }
    Ok(info)
}
pub(super) fn resolve(
    provider: Provider,
    source: &str,
    id: &str,
) -> Result<tiktok::Resolved, String> {
    // Strip query parameters, share text and account identifiers from the submitted URL.
    let canonical = format!("https://www.tiktok.com/@_/video/{id}");
    let client = client(source, provider, false)?;
    let result = (|| {
        let mut info = if provider == Provider::TikWm {
            let response = client
                .post(format!("{}/api/", provider.origin()))
                .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
                .form(&[("url", canonical.as_str()), ("hd", "1")])
                .send()
                .map_err(http_error)?;
            let (body, _) = html(response)?;
            tikwm_info(
                &serde_json::from_str::<Value>(&body).map_err(|_| "服务返回了无效 JSON")?,
                id,
                &canonical,
            )?
        } else {
            let home = format!("{}/en", provider.origin());
            let response = client
                .get(&home)
                .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
                .send()
                .map_err(http_error)?;
            let (page, cookies) = html(response)?;
            let (path, form) = if provider == Provider::MusicalDown {
                ("/download", musical_form(&page, &canonical)?)
            } else {
                let re = regex::Regex::new(r#"s_tt\s*=\s*["']([^"']+)["']"#).unwrap();
                let token = re
                    .captures(&page)
                    .and_then(|c| c.get(1))
                    .ok_or("未找到解析表单标记")?
                    .as_str()
                    .to_owned();
                (
                    "/abc?url=dl",
                    vec![
                        ("id".into(), canonical.clone()),
                        ("locale".into(), "en".into()),
                        ("tt".into(), token),
                    ],
                )
            };
            let response = client
                .post(format!("{}{path}", provider.origin()))
                .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
                .header(reqwest::header::REFERER, &home)
                .header(reqwest::header::ORIGIN, provider.origin())
                .header(reqwest::header::COOKIE, cookies)
                .form(&form)
                .send()
                .map_err(http_error)?;
            let (page, _) = html(response)?;
            let media = page_links(provider, &page)
                .into_iter()
                .next()
                .ok_or("服务没有返回可用的视频下载地址")?;
            let mut info = tiktok::media_info(id, &canonical, Some(&media), provider.origin());
            info["title"] = tag_text(
                &page,
                "p",
                if provider == Provider::MusicalDown {
                    "video-desc"
                } else {
                    "maintext"
                },
            )
            .map(Value::String)
            .unwrap_or(Value::Null);
            info["description"] = info["title"].clone();
            info["uploader"] = tag_text(
                &page,
                "h2",
                if provider == Provider::MusicalDown {
                    "video-author"
                } else {
                    ""
                },
            )
            .map(Value::String)
            .unwrap_or(Value::Null);
            info
        };
        info["_yinglian_free_provider"] = provider.name().into();
        Ok(tiktok::Resolved {
            info,
            cookies: None,
        })
    })();
    result.map_err(|error: String| format!("{}：{error}", provider.name()))
}

// Provider transfers deliberately do not use add_cookie_args or the browser jar.
// Redirect checks apply to the entire transfer, not just to a preliminary HEAD.
pub(super) fn transfer(
    provider: Provider,
    source: &str,
    url: &str,
    destination: &Path,
    mut progress: impl FnMut(u64, Option<u64>) -> Result<(), String>,
) -> Result<(), String> {
    if !media_allowed(provider, url) {
        return Err("不安全的备用媒体地址".into());
    }
    progress(0, None)?;
    let mut response = client(source, provider, true)?
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(reqwest::header::REFERER, provider.origin())
        .send()
        .map_err(http_error)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "HTTP {}，未取得视频文件",
            response.status().as_u16()
        ));
    }
    let expected = response.content_length();
    let mut file = File::create(destination).map_err(|_| "无法写入下载目录")?;
    let mut header = [0_u8; 12];
    response
        .read_exact(&mut header)
        .map_err(|_| "备用视频为空或不完整")?;
    if &header[4..8] != b"ftyp" {
        return Err("服务返回的不是 MP4 视频文件".into());
    }
    file.write_all(&header)
        .map_err(|_| "视频文件写入失败，请检查磁盘空间")?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut count = header.len() as u64;
    loop {
        progress(count, expected)?;
        let n = response.read(&mut buffer).map_err(|_| "备用视频传输中断")?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .map_err(|_| "视频文件写入失败，请检查磁盘空间")?;
        count += n as u64;
    }
    if count == 0 || expected.is_some_and(|n| count != n) {
        return Err("备用视频为空或不完整".into());
    }
    file.sync_all().map_err(|_| "视频文件保存失败")?;
    progress(count, Some(count))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domains_are_scoped_per_provider() {
        assert!(media_allowed(
            Provider::MusicalDown,
            "https://fastdl.muscdn.app/x"
        ));
        assert!(!media_allowed(
            Provider::SssTik,
            "https://fastdl.muscdn.app/x"
        ));
        for url in [
            "http://tikcdn.io/x",
            "https://tikcdn.io.evil.test/x",
            "https://u:p@tikcdn.io/x",
            "https://tikcdn.io:8443/x",
            "https://127.0.0.1/x",
        ] {
            assert!(!media_allowed(Provider::SssTik, url));
        }
        assert!(!page_allowed(
            Provider::MusicalDown,
            &Url::parse("https://ssstik.io/download").unwrap()
        ));
    }
    #[test]
    fn video_links_exclude_music_adverts_and_unsafe_hosts() {
        let html = r#"<a data-event="mp3_download_click" href="https://fastdl.muscdn.app/music"></a><a data-event='mp4_download_click' href='https://fastdl.muscdn.app/video?a=1&amp;b=2'></a><a data-event="mp4_download_click" href="https://evil.test/x"></a>"#;
        assert_eq!(
            page_links(Provider::MusicalDown, html),
            ["https://fastdl.muscdn.app/video?a=1&b=2"]
        );
        assert!(page_links(
            Provider::SssTik,
            r#"<a class="music" href="https://tikcdn.io/mp3"></a>"#
        )
        .is_empty());
    }
    #[test]
    fn form_and_text_handle_entities_without_executing_scripts() {
        let fields = musical_form(r#"<form><input name="url" type="text"><input type="hidden" name="token" value="x&amp;y"></form>"#, "public-link").unwrap();
        assert_eq!(
            fields,
            [
                ("url".into(), "public-link".into()),
                ("token".into(), "x&y".into())
            ]
        );
        assert_eq!(
            tag_text(
                "<p class='video-desc'>Hello &amp; &#20013;</p>",
                "p",
                "video-desc"
            ),
            Some("Hello & 中".into())
        );
    }
    #[test]
    fn tikwm_must_match_id() {
        let data = serde_json::json!({"code":0,"data":{"id":"1","play":"https://v19.tiktokcdn.com/video.mp4"}});
        assert!(tikwm_info(&data, "2", "source").is_err());
        assert!(tikwm_info(&data, "1", "source").is_ok());
    }
}
