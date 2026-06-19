# 影链工坊

公开视频解析与服务器临时下载工具。前端使用 React + Vite，后端使用 FastAPI + yt-dlp + ffmpeg，生产环境通过 Docker Compose 运行。

## 本地运行

```bash
cd project/video-parser
docker compose up --build
```

打开 http://localhost:8080。

## VPS 一键安装

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh)
```

如果有域名：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/359073395/yt/main/project/video-parser/deploy/install.sh) --domain example.com
```

脚本也支持 `--repo <git-url>` 指定其他仓库。

## 环境变量

复制 `.env.example` 为 `.env` 后可调整：

- `PUBLIC_PORT`: 对外端口，默认 `8080`
- `MAX_CONCURRENT_DOWNLOADS`: 全局下载并发，默认 `2`
- `GUEST_DAILY_LIMIT`: 未登录访客每日下载次数，默认 `3`
- `USER_DAILY_LIMIT`: 普通用户每日下载次数，默认 `10`
- `ADMIN_USERNAME`: 默认管理员账号，默认 `admin`
- `ADMIN_PASSWORD`: 默认管理员密码，默认 `lhw111111`
- `AUTH_SECRET`: 登录 token 签名密钥，生产环境建议改成随机长字符串
- `RATE_LIMIT_PER_MINUTE`: 单 IP 每分钟提交任务数，默认 `6`
- `MAX_FILE_SIZE_MB`: 最大下载文件大小，默认 `512`
- `MAX_DURATION_SECONDS`: 最大视频时长，默认 `1800`
- `JOB_TTL_SECONDS`: 文件保留时间，默认 `3600`

## 说明

本工具只用于处理你有权处理的公开视频链接。不支持绕过 DRM、登录墙、私密内容或平台反爬限制。Shopee 与 TikTok Shop 商品页不在 v1 保证范围内。

第一版支持账号密码登录。未登录访客每天最多下载 3 个视频，普通用户每天最多下载 10 个视频；会员和管理员不限制。启动时会自动创建或更新管理员账号 `admin`，默认密码为 `lhw111111`。

批量下载当前未开放。建议在会员与队列策略稳定后再开启，避免公开站点被批量任务打满带宽和并发。

## 管理后台

管理员登录后，右上角账号菜单进入“管理后台”。后台包含：

- 总览：用户、会员、API Key、任务和缓存统计
- 用户会员：搜索用户、调整普通用户/会员/管理员、重置今日额度、启用或禁用账号
- API Key：创建给智能体或 Codex 使用的密钥，设置每日额度，启用、禁用或删除
- 任务缓存：查看当前运行时任务，清理过期缓存
- 支持平台：查看国内、国际和暂不保证的平台
- API 对接：查看接口和请求示例

## API 对接

在管理后台创建 API Key 后，智能体或 Codex 可以使用 `X-API-Key` 请求 `/api/v1/*`：

```bash
curl -X POST http://localhost:8080/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ylg_xxx" \
  -d '{"url":"https://www.douyin.com/video/..."}'
```

常用接口：

- `POST /api/v1/jobs`: 创建解析下载任务
- `GET /api/v1/jobs/{jobId}`: 查询任务状态
- `GET /api/v1/jobs/{jobId}/download`: 下载已完成文件
- `GET /api/v1/platforms`: 查询支持平台列表
- `GET /api/v1/quota`: 查询当前 API Key 今日额度
- `GET /api/v1/openapi.json`: 读取 OpenAPI 结构

## 支持平台

平台能力跟随当前安装的 `yt-dlp` extractor。已列入支持展示的平台包括：

- 国内平台：抖音、小红书、哔哩哔哩、微博、AcFun、优酷、爱奇艺、腾讯视频、百度视频、斗鱼、虎牙、QQ 音乐 MV、网易 MV
- 国际平台：YouTube、TikTok、Instagram、Facebook、X / Twitter、Vimeo、SoundCloud、Reddit、Twitch、Dailymotion、Rumble
- 尝试解析，暂不保证：快手、Shopee、TikTok Shop
