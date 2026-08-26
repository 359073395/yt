# 影链工坊 2.0

基于官方 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的自托管 Web 视频下载中心。支持解析后选择画质、仅音频、字幕、实时队列、任务历史、多用户额度、API Key 和加密 Cookie 配置。

## 2.0 功能

- 先解析再下载：展示封面、标题、作者、时长、格式和预计大小
- 视频格式选择：自动最佳画质或指定 yt-dlp 格式
- 音频提取：MP3、M4A、OPUS、FLAC、WAV
- 字幕：人工字幕和自动字幕，可随视频嵌入
- 实时任务：SSE 推送进度、速度、ETA，支持取消和重试
- TikTok 分享链接：官方 oEmbed 补全作者路径，移动端 API、多浏览器指纹与解析缓存自动降级
- 持久化历史：SQLite 保存任务，服务更新或重启后仍可查看
- 临时文件：到期自动清理，下载地址使用 15 分钟签名
- 多用户：访客、普通用户、会员、管理员及每日额度
- API Key：可为智能体或其他服务配置独立额度和权限
- Cookie：管理员上传 Netscape cookies.txt，加密保存且不写入日志
- 新版引擎：`yt-dlp[default,curl-cffi]`、`yt-dlp-ejs`、Deno、FFmpeg
- 安全部署：非 root、只读容器根文件系统、移除 Linux capabilities

## 一键安装或更新

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh) --port 9890
```

已安装服务器更新时可以不传端口，脚本会保留现有 `.env`、端口、用户数据库、Cookie 和下载历史：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh)
```

脚本优先拉取 `ghcr.io/359073395/video-parser:latest`。镜像暂不可用时自动回退到源码构建；新容器健康检查失败时自动恢复上一镜像。

首次安装会随机生成 `AUTH_SECRET` 和管理员密码，并在安装结束时显示一次。配置保存在：

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

## 从 1.0 升级

2.0 继续使用原来的 `/data/video-parser.sqlite3` 和 Docker volume，不需要迁移账号、会员或 API Key。升级脚本会自动：

1. 保留 `.env` 和数据卷。
2. 将旧默认管理员密码替换为随机密码。
3. 拉取 2.0 镜像并启动健康检查。
4. 失败时回滚上一容器镜像。

不要使用 `docker compose down --volumes` 更新，否则会删除数据库和历史文件。

## Cookie 配置

管理员登录后进入“管理后台 → Cookie 配置”，上传浏览器扩展导出的 Netscape `cookies.txt`。

- 配置名称使用 `default` 时，所有没有指定配置的任务自动使用。
- Cookie 使用由 `AUTH_SECRET` 派生的密钥加密保存。
- 更改 `AUTH_SECRET` 后需要重新上传 Cookie。
- 只应使用专用的低权限平台账号，不要上传主账号 Cookie。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PUBLIC_PORT` | `8080` | 对外访问端口 |
| `VIDEO_PARSER_IMAGE` | `ghcr.io/359073395/video-parser:latest` | 部署镜像 |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | 全局并发任务数 |
| `GUEST_DAILY_LIMIT` | `3` | 访客每日下载次数 |
| `USER_DAILY_LIMIT` | `10` | 普通用户每日下载次数 |
| `MAX_FILE_SIZE_MB` | `512` | 单文件上限 |
| `MAX_DURATION_SECONDS` | `1800` | 视频时长上限 |
| `JOB_TTL_SECONDS` | `3600` | 完成文件保留时间 |
| `METADATA_TIMEOUT_SECONDS` | `45` | 链接解析超时 |
| `TRUSTED_PROXY_HEADERS` | `false` | 仅在可信反代后开启 |

## API

浏览器接口：

- `POST /api/parse`：解析元数据、格式和字幕
- `POST /api/jobs`：创建下载任务
- `GET /api/jobs`：当前用户或访客历史
- `GET /api/jobs/{jobId}`：任务状态
- `GET /api/jobs/{jobId}/events`：SSE 实时状态
- `POST /api/jobs/{jobId}/cancel`：取消任务
- `POST /api/jobs/{jobId}/retry`：重试任务

API Key 接口保持兼容：

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
