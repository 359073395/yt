# 跑量影链工坊 1.10.1

2026-10-16 开源组件维护版（Windows x64），沿用原工作台与数据目录。

## 上游核对与同步

| 组件 | 1.10.0 基线 | 本次版本 |
| --- | --- | --- |
| yt-dlp 下载解析 | 2026.08.19 | 保留 2026.08.19，核对时仍是官方最新稳定版 |
| whisper.cpp 语音识别 | 1.9.3 / b4938 | 1.9.5 / b5454 官方 Windows CPU 构建 |
| FFmpeg / ffprobe 媒体处理 | N-126826-gc0e8b139fd | N-127564-g3c92f003c7，2026-10-15 LGPL shared 构建 |
| Transformers.js 本地翻译 | 3.8.1 | 4.3.1 |
| Tauri 原生框架 / 前端 API | 2.11.5 / 2.11.1 | 2.12.4 / 2.12.4 |
| Tauri 自动更新 | 2.11.0 | 2.14.0 |
| React / React DOM | 19.2.8 | 19.3.1 |
| Vite / Vitest | 7.3.6 / 3.2.7 | 7.3.7 / 5.0.5 |

只使用经测试的稳定依赖，没有切到 Tauri 3 alpha。TypeScript、Vite、图标库的跨大版本改造不在本次维护范围。

## 修复

- 修复打包脚本仅凭“文件已存在”就复用旧引擎的问题。每个上游下载锁定版本和 SHA-256，错误下载不替换旧文件，打包记录每个引擎文件的实际哈希。
- 兼容 Transformers.js 4 的本地分词器加载变化。原有 M2M100 q8 翻译模型继续使用，不强制重新下载，也不把文案发送给云端。
- 更新检查和安装包下载支持应用配置的本机代理；未传入代理时使用更新引擎的默认网络配置。保持进度提示、签名校验和安装重启流程。
- 分离更新检查与安装包下载超时：检查 30 秒，完整安装包下载 15 分钟，避免检查用的短超时中断大文件。
- 修复发布流程只允许 1.10.0 的硬编码，按对应版本生成公开下载地址，仍保留旧版独立更新通道。
- 更新相关安全依赖，并移除 Windows NSIS 更新不需要的 ZIP 解包依赖。

## 一键升级

当前 1.10.0 工作台：点击右上角“更新”→“立即升级”。更新包先下载并验证原签名公钥，再覆盖安装。
不需要先卸载，不需要重新创建飞书机器人。应用标识、主程序名称、模型位置和用户数据格式保持不变。
升级前请结束下载、识别、翻译与直播录制；不要在任务处理中强制安装。

旧 1.1.8 稳定版属于另一套数据和更新通道，不会被静默迁移为新工作台。Windows 安装包有 Tauri 更新签名，但没有 Authenticode 发布者证书。

## 验证范围与限制

本轮验证依赖审计、前后端回归、上游文件哈希、原有模型兼容、英语/印尼语实际中文输出、印尼口播转录和媒体完整解码；具体证据见 `qa/release-1.10.1.md`。

- 轻量 M2M100 模型对商品词、口语和“下单”等表达仍有误译；引擎兼容通过不等于翻译质量全面提升，商务文案需复核。
- yt-dlp 稳定版未变化，不宣称 TikTok 挂商品短视频、地区限制或平台风控已全部解决。
- 本轮不冒充全平台、双员工双电脑、长时直播、所有模型/API 服务的全量重新验收；原有功能范围未扩张。
- 不包含用户 Cookie、API Key、飞书配对凭据、模型权重或视频素材。

上游来源：[yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)、[Whisper 1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5)、[Whisper Windows b5454](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454)、[FFmpeg 构建](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-15-13-03)、[Transformers.js 4.3.1](https://github.com/huggingface/transformers.js/releases/tag/4.3.1)、[Tauri updater 2.14.0](https://github.com/tauri-apps/plugins-workspace/releases/tag/updater-v2.14.0)。
