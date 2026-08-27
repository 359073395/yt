# 影链工坊 2.3

基于官方 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的自托管 Web 视频下载与文案中心。无需注册或登录本站，网页下载不限次数；支持单条视频和创作者主页批量下载、浏览器私有 Cookie、平台原生字幕、faster-whisper AI 语音转写、TXT/SRT/VTT 文案以及封面和描述打包导出。

## 2.3 功能

- 主页批量下载：粘贴一个创作者主页、频道或播放列表链接，扫描后把其中的视频全部加入队列
- 抖音主页扫描：可粘贴带中文的整段分享文案或 `v.douyin.com` 短链，自动展开并读取作者公开视频；图文作品不会误计为视频
- 安全批量队列：单次可扫描最近 10、20 或 50 个视频，统一选择视频、音频或文案，不限下载次数
- 先解析再下载：展示封面、标题、作者、时长、真实分辨率、格式和预计大小
- 视频格式选择：自动最佳画质或指定 yt-dlp 实际返回的格式；只有一个格式时不伪造清晰度选项
- 封面：站内安全预览并支持下载原始封面
- 音频提取：MP3、M4A、OPUS、FLAC、WAV
- 字幕与文案：原生字幕优先；没有字幕时可使用 faster-whisper 在服务器本地识别语音
- 三种文案格式：TXT 纯文字、SRT 剪辑字幕、VTT 网页字幕
- 作品文案：展示并复制作品公开描述，可把标题、作者、描述、话题与来源一同导出
- 下载包：视频或音频可附带语音文案、作品描述和原始封面，自动打包为 ZIP
- 实时任务：SSE 推送进度、速度、ETA，支持取消和重试
- 抖音直连下载：主页扫描取得的多清晰度签名地址直接流式保存，避免逐个重复打开作品页
- TikTok 分享链接：优先读取官方 Embed v2 并直接流式保存；oEmbed、移动端 API、多浏览器指纹与解析缓存自动降级
- 持久化历史：SQLite 保存任务，服务更新或重启后仍可查看
- 临时文件：到期自动清理，下载地址使用 15 分钟签名
- 免账号使用：取消普通用户注册和登录，浏览器自动获得私有身份，网页下载不限次数
- 浏览器 Cookie：无需本站账号即可导入各平台 Netscape cookies.txt；按浏览器隔离、加密保存并自动过滤其他网站条目
- 扫码登录：抖音、TikTok 与哔哩哔哩使用平台官方二维码登录；单次等待 5 分钟，成功后按浏览器私有身份加密保存 Cookie
- 无站点后台：不再提供管理员账号、后台登录或管理页面；每个浏览器只管理自己的平台登录状态
- 新版引擎：`yt-dlp[default,curl-cffi]`、`yt-dlp-ejs`、Deno、FFmpeg、Chromium
- 安全部署：非 root、只读容器根文件系统、移除 Linux capabilities

## 一键安装或更新

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh) --port 9890
```

已安装服务器更新时可以不传端口，脚本会保留现有 `.env`、端口、数据库、Cookie 和下载历史：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh)
```

脚本优先拉取当前固定版本镜像。镜像暂不可用时自动回退到源码构建；新容器健康检查失败时自动恢复上一镜像。

首次安装会随机生成 `AUTH_SECRET`，用于加密浏览器私有 Cookie。配置保存在：

```text
/opt/video-parser/project/video-parser/.env
```

## 本地构建

```bash
cd project/video-parser
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

打开 http://localhost:8080。

## 从 1.0 / 2.0 升级

2.3.0 继续使用原来的 `/data/video-parser.sqlite3` 和 Docker volume，不需要迁移历史任务或 Cookie。旧用户、管理员和 API Key 记录会留在数据库中用于兼容，但 2.3 不再暴露站点登录与管理后台。升级脚本会自动：

1. 保留 `.env` 和数据卷。
2. 拉取 2.3.0 镜像，启动后验证精确版本和服务健康状态。
3. 失败时回滚上一容器镜像。

不要使用 `docker compose down --volumes` 更新，否则会删除数据库和历史文件。

## Cookie 配置

点击页面右上角“平台登录”即可使用，无需注册或登录本站。抖音、TikTok 和哔哩哔哩默认使用官方二维码扫码；YouTube、Instagram、Facebook、X 等无法把手机扫码会话安全转移给下载服务器的平台，继续使用浏览器导出的 Netscape `cookies.txt`。系统只保留所选平台及其媒体域名的条目，其他网站 Cookie 会在加密前删除。

- 系统自动为当前浏览器生成不入用户表的私有身份；不同浏览器只能读取和删除自己的 Cookie。
- 私有身份保存在浏览器站点数据中；清除站点数据后会生成新身份，之前保存的 Cookie 不会自动暴露给新身份。
- 每个扫码会话使用独立浏览器上下文，最多等待 5 分钟；成功、取消或超时后立即关闭。
- 扫码成功后的 Cookie 不受 5 分钟限制，一直保存到平台失效或你主动删除。
- 解析时会按链接平台自动选择当前浏览器的 Cookie，无需每次手工指定。
- 不接收平台账号和密码；建议使用专用低权限账号。
- Cookie 过期后重新导出并覆盖即可。
- 旧版全局管理员 Cookie 不会再降级提供给网页访客；升级不会删除原文件，如确认不需要可自行备份后清理。
- Cookie 使用由 `AUTH_SECRET` 派生的密钥加密保存；更改密钥后需要重新扫码或导入。

## AI 语音转写

选择“字幕 / 文案”，提取方式使用“自动”或“AI 识别视频语音”。自动模式会优先下载平台原生字幕，原生字幕不存在或读取失败时再运行 AI。

- 默认模型为 `base`，CPU 使用 `int8`，兼顾中文效果和小服务器内存。
- 模型在第一次 AI 任务时下载到 `/data/cache/whisper`，以后更新容器不会重复下载。
- 第一次任务会比后续任务慢；视频越长，CPU 转写时间越长。
- 可通过环境变量选择 `tiny`、`base`、`small` 等 faster-whisper 模型。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PUBLIC_PORT` | `8080` | 对外访问端口 |
| `VIDEO_PARSER_IMAGE` | `ghcr.io/359073395/video-parser:latest` | 部署镜像 |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | 全局并发任务数 |
| `MAX_FILE_SIZE_MB` | `512` | 单文件上限 |
| `MAX_DURATION_SECONDS` | `1800` | 视频时长上限 |
| `JOB_TTL_SECONDS` | `3600` | 完成文件保留时间 |
| `METADATA_TIMEOUT_SECONDS` | `45` | 链接解析超时 |
| `CHROMIUM_PATH` | 自动探测 | 抖音主页与作品页解析使用的 Chromium 路径 |
| `QR_LOGIN_TIMEOUT_SECONDS` | `300` | 单次扫码登录等待秒数，范围 60–900 |
| `QR_LOGIN_MAX_SESSIONS` | `3` | 服务器同时运行的扫码浏览器会话上限 |
| `TRANSCRIPTION_ENABLED` | `true` | 是否允许 AI 语音转写 |
| `WHISPER_MODEL` | `base` | faster-whisper 模型名称 |
| `WHISPER_DEVICE` | `cpu` | `cpu`、`cuda` 或 `auto` |
| `WHISPER_COMPUTE_TYPE` | `int8` | CPU 默认量化类型 |
| `WHISPER_CPU_THREADS` | `2` | 单个转写任务使用的 CPU 线程数 |
| `WHISPER_CACHE_DIR` | `/data/cache/whisper` | 模型持久化缓存目录 |
| `TRUSTED_PROXY_HEADERS` | `false` | 仅在可信反代后开启 |

## API

浏览器接口：

- `POST /api/parse`：解析元数据、格式和字幕
- `POST /api/browser-session`：创建或恢复当前浏览器的私有身份
- `POST /api/collections/inspect`：扫描主页、频道或播放列表中的视频
- `POST /api/jobs`：创建下载任务
- `POST /api/jobs/batch`：把扫描结果批量加入队列
- `GET /api/jobs`：当前浏览器的任务历史
- `GET /api/jobs/{jobId}`：任务状态
- `GET /api/jobs/{jobId}/events`：SSE 实时状态
- `POST /api/jobs/{jobId}/cancel`：取消任务
- `POST /api/jobs/{jobId}/retry`：重试任务
- `GET /api/cookies`：当前浏览器的私有 Cookie 配置
- `PUT /api/cookies/{platform}`：导入并加密当前浏览器的平台 Cookie
- `DELETE /api/cookies/{platform}`：删除当前浏览器的平台 Cookie

旧版已经创建的 API Key 接口保持兼容，但 2.3 不再提供网页签发和管理入口：

- `POST /api/v1/jobs`
- `GET /api/v1/jobs/{jobId}`
- `GET /api/v1/jobs/{jobId}/download`
- `GET /api/v1/platforms`
- `GET /api/v1/quota`
- `GET /api/v1/openapi.json`

创建视频任务示例：

```bash
curl -X POST http://localhost:8080/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ylg_xxx" \
  -d '{"url":"https://example.com/video","media_type":"video","format_id":"best"}'
```

## 支持范围

实际平台能力跟随当前 yt-dlp 提取器、服务器区域、平台风控和 Cookie 状态。界面中的平台列表分为“支持”和“实验性”，不承诺绕过 DRM、付费内容、私密内容或登录墙。

请只下载你拥有权利、已获得授权或平台明确允许保存的内容。
