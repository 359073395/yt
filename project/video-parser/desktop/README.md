# 影链工坊 Desktop 1.1.1

Windows 10/11 本地视频、封面、平台文案、多语言语音识别与中文翻译工具。

采用媒体收件箱式桌面界面：粘贴后先解析为可勾选的作品列表，再统一选择清晰度、输出内容和保存位置。首次启用语音识别或中文翻译时，会明确显示模型大小与保存目录，只有用户确认后才下载。1.1.1 起支持应用内检查更新、签名校验、一键安装并自动重启。

## 设计原则

- Tauri 2 + Windows WebView2，不捆绑 Chromium。
- 所有长任务都在 Rust 后台进程或 Web Worker 中运行，界面线程不执行下载、转码或 AI 推理。
- `yt-dlp`、精简 FFmpeg 与 `whisper.cpp` 随正式安装包提供。
- Base / Small / Medium 语音模型按需下载、切换和删除。
- M2M100 中文翻译模型首次使用时由用户确认后按需缓存，不增加主安装包体积。
- 作品与模型分别选择存储位置；视频、封面、原文、字幕和翻译始终保存在同一作品文件夹。
- 登录通过独立的 Microsoft Edge 官方页面完成，会话只保存在本机应用数据目录。
- 更新包由 GitHub Actions 构建并使用 Tauri 签名；应用只安装通过内置公钥校验的新版本。

## 输出文件

```text
作者/日期_标题_[视频ID]/
├── 视频.mp4
├── 封面.jpg
├── 平台原文文案.txt
├── 字幕文案.txt 或 语音识别文案.txt
├── 语音识别字幕.srt
├── 中文翻译.txt
├── 双语文案.txt
├── 双语字幕.srt
└── 视频信息.json
```

## 本地开发

```powershell
npm install
npm run prepare:runtime
npm test
npm run build
```

`prepare:runtime` 只用于制作安装包，从上游官方发布页取得 Windows 运行组件。终端用户无需运行任何安装助手。
