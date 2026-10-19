//! Independent, bounded TikTok resolver stages. Metadata is not proof of a video.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Route {
    Embed,
    Extractor,
    Public,
    MusicalDown,
    SssTik,
    Player,
}

impl Route {
    pub(super) fn provider(self) -> Option<tiktok_free::Provider> {
        match self {
            Self::Public => Some(tiktok_free::Provider::TikWm),
            Self::MusicalDown => Some(tiktok_free::Provider::MusicalDown),
            Self::SssTik => Some(tiktok_free::Provider::SssTik),
            _ => None,
        }
    }
}

pub(super) struct Resolved {
    pub info: Value,
    pub cookies: Option<String>,
}

pub(super) fn playback_cookie_jar(cookies: &Value) -> String {
    let mut jar = String::from("# Netscape HTTP Cookie File\n");
    for cookie in cookies.as_array().into_iter().flatten() {
        let Some(domain) = cookie["domain"].as_str() else {
            continue;
        };
        let host = domain.trim_start_matches('.');
        if host != "tiktok.com" && !host.ends_with(".tiktok.com") {
            continue;
        }
        let (Some(name), Some(value), Some(path)) = (
            cookie["name"].as_str(),
            cookie["value"].as_str(),
            cookie["path"].as_str(),
        ) else {
            continue;
        };
        if [domain, name, value, path]
            .iter()
            .any(|v| v.contains(['\t', '\r', '\n']))
            || !path.starts_with('/')
        {
            continue;
        }
        let http_only = if cookie["httpOnly"] == true {
            "#HttpOnly_"
        } else {
            ""
        };
        let subdomains = if domain.starts_with('.') {
            "TRUE"
        } else {
            "FALSE"
        };
        let secure = if cookie["secure"] == true {
            "TRUE"
        } else {
            "FALSE"
        };
        let expires = cookie["expires"]
            .as_f64()
            .filter(|v| *v > 0.0)
            .unwrap_or(0.0) as u64;
        jar.push_str(&format!(
            "{http_only}{domain}\t{subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n"
        ));
    }
    jar
}

pub(super) fn browser_media<S: Read + Write>(
    app: &tauri::AppHandle,
    socket: &mut tungstenite::WebSocket<S>,
    url: &str,
    first_id: i64,
    budget: Duration,
) -> Result<Option<String>, String> {
    let navigation = cdp_call(
        socket,
        first_id,
        "Page.navigate",
        serde_json::json!({"url":url}),
    )?;
    if navigation.pointer("/result/errorText").is_some() {
        return Ok(None);
    }
    let frame = navigation
        .pointer("/result/frameId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let started = std::time::Instant::now();
    let expression = r#"(() => {
        const requestedId = __POST_ID__;
        const videos = [...document.querySelectorAll('video')];
        // Normal playback only; no challenge handling or synthetic account state.
        if (Date.now() - (window.__yinglianPlayRequested || 0) > 4000) {
            window.__yinglianPlayRequested = Date.now();
            if (videos.length === 1) { videos[0].muted = true; videos[0].play().catch(() => {}); }
            if (location.pathname.startsWith('/player/'))
                window.postMessage({'x-tiktok-player':true, type:'play'}, location.origin);
        }
        let item;
        try { item = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || '{}').__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct; } catch {}
        const urls = [];
        for (const video of videos) {
            const source = video.currentSrc || video.src;
            if (location.pathname.startsWith('/player/')) { urls.push(source); continue; }
            // A work page can show recommendations or redirect to For You.
            // Bind the media to the requested post, not just any video element.
            if (!requestedId || item?.id !== requestedId || !location.pathname.endsWith('/video/' + requestedId)) continue;
            try {
                const media = new URL(source);
                if (media.hostname === 'www.tiktok.com' && media.pathname === '/aweme/v1/play/') {
                    if (item.video?.videoID && media.searchParams.get('video_id') === item.video.videoID) urls.push(source);
                } else if (videos.length === 1 && item.video?.duration > 0 && Math.abs(video.duration - item.video.duration) < 1.5) {
                    urls.push(source);
                }
            } catch {}
        }
        return JSON.stringify({urls});
    })()"#.replace("__POST_ID__", &serde_json::to_string(&tiktok_video_id(url)).unwrap());
    let mut id = first_id;
    while started.elapsed() < budget {
        id += 1;
        let mut observed = None;
        let payload = cdp_call_observe(
            socket,
            id,
            "Runtime.evaluate",
            serde_json::json!({
                "expression":expression,"returnByValue":true
            }),
            |event| {
                // Work pages may prefetch recommendations; only the single-item embed
                // may use network-only discovery. Work pages require a DOM video URL.
                if url.contains("/player/") {
                    if let Some(url) = media_from_event(event, frame) {
                        observed = Some(url);
                    }
                }
            },
        )?;
        let data = payload
            .pointer("/result/result/value")
            .and_then(Value::as_str)
            .and_then(|value| serde_json::from_str::<Value>(value).ok());
        let candidate = data
            .as_ref()
            .and_then(|data| data["urls"].as_array())
            .and_then(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|url| tiktok_media_url(url))
            })
            .map(str::to_owned)
            .or(observed);
        if candidate.is_some() {
            return Ok(candidate);
        }
        thread::sleep(Duration::from_millis(250));
    }
    // No signed URLs, tokens, cookie values, titles or page text in diagnostics.
    let diagnostic = cdp_call(socket, id + 1, "Runtime.evaluate", serde_json::json!({
        "expression":"JSON.stringify({path:location.pathname,ready:document.readyState,videos:[...document.querySelectorAll('video')].map(v=>({scheme:(v.currentSrc||v.src).split(':')[0],host:(()=>{try{return new URL(v.currentSrc||v.src).hostname}catch{return ''}})(),mediaId:(()=>{try{return new URL(v.currentSrc||v.src).searchParams.get('video_id')}catch{return ''}})(),duration:v.duration,time:v.currentTime,ready:v.readyState,error:v.error?.code||0}))})",
        "returnByValue":true
    })).ok().and_then(|v| v.pointer("/result/result/value").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
    let route = if url.contains("/player/") {
        "embed"
    } else {
        "work-page"
    };
    runtime_log(
        app,
        format!("tiktok_player_empty route={route} {diagnostic}"),
    );
    #[cfg(feature = "team-smoke")]
    println!("PLAYER_DIAGNOSTIC route={route} {diagnostic}");
    Ok(None)
}

pub(super) fn media_from_event(event: &Value, frame_id: &str) -> Option<String> {
    if frame_id.is_empty()
        || event["method"] != "Network.responseReceived"
        || event.pointer("/params/frameId").and_then(Value::as_str) != Some(frame_id)
    {
        return None;
    }
    let response = event.pointer("/params/response")?;
    if !matches!(response["status"].as_u64(), Some(200 | 206))
        || !matches!(
            response["mimeType"].as_str(),
            Some("video/mp4" | "video/webm")
        )
    {
        return None;
    }
    response["url"]
        .as_str()
        .filter(|url| tiktok_media_url(url))
        // The official play endpoint also serves recommendations. Accept it
        // only through the DOM path that checks the requested post/media IDs.
        .filter(|url| {
            Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .as_deref()
                != Some("www.tiktok.com")
        })
        .map(str::to_owned)
}

pub(super) fn has_video(info: &Value) -> bool {
    info.get("formats")
        .and_then(Value::as_array)
        .is_some_and(|formats| {
            formats.iter().any(|format| {
                format
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.is_empty())
                    && format.get("vcodec").and_then(Value::as_str) != Some("none")
                    && (format
                        .get("vcodec")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                        || format.get("height").and_then(Value::as_u64).unwrap_or(0) > 0)
            })
        })
}

#[cfg(test)]
fn resolve(
    id: &str,
    source: &str,
    need_video: bool,
    authenticated: bool,
    attempt: impl FnMut(Route) -> Result<Resolved, String>,
) -> Result<Resolved, String> {
    resolve_remaining(id, source, need_video, authenticated, &[], None, attempt)
}

pub(super) fn resolve_remaining(
    id: &str,
    source: &str,
    need_video: bool,
    authenticated: bool,
    excluded: &[Route],
    mut metadata: Option<Value>,
    mut attempt: impl FnMut(Route) -> Result<Resolved, String>,
) -> Result<Resolved, String> {
    let mut errors = Vec::new();
    // Do not throw away a saved login by starting with an anonymous embed request.
    let routes = if authenticated {
        [
            Route::Extractor,
            Route::Embed,
            Route::MusicalDown,
            Route::Public,
            Route::SssTik,
            Route::Player,
        ]
    } else {
        [
            Route::Embed,
            Route::Extractor,
            Route::MusicalDown,
            Route::Public,
            Route::SssTik,
            Route::Player,
        ]
    };
    // Acceptance-only permutation: exercise a real empty-file fallback. Never
    // compiled into release builds and never changes the user's preferences.
    #[cfg(feature = "team-smoke")]
    let routes = {
        let mut routes = routes;
        if std::env::var("PAOLIANG_SMOKE_SSSTIK_FIRST").as_deref() == Ok("1") {
            routes.swap(2, 4);
        }
        routes
    };
    for route in routes {
        if excluded.contains(&route) || (route == Route::Player && !need_video) {
            continue;
        }
        match attempt(route) {
            Err(error) => {
                if error == "任务已取消" {
                    return Err(error);
                }
                // A rate limit is not an invitation to hammer the same platform
                // via the next extractor or browser route.
                if route.provider().is_none() && error.contains("429") {
                    return Err(
                        "TikTok 暂时限制了请求频率（HTTP 429），请稍后再试；已停止继续请求平台。"
                            .into(),
                    );
                }
                errors.push(error);
            }
            Ok(mut result) => {
                if result.info.get("id").and_then(Value::as_str) != Some(id) {
                    errors.push(format!("{route:?} 返回的作品 ID 不一致"));
                    continue;
                }
                // Player/public fallback may supply only media; retain known title/cover.
                if let Some(previous) = metadata.as_ref().and_then(Value::as_object) {
                    if let Some(current) = result.info.as_object_mut() {
                        for key in [
                            "title",
                            "description",
                            "thumbnail",
                            "thumbnails",
                            "uploader",
                            "uploader_id",
                            "timestamp",
                            "duration",
                            "subtitles",
                            "upload_date",
                            "_yinglian_media_id",
                        ] {
                            if let Some(value) = previous.get(key) {
                                if current.get(key).map_or(true, |v| {
                                    v.is_null()
                                        || v.as_str() == Some("")
                                        || v.as_object().is_some_and(|v| v.is_empty())
                                }) {
                                    current.insert(key.into(), value.clone());
                                }
                            }
                        }
                    }
                }
                result.info["original_url"] = source.into();
                if result
                    .info
                    .get("title")
                    .and_then(Value::as_str)
                    .is_none_or(|v| v.is_empty())
                {
                    result.info["title"] = format!("TikTok 视频 {id}").into();
                }
                if !need_video || has_video(&result.info) {
                    return Ok(result);
                }
                metadata = Some(result.info);
                errors.push(format!("{route:?} 未返回视频画面（可能只有音频）"));
            }
        }
    }
    Err(format!(
        "TikTok {}失败；{}。请检查该作品在当前代理线路下能否播放，或稍后重试。",
        if need_video {
            "视频解析"
        } else {
            "预览解析"
        },
        errors.join("；")
    ))
}

fn request_error(error: reqwest::Error) -> String {
    // Preserve the transport/body cause, but never print signed URLs or cookie headers.
    let error = error.without_url();
    let detail = std::error::Error::source(&error)
        .map(|cause| format!("：{cause}"))
        .unwrap_or_default();
    format!("TikTok 官方嵌入页读取失败：{error}{detail}")
}

pub(super) fn embed_html(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    for attempt in 0..2 {
        let response = client
            .get(url)
            .timeout(Duration::from_secs(8))
            .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status);
        let result = match response {
            Ok(response) => {
                if response
                    .content_length()
                    .is_some_and(|size| size > 4 * 1024 * 1024)
                {
                    return Err("TikTok 官方嵌入页数据过大".into());
                }
                let mut bytes = Vec::new();
                match response.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes) {
                    Ok(_) if bytes.len() > 4 * 1024 * 1024 => {
                        return Err("TikTok 官方嵌入页数据过大".into())
                    }
                    Ok(_) => {
                        return String::from_utf8(bytes)
                            .map_err(|_| "TikTok 官方嵌入页文本编码异常".into())
                    }
                    Err(error) => Err((format!("TikTok 官方嵌入页正文读取失败：{error}"), true)),
                }
            }
            Err(error) => {
                let retry = error.is_timeout()
                    || error.is_connect()
                    || error.is_body()
                    || error.is_decode()
                    || error
                        .status()
                        .is_some_and(|status| status.is_server_error());
                Err((request_error(error), retry))
            }
        };
        let Err((error, retry)): Result<(), _> = result else {
            unreachable!()
        };
        if attempt == 1 || !retry {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(250));
    }
    unreachable!()
}

pub(super) fn embed_info(
    client: &reqwest::blocking::Client,
    id: &str,
    canonical: &str,
) -> Result<Resolved, String> {
    let embed_url = format!("https://www.tiktok.com/embed/v2/{id}");
    let state = tiktok_embed_state(&embed_html(client, &embed_url)?)?;
    let entries = state
        .pointer("/source/data")
        .and_then(Value::as_object)
        .ok_or("TikTok 官方嵌入页缺少作品数据")?;
    let entry = entries
        .get(&format!("/embed/v2/{id}"))
        .ok_or("TikTok 官方嵌入页没有找到该作品")?;
    let data = entry
        .get("videoData")
        .ok_or("TikTok 官方嵌入页缺少视频数据")?;
    let item = data
        .get("itemInfos")
        .ok_or("TikTok 官方嵌入页缺少作品信息")?;
    if item.get("id").and_then(Value::as_str) != Some(id) {
        return Err("TikTok 官方嵌入页返回了其他作品".into());
    }
    let media = item
        .pointer("/video/urls")
        .and_then(Value::as_array)
        .and_then(|urls| {
            urls.iter()
                .filter_map(Value::as_str)
                .find(|url| tiktok_media_url(url))
        });
    let mut info = media_info(id, canonical, media, &embed_url);
    for (key, pointer) in [
        ("title", "/text"),
        ("description", "/text"),
        ("timestamp", "/createTime"),
        ("duration", "/video/videoMeta/duration"),
    ] {
        if let Some(value) = item.pointer(pointer) {
            info[key] = value.clone();
        }
    }
    info["thumbnail"] = item
        .pointer("/coversOrigin/0")
        .or_else(|| item.pointer("/covers/0"))
        .cloned()
        .unwrap_or(Value::Null);
    info["uploader"] = data
        .pointer("/authorInfos/uniqueId")
        .cloned()
        .unwrap_or(Value::Null);
    info["uploader_id"] = data
        .pointer("/authorInfos/userId")
        .cloned()
        .unwrap_or(Value::Null);
    if media.is_some() {
        for key in ["width", "height"] {
            info["formats"][0][key] = item
                .pointer(&format!("/video/videoMeta/{key}"))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    Ok(Resolved {
        info,
        cookies: None,
    })
}

pub(super) fn media_info(id: &str, canonical: &str, media: Option<&str>, referer: &str) -> Value {
    let formats = media
        .map(|url| {
            serde_json::json!([{
                "format_id": "tiktok-video", "url": url, "ext": "mp4", "protocol": "https",
                "vcodec": "h264", "acodec": "aac",
                "http_headers": { "Referer": referer, "User-Agent": BROWSER_USER_AGENT }
            }])
        })
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::json!({ "_type": "video", "id": id, "webpage_url": canonical,
        "extractor": "TikTok", "extractor_key": "TikTok", "formats": formats, "subtitles": {} })
}

#[cfg(feature = "team-smoke")]
pub(super) fn verify_video(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    verify_video_info(app, path, None).map(|_| ())
}

fn verify_video_info(
    app: &tauri::AppHandle,
    path: &Path,
    expected: Option<f64>,
) -> Result<f64, String> {
    let tool = find_tool(app, "ffprobe.exe").ok_or("视频校验引擎尚未就绪")?;
    let mut command = Command::new(tool);
    command
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(path);
    let output = live::capture(
        &mut command,
        Duration::from_secs(15),
        &AtomicBool::new(false),
    )?;
    let metadata = serde_json::from_slice::<Value>(&output.stdout).ok();
    let video = metadata
        .as_ref()
        .and_then(|value| value["streams"].as_array())
        .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video"));
    if !output.status.success() || !video {
        return Err(
            "TikTok 返回的文件没有可识别的视频画面，未将音频冒充视频保存；请更换可用线路后重试"
                .into(),
        );
    }
    let actual = metadata
        .as_ref()
        .and_then(|m| m["format"]["duration"].as_str())
        .and_then(|s| s.parse::<f64>().ok());
    if !duration_matches(expected, actual) {
        return Err("下载视频时长与原作品不符，已拒绝该结果".into());
    }
    Ok(actual.unwrap())
}

fn duration_matches(expected: Option<f64>, actual: Option<f64>) -> bool {
    let Some(actual) = actual.filter(|n| n.is_finite() && *n > 0.0) else {
        return false;
    };
    expected
        .filter(|n| n.is_finite() && *n > 0.0)
        .is_none_or(|expected| (actual - expected).abs() <= 2.0_f64.max(expected * 0.03))
}

fn cancelled(state: &RuntimeState, job: &str) -> Result<(), String> {
    if state
        .cancelled
        .lock()
        .map_err(|_| "任务状态不可用")?
        .contains(job)
    {
        Err("任务已取消".into())
    } else {
        Ok(())
    }
}

pub(super) fn download(
    app: &tauri::AppHandle,
    state: &RuntimeState,
    request: &DownloadRequest,
    source: &str,
    workspace: &Path,
) -> Result<PathBuf, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&cache).map_err(|_| "无法创建任务缓存")?;
    let destination = cache.join(format!("tiktok-{}.json", request.job_id));
    let mut excluded = Vec::new();
    let mut metadata = None;
    let mut failures = Vec::new();
    // Six independent routes; no provider can be tried twice in one download.
    for _ in 0..6 {
        cancelled(state, &request.job_id)?;
        emit_progress(
            app,
            &request.job_id,
            "downloading",
            0.0,
            if failures.is_empty() {
                "正在解析 TikTok 视频，必要时自动切换免费来源"
            } else {
                "当前来源下载失败，正在切换下一个免费来源"
            },
        );
        let prepared = prepare_tiktok_remaining(
            app,
            source,
            &destination,
            true,
            &excluded,
            metadata.clone(),
            || cancelled(state, &request.job_id),
        )
        .map_err(|e| {
            if failures.is_empty() {
                e
            } else {
                format!("{}；{e}", failures.join("；"))
            }
        })?;
        let route = *prepared.attempted.last().ok_or("没有剩余解析来源")?;
        excluded.extend(prepared.attempted.iter().copied());
        let mut info = prepared.info.clone();
        metadata = Some(info.clone());
        let expected = info["duration"].as_f64();
        let result = if let Some(provider) = route.provider() {
            download_free(app, state, request, source, workspace, provider, &mut info)
        } else {
            download_with_engine(app, state, request, source, workspace, Some(&prepared))
        }
        .and_then(|path| {
            verify_video_info(app, &path, expected)?;
            Ok(path)
        });
        match result {
            Ok(path) => {
                runtime_log(app, format!("tiktok_download_verified route={route:?}"));
                return Ok(path);
            }
            Err(error) => {
                cancelled(state, &request.job_id)?;
                if (route.provider().is_none() && error.contains("429"))
                    || error.contains("磁盘")
                    || error.contains("写入")
                    || error.contains("保存失败")
                {
                    return Err(error);
                }
                runtime_log(app, format!("tiktok_download_fallback route={route:?}"));
                #[cfg(feature = "team-smoke")]
                println!("DOWNLOAD_FALLBACK route={route:?} reason={error}");
                failures.push(format!("{route:?} 下载或校验失败"));
            }
        }
    }
    Err(format!(
        "所有解析来源均未取得有效视频：{}",
        failures.join("；")
    ))
}

fn safe_title(title: &str) -> String {
    title
        .chars()
        .take(48)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

fn download_free(
    app: &tauri::AppHandle,
    state: &RuntimeState,
    request: &DownloadRequest,
    source: &str,
    workspace: &Path,
    provider: tiktok_free::Provider,
    info: &mut Value,
) -> Result<PathBuf, String> {
    #[cfg(feature = "team-smoke")]
    if std::env::var("PAOLIANG_SMOKE_FAIL_PROVIDER").as_deref() == Ok(provider.name()) {
        return Err("验收注入：模拟 HTTP 204 空文件，不是该服务的实时结果".into());
    }
    let id = info["id"].as_str().ok_or("作品 ID 缺失")?;
    let title = safe_title(info["title"].as_str().unwrap_or("TikTok 视频"));
    let dir = workspace.join(format!("TikTok_{title}_[{id}]"));
    fs::create_dir_all(&dir).map_err(|_| "无法写入下载目录")?;
    let media = dir.join("视频.mp4");
    let address = info["formats"][0]["url"]
        .as_str()
        .ok_or("备用下载地址缺失")?;
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    tiktok_free::transfer(provider, source, address, &media, |bytes, total| {
        cancelled(state, &request.job_id)?;
        if last.elapsed() >= Duration::from_millis(250) {
            let percent = total
                .filter(|n| *n > 0)
                .map_or(0.0, |n| bytes as f64 * 99.0 / n as f64);
            emit_progress(
                app,
                &request.job_id,
                "downloading",
                percent.min(99.0),
                format!(
                    "{}：已下载 {:.1} MB",
                    provider.name(),
                    bytes as f64 / 1048576.0
                ),
            );
            last = std::time::Instant::now();
        }
        Ok(())
    })?;
    let duration = verify_video_info(app, &media, info["duration"].as_f64())?;
    info["duration"] = duration.into();
    if request.options.include_thumbnail {
        let cover = dir.join("封面.jpg");
        // Prefer the platform cover; if absent/unavailable use an actual video frame.
        let mut cover_bytes = None;
        if let Some(url) = info["thumbnail"].as_str().filter(|u| tiktok_media_url(u)) {
            let preview = inline_thumbnail(preview_from_payload(
                source.into(),
                serde_json::json!({"thumbnail":url}),
            ));
            cover_bytes = preview.thumbnail.and_then(|s| {
                s.strip_prefix("data:image/jpeg;base64,")
                    .and_then(|s| BASE64.decode(s).ok())
            });
        }
        if let Some(bytes) = cover_bytes {
            fs::write(&cover, bytes).map_err(|_| "封面保存失败")?;
        } else {
            let mut command =
                Command::new(find_tool(app, "ffmpeg.exe").ok_or("媒体处理引擎尚未就绪")?);
            command
                .args(["-v", "error", "-i"])
                .arg(&media)
                .args(["-frames:v", "1", "-update", "1", "-y"])
                .arg(&cover);
            run_streaming(app, state, &request.job_id, "downloading", &mut command)?;
        }
    }
    // Only official subtitle metadata survives; resolver HTML cannot inject headers/cookies.
    info["webpage_url"] = source.into();
    fs::write(
        dir.join("视频.info.json"),
        serde_json::to_vec(info).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "视频信息保存失败")?;
    Ok(media)
}

// Native acceptance harness: same preview/download code, no UI or Feishu worker.
// Uses an isolated identity unless explicitly asked to reuse the application's login.
// Experimental emulation is test-only, never enabled in a distributed app.
#[cfg(feature = "team-smoke")]
pub(super) fn configure_smoke_mobile<S: Read + Write>(
    socket: &mut tungstenite::WebSocket<S>,
) -> Result<(), String> {
    if std::env::var("PAOLIANG_SMOKE_MOBILE").as_deref() != Ok("1") {
        return Ok(());
    }
    let version = cdp_call(socket, 802, "Browser.getVersion", serde_json::json!({}))?;
    let full_version = version["result"]["product"]
        .as_str()
        .and_then(|v| v.split('/').nth(1))
        .ok_or("test browser did not report its version")?;
    let major = full_version.split('.').next().unwrap_or(full_version);
    cdp_call(
        socket,
        803,
        "Emulation.setUserAgentOverride",
        serde_json::json!({
            "userAgent":format!("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full_version} Mobile Safari/537.36"),
            "platform":"Linux armv8l",
            "userAgentMetadata":{
                "brands":[{"brand":"Chromium","version":major}],
                "fullVersionList":[{"brand":"Chromium","version":full_version}],
                "platform":"Android","platformVersion":"13.0.0",
                "architecture":"arm","model":"Pixel 7","mobile":true
            }
        }),
    )?;
    cdp_call(
        socket,
        804,
        "Emulation.setDeviceMetricsOverride",
        serde_json::json!({
            "width":412,"height":915,"deviceScaleFactor":2.625,"mobile":true
        }),
    )?;
    cdp_call(
        socket,
        805,
        "Emulation.setTouchEmulationEnabled",
        serde_json::json!({
            "enabled":true,"maxTouchPoints":5
        }),
    )?;
    println!("PLAYER_TEST mobile browser emulation enabled (not a native TikTok app)");
    Ok(())
}

#[cfg(feature = "team-smoke")]
pub fn run_smoke() {
    let mut context = tauri::generate_context!();
    let use_app_login = std::env::var("PAOLIANG_SMOKE_USE_APP_LOGIN").as_deref() == Ok("1");
    if !use_app_login {
        context.config_mut().identifier = format!("org.yinglian.tiktok-smoke-{}", process::id());
    }
    context.config_mut().app.windows.clear();
    let exit = Arc::new(std::sync::atomic::AtomicI32::new(3));
    let final_exit = exit.clone();
    tauri::Builder::default()
        .setup(move |app| {
            network::init(app.handle())?;
            let app = app.handle().clone();
            thread::spawn(move || {
                let result = (|| -> Result<(), String> {
                    if use_app_login {
                        accounts::sync(&app, true)?;
                        if !accounts::has_session(&app, "tiktok") {
                            return Err(
                                "工坊尚未保存 TikTok 登录，请关闭官方登录窗口并刷新账号状态".into(),
                            );
                        }
                        println!("ACCOUNT TikTok app-owned session detected (no values logged)");
                    }
                    let source =
                        std::env::var("PAOLIANG_SMOKE_VIDEO").map_err(|_| "missing test URL")?;
                    if std::env::var("PAOLIANG_SMOKE_PLAYER_DIAGNOSTIC").as_deref() == Ok("1") {
                        let id = tiktok_video_id(&source).ok_or("missing video ID")?;
                        let player = format!(
                            "https://www.tiktok.com/player/v1/{id}?autoplay=1&muted=1&loop=0"
                        );
                        let (media, _) = tiktok_media_with_edge(&app, &source, &player)?;
                        println!(
                            "PLAYER_ONLY_ADDRESS_FOUND host={} (not a download verification)",
                            Url::parse(&media).unwrap().host_str().unwrap_or_default()
                        );
                        return Ok(());
                    }
                    let root = PathBuf::from(
                        std::env::var("PAOLIANG_SMOKE_OUTPUT")
                            .map_err(|_| "missing test output")?,
                    );
                    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
                    let tool = find_tool(&app, "yt-dlp.exe").ok_or("missing engine")?;
                    let preview = inspect_item(&app, &tool, source.clone());
                    println!(
                        "PREVIEW error={:?} duration={:?} cover={}",
                        preview.error,
                        preview.duration,
                        preview.thumbnail.is_some()
                    );
                    let state = RuntimeState {
                        processes: Arc::default(),
                        cancelled: Arc::default(),
                        cancel_model: Arc::new(AtomicBool::new(false)),
                        model_root: Arc::new(RwLock::new(root.join("unused-models"))),
                        model_server_url: String::new(),
                    };
                    let result = execute_download(
                        app.clone(),
                        state,
                        DownloadRequest {
                            job_id: uuid::Uuid::new_v4().to_string(),
                            url: source,
                            options: DownloadOptions {
                                download_dir: root.to_string_lossy().into(),
                                category: None,
                                quality: "1080".into(),
                                include_video: true,
                                include_thumbnail: true,
                                include_original_subtitle: false,
                                transcript_mode: "none".into(),
                                language: "auto".into(),
                                model_id: "small".into(),
                            },
                        },
                    )?;
                    let video = PathBuf::from(&result.output_dir).join("视频.mp4");
                    verify_video(&app, &video)?;
                    let mut probe =
                        Command::new(find_tool(&app, "ffprobe.exe").ok_or("missing probe")?);
                    probe
                        .args([
                            "-v",
                            "error",
                            "-show_entries",
                            "stream=codec_type,codec_name,width,height:format=duration,size",
                            "-of",
                            "json",
                        ])
                        .arg(&video);
                    let metadata = live::capture(
                        &mut probe,
                        Duration::from_secs(20),
                        &AtomicBool::new(false),
                    )?;
                    let metadata: Value =
                        serde_json::from_slice(&metadata.stdout).map_err(|e| e.to_string())?;
                    let actual = metadata["format"]["duration"]
                        .as_str()
                        .and_then(|s| s.parse().ok());
                    if !duration_matches(preview.duration, actual) {
                        return Err("acceptance duration differs from original preview".into());
                    }
                    if !PathBuf::from(&result.output_dir).join("封面.jpg").is_file() {
                        return Err("acceptance cover missing".into());
                    }
                    if !metadata["streams"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|item| item["codec_type"] == "audio"))
                    {
                        return Err("acceptance sample missing audio".into());
                    }
                    let mut decode =
                        Command::new(find_tool(&app, "ffmpeg.exe").ok_or("missing ffmpeg")?);
                    decode
                        .args(["-v", "error", "-xerror", "-i"])
                        .arg(&video)
                        .args(["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]);
                    let decoded = live::capture(
                        &mut decode,
                        Duration::from_secs(90),
                        &AtomicBool::new(false),
                    )?;
                    if !decoded.status.success() {
                        return Err(format!(
                            "full decode failed: {}",
                            String::from_utf8_lossy(&decoded.stderr)
                        ));
                    }
                    fs::write(
                        root.join("verified-media.json"),
                        serde_json::to_vec_pretty(&metadata).unwrap(),
                    )
                    .map_err(|e| e.to_string())?;
                    println!(
                        "DOWNLOAD_VERIFIED output={} metadata={metadata}",
                        result.output_dir
                    );
                    Ok(())
                })();
                let code = if let Err(error) = result {
                    println!("TIKTOK_SMOKE_FAIL {error}");
                    1
                } else {
                    0
                };
                exit.store(code, Ordering::SeqCst);
                app.exit(code);
            });
            Ok(())
        })
        .run(context)
        .expect("TikTok acceptance application");
    process::exit(final_exit.load(Ordering::SeqCst));
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "7613247269298523399";
    #[test]
    fn browser_cookie_export_never_broadens_scope_or_includes_other_platforms() {
        let jar = playback_cookie_jar(&serde_json::json!([
            {"domain":"www.tiktok.com","name":"sessionid","value":"unit-value","path":"/player/","secure":true,"httpOnly":true,"expires":-1},
            {"domain":".tiktok.com","name":"ttwid","value":"unit-value","path":"/","secure":false,"expires":100},
            {"domain":".douyin.com","name":"foreign","value":"unit-value","path":"/"},
            {"domain":".tiktok.com.evil.test","name":"foreign","value":"unit-value","path":"/"}
        ]));
        assert!(jar.contains("#HttpOnly_www.tiktok.com\tFALSE\t/player/\tTRUE\t0\tsessionid"));
        assert!(jar.contains(".tiktok.com\tTRUE\t/\tFALSE\t100\tttwid"));
        assert!(!jar.contains("foreign"));
    }
    #[test]
    fn player_network_media_requires_matching_frame_video_type_and_safe_host() {
        let mut event = serde_json::json!({"method":"Network.responseReceived","params":{"frameId":"player","response":{
            "status":206,"mimeType":"video/mp4","url":"https://v16m.tiktokcdn-us.com/video.mp4"}}});
        assert!(media_from_event(&event, "player").is_some());
        assert!(media_from_event(&event, "other").is_none());
        event["params"]["response"]["mimeType"] = "audio/mpeg".into();
        assert!(media_from_event(&event, "player").is_none());
        event["params"]["response"]["mimeType"] = "video/mp4".into();
        event["params"]["response"]["url"] = "https://untrusted.example/video".into();
        assert!(media_from_event(&event, "player").is_none());
        event["params"]["response"]["url"] =
            "https://www.tiktok.com/aweme/v1/play/?video_id=recommendation".into();
        assert!(media_from_event(&event, "player").is_none());
    }
    fn playable() -> Resolved {
        Resolved {
            info: media_info(
                ID,
                "https://www.tiktok.com/",
                Some("https://v19.tiktokcdn.com/video.mp4"),
                "https://www.tiktok.com/",
            ),
            cookies: None,
        }
    }
    #[test]
    fn embed_503_does_not_block_video_fallback() {
        let mut called = Vec::new();
        let result = resolve(ID, "source", true, false, |route| {
            called.push(route);
            if route == Route::Embed {
                Err("HTTP 503".into())
            } else {
                Ok(playable())
            }
        })
        .unwrap();
        assert!(has_video(&result.info));
        assert_eq!(called, [Route::Embed, Route::Extractor]);
    }
    #[test]
    fn audio_only_is_not_success_and_keeps_metadata_for_player() {
        let result = resolve(ID, "source", true, false, |route| match route {
            Route::Embed => Err("error decoding response body".into()),
            Route::Extractor => Ok(Resolved { info: serde_json::json!({"id": ID, "title":"原始标题", "thumbnail":"cover", "ext":"mp3", "vcodec":"none", "url":"audio.mp3", "formats":[{"url":"audio.mp3","vcodec":"none"}]}), cookies:None }),
            Route::Public | Route::MusicalDown | Route::SssTik => Err("HTTP 403".into()),
            Route::Player => Ok(playable()),
        }).unwrap();
        assert_eq!(result.info["title"], "原始标题");
        assert_eq!(result.info["thumbnail"], "cover");
        assert!(result.info.get("ext").is_none());
        assert!(result.info.get("url").is_none());
        assert!(result.info.get("vcodec").is_none());
        assert!(has_video(&result.info));
    }
    #[test]
    fn normal_embed_does_not_call_other_routes() {
        let result = resolve(ID, "source", true, false, |route| {
            assert_eq!(route, Route::Embed);
            Ok(playable())
        })
        .unwrap();
        assert!(has_video(&result.info));
    }
    #[test]
    fn repeated_http_failures_have_a_finite_attempt_count() {
        for (status, count) in [(503, 2), (403, 1), (429, 1)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                for _ in 0..count {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let _ = socket.read(&mut [0; 4096]);
                    write!(
                        socket,
                        "HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                }
            });
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .build()
                .unwrap();
            assert!(embed_html(&client, &format!("http://{address}"))
                .unwrap_err()
                .contains(&status.to_string()));
            server.join().unwrap();
        }
    }
    #[test]
    fn saved_login_uses_authenticated_routes_before_anonymous_embed() {
        let mut called = Vec::new();
        let result = resolve(ID, "source", true, true, |route| {
            called.push(route);
            match route {
                Route::Extractor => Ok(Resolved {
                    info: serde_json::json!({"id":ID,"formats":[]}),
                    cookies: None,
                }),
                Route::Embed => Err("temporary error".into()),
                Route::MusicalDown => Ok(playable()),
                _ => panic!("no further request needed"),
            }
        })
        .unwrap();
        assert!(has_video(&result.info));
        assert_eq!(called, [Route::Extractor, Route::Embed, Route::MusicalDown]);
        let mut called = Vec::new();
        resolve(ID, "source", false, true, |route| {
            called.push(route);
            if route == Route::Extractor {
                Err("temporary error".into())
            } else {
                Ok(playable())
            }
        })
        .unwrap();
        assert_eq!(called, [Route::Extractor, Route::Embed]);
    }
    #[test]
    fn rate_limit_stops_other_requests() {
        let mut count = 0;
        let result = resolve(ID, "source", true, false, |_| {
            count += 1;
            Err("HTTP 429 Too Many Requests".into())
        });
        assert_eq!(count, 1);
        assert!(result.err().unwrap().contains("已停止"));
    }
    #[test]
    fn provider_failure_tries_next_without_repeating_completed_routes() {
        let mut called = Vec::new();
        let result = resolve_remaining(
            ID,
            "source",
            true,
            false,
            &[Route::Embed, Route::Extractor, Route::MusicalDown],
            Some(serde_json::json!({"title":"original", "duration":54})),
            |route| {
                called.push(route);
                if route == Route::Public {
                    Err("TikWM HTTP 429".into())
                } else {
                    Ok(playable())
                }
            },
        )
        .unwrap();
        assert_eq!(called, [Route::Public, Route::SssTik]);
        assert_eq!(result.info["duration"], 54);
        assert_eq!(result.info["title"], "original");
    }
    #[test]
    fn cancelled_fallback_stops_and_duration_rejects_recommendations() {
        let mut count = 0;
        assert_eq!(
            resolve(ID, "source", true, false, |_| {
                count += 1;
                Err("任务已取消".into())
            })
            .err()
            .unwrap(),
            "任务已取消"
        );
        assert_eq!(count, 1);
        assert!(duration_matches(Some(54.0), Some(54.3667)));
        assert!(!duration_matches(Some(54.0), Some(6.3)));
        assert!(!duration_matches(None, Some(0.0)));
        assert!(!duration_matches(Some(54.0), None));
    }
    #[test]
    fn preview_needs_metadata_not_playback() {
        let result = resolve(ID, "source", false, false, |route| match route {
            Route::Embed => Err("503".into()),
            Route::Extractor => Ok(Resolved {
                info: serde_json::json!({"id":ID,"title":"title","formats":[]}),
                cookies: None,
            }),
            _ => panic!("preview must not start browser"),
        })
        .unwrap();
        assert_eq!(result.info["title"], "title");
    }
    #[test]
    fn wrong_video_and_total_failure_are_not_success() {
        let error = resolve(ID, "source", true, false, |_| {
            let mut value = playable();
            value.info["id"] = "other".into();
            Ok(value)
        })
        .err()
        .unwrap();
        assert!(error.contains("ID 不一致"));
        let error = resolve(ID, "source", true, false, |_| Err("HTTP 503".into()))
            .err()
            .unwrap();
        assert!(error.contains("视频解析失败"));
    }
    #[test]
    fn bounded_http_retries_cover_503_and_truncated_body() {
        for first in [
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\ntruncated",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                for response in [
                    first,
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                ] {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let _ = socket.read(&mut [0; 4096]);
                    socket.write_all(response.as_bytes()).unwrap();
                }
            });
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .build()
                .unwrap();
            assert_eq!(
                embed_html(&client, &format!("http://{address}")),
                Ok("ok".into())
            );
            server.join().unwrap();
        }
    }
}
