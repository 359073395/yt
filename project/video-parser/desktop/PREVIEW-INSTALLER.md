# Windows 独立试用包

用途：供用户本机试用本次直播/订阅改版，不代表完整升级验收通过，不发布到稳定版自动升级渠道。

## 构建

```powershell
npm test
cargo test --locked --lib --features team-smoke --manifest-path src-tauri/Cargo.toml
npm run build:preview
```

前置：Rust/MSVC、Node、现有 `src-tauri/resources/bin` 官方下载运行库。

## 隔离与兼容

- 名称：跑量影链工坊试用版；版本：1.1.8-beta.3。
- 应用标识：`org.yinglian.desktop.preview`；主程序：`paoliang-preview.exe`。
- 独立卸载项、快捷方式、Windows WebView 数据和应用配置；默认不会覆盖旧版。
- 安装时不要主动选择旧版安装目录。用户模型、账号、API Key 和飞书配对不自动迁移；可在模型窗口选择已有模型所在目录。
- 无模型权重随包分发；识别/翻译模型按用户选择下载。
- 试用版不检查稳定更新源；不会把当前试用版降级替换成稳定版。稳定版发布门禁保持不变。
- 包内为生产编译后的本地界面，不包含 `?qa=1` 模拟桥接和示例封面，不依赖本机网页开发服务器。
- 本地试用包没有 Authenticode 发布者签名；安装时 Windows 可能提示未知发布者。不修改安全设置。

完整功能状态见 `UPGRADE-PLAN.md`；直播和订阅的真实/模拟验收边界见 `qa/automation-acceptance-20260924.md`。

beta.2 修复账号状态和浏览器会话数据库占用造成的下载失败。同一试用版标识下覆盖安装会保留 beta.1 的配对、模型位置与任务记录；不要先卸载并勾选删除应用数据。本次验收见 `qa/account-fix-20260924.md`。

beta.3 修复飞书下载含特殊空白字符的视频标题时的主进程闪退，增加本机 HTTP 代理并修复 TikTok 直播源选择及错误提示。继续使用同一试用版标识，在原试用版目录覆盖升级，不覆盖独立稳定版。验收边界和实测媒体记录见 `qa/crash-proxy-20260924.md`。
