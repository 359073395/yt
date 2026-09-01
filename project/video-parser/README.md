# 影链工坊 2.5 公开版

影链工坊是基于官方 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的自托管 Web 视频下载与文案工具。2.5 采用“免安装、免登录、只处理公开内容”的产品方向：用户粘贴链接即可使用，不需要安装浏览器助手、注册本站账号、扫码或导入 Cookie。

## 三个下载入口

- 单条解析：粘贴一条作品链接，查看真实画质、封面、字幕和公开文案后再下载。
- 多链接批量：一次粘贴最多 50 条作品链接，可来自不同平台、不同博主；带中文的分享文案会自动提取并去重链接。
- 博主主页：一次粘贴一个博主主页、频道或播放列表，可读取最近 20、50、100 个，或自动翻页读取全部公开作品（单次最多 500 个视频）。

“多链接批量”不会把链接当成主页；“博主主页”也不会混入其他博主的推荐视频。

## 2.5 功能

- 免安装、免注册、免平台登录，网页下载不限次数
- 抖音公开内容：服务器自动建立匿名访客会话，通过公开页面签名接口读取作品和主页分页
- TikTok 公开内容：单条优先使用官方 Embed v2；主页通过官方嵌入页解析创作者 secUid，再交给 yt-dlp 读取公开列表
- YouTube、哔哩哔哩、Instagram、Facebook、X / Twitter、Vimeo、SoundCloud 等公开链接
- 视频格式与真实分辨率选择；平台只返回一个格式时不伪造清晰度
- MP3、M4A、OPUS、FLAC、WAV 音频提取
- 原生字幕下载、TXT/SRT/VTT 文案导出、faster-whisper 本地语音识别
- 原始封面下载、作品标题/描述/话题导出
- 视频、封面、文案和字幕可自动打包为 ZIP
- SQLite 任务历史、SSE 实时进度、取消、重试和 15 分钟签名下载链接
- 非 root、只读容器根文件系统、移除 Linux capabilities

## Windows 桌面版

不想维护服务器时可使用轻量的 [影链工坊 Desktop](desktop/README.md)：无需安装浏览器助手，支持单条、多链接批量和博主主页下载，并可把视频、封面、平台文案、字幕、AI 语音识别与中文翻译统一保存到用户选择的目录。语音和翻译模型按需下载，模型目录也可单独选择。

正式安装包在 [GitHub Releases](https://github.com/359073395/yt/releases) 发布；Windows 10/11 安装后直接运行。

## 一键安装或更新

首次安装并指定端口：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh) --port 9890
```

已经安装时直接更新：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh)
```

安装脚本会保留现有 `.env`、Docker 数据卷、数据库和下载历史，拉取固定的 2.5.0 镜像并验证精确版本。新容器健康检查失败时会自动回滚上一镜像；镜像尚未生成时会回退为服务器源码构建。

配置文件位置：

```text
/opt/video-parser/project/video-parser/.env
```

## 从旧版升级

2.5.0 继续使用原来的 `/data/video-parser.sqlite3` 和 Docker volume，不需要迁移任务历史。

- 页面不再显示账号、后台、平台登录、二维码、Cookie 导入或浏览器助手。
- 公开下载接口不再读取用户 Cookie。
- 旧版本保存在数据卷中的账号或 Cookie 记录不会在升级时主动删除，但 2.5 公开版不会使用或暴露它们。
- 不要使用 `docker compose down --volumes` 更新，否则会删除数据库和历史文件。

## 本地构建

```bash
cd project/video-parser
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

打开 http://localhost:8080。

## AI 语音转写

选择“字幕 / 文案”，使用“自动”或“AI 识别视频语音”。自动模式优先使用平台原生字幕，没有字幕时再运行 faster-whisper。

- 默认模型为 `base`，CPU 使用 `int8`。
- 模型首次使用时下载到 `/data/cache/whisper`，后续更新容器不会重复下载。
- 视频越长，CPU 转写时间越长。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PUBLIC_PORT` | `8080` | 对外访问端口 |
| `VIDEO_PARSER_IMAGE` | `ghcr.io/359073395/video-parser:latest` | 部署镜像 |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | 全局并发任务数 |
| `MAX_FILE_SIZE_MB` | `512` | 单文件上限 |
| `MAX_DURATION_SECONDS` | `1800` | 视频时长上限 |
| `JOB_TTL_SECONDS` | `3600` | 完成文件保留时间 |
| `REQUEST_TIMEOUT_SECONDS` | `20` | 外部请求超时 |
| `METADATA_TIMEOUT_SECONDS` | `45` | 链接解析超时 |
| `CHROMIUM_PATH` | 自动探测 | 抖音匿名访客会话使用的 Chromium 路径 |
| `TRANSCRIPTION_ENABLED` | `true` | 是否允许 AI 语音转写 |
| `WHISPER_MODEL` | `base` | faster-whisper 模型 |
| `WHISPER_DEVICE` | `cpu` | `cpu`、`cuda` 或 `auto` |
| `WHISPER_COMPUTE_TYPE` | `int8` | 转写量化类型 |
| `WHISPER_CPU_THREADS` | `2` | 单个转写任务线程数 |
| `TRUSTED_PROXY_HEADERS` | `false` | 仅在可信反代后开启 |

`AUTH_SECRET` 仍用于匿名浏览器任务隔离和下载链接签名；安装脚本会自动生成。

## 浏览器 API

- `POST /api/browser-session`：创建匿名浏览器会话
- `POST /api/parse`：解析单条公开作品、格式和字幕
- `POST /api/collections/inspect`：读取公开主页、频道或播放列表
- `POST /api/jobs`：创建单条下载任务
- `POST /api/jobs/batch`：创建批量任务
- `GET /api/jobs`：当前浏览器的任务历史
- `GET /api/jobs/{jobId}`：任务状态
- `GET /api/jobs/{jobId}/events`：SSE 实时进度
- `POST /api/jobs/{jobId}/cancel`：取消任务
- `POST /api/jobs/{jobId}/retry`：重试任务
- `GET /api/jobs/{jobId}/download`：下载完成文件

旧版已创建的 API Key 接口继续兼容，但网页不提供签发或管理入口。

## 支持边界

影链工坊 2.5 不绕过账号登录、验证码、DRM、付费内容、会员内容、私密内容或地区限制。实际可用性会受到平台公开页面、服务器区域和平台风控变化影响；遇到平台改版时需要更新解析引擎。

请只下载你拥有权利、已经获得授权或平台明确允许保存的内容。
