# 1.10.1 开源组件维护验收

日期：2026-10-16。范围来自本次用户请求：检查开源更新、同步兼容更新、通过软件内一键升级交付。不是对历史规划中全部功能的重新承诺。

## 依赖与运行时

- GitHub 官方 release 与 npm registry 核对版本，详细前后版本和来源见 `RELEASE-1.10.1.md`。
- `npm audit` 和 `npm audit --omit=dev` 均为 0 vulnerabilities。
- `npm run prepare:runtime` 实际下载并校验锁定的 yt-dlp、FFmpeg、Whisper 文件；生成 23 个运行时文件的大小与 SHA-256。锁位于 `scripts/runtime-lock.json`，生成记录位于 `src-tauri/resources/bin/runtime-manifest.json`。
- yt-dlp 探测输出 `2026.08.19`；FFmpeg 为 `N-127564-g3c92f003c7`；官方 Whisper b5454 CLI 可启动。
- 下载期间一次不完整/混合缓存未通过锁定哈希，已换成完整、校验一致的文件后才打包。失败缓存不作为发布资源。

## 自动回归

- `npm test -- --run`：14 文件，73 项通过。
- `npm run test:runtime`：4 项通过，覆盖错误缓存替换、成功缓存复用、损坏响应/HTTP 错误保留旧文件、拒绝缺失哈希。
- `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`：76 项通过、1 项忽略；包含飞书去重分类、凭据保护、记录删除保留素材、代理及 FFmpeg 录制停止等回归。
- `python qa/test_tiktok_live_plugin.py`（QA 专用 yt-dlp 2026.08.19）：12 项通过。离线响应回归不等于当前直播平台全量可用。
- `npm run build:web`：TypeScript 检查与 Vite 生产构建通过。

## 媒体引擎实测

使用此前取得的公开印尼带货短视频作为本地固定输入，避免把网络或账号状态混入引擎兼容性测试。

- 新 FFmpeg 完整解码视频退出 0，并提取 16 kHz 单声道 WAV，338876 字节。
- 打包目录中的新 Whisper CLI 使用原有 Small 模型识别约 10.6 秒音频，13.701 秒完成，退出 0，生成 4 段印尼语 SRT。
- SRT SHA-256：`57d1e0359562414f53d1f49519b89277a1f29c3a19c0b7f5c6e5b4ad7030ecef`。
- 识别结果包含原视频 herbal tea / 半价 / 黄色购物车等口播内容，但仍有拼写误识别，不作为准确率基准。

## 真实本地翻译

通过隔离标识的原生 Tauri/WebView2 窗口运行 `qa/translation-smoke.html`。模型服务只监听本机，读取已有 M2M100 q8 文件；未重新下载模型、未调用云端 AI、未读取正式账号或飞书配置。

开发 Worker 和生产构建 Worker `translation-worker-D-DR45Jn.js` 均完成英语 2 句、印尼语 2 句到中文的真实生成，数量一致且非空。不是模拟翻译返回值。

| 输入 | 实际输出 |
| --- | --- |
| This sunscreen feels light on the skin. | 这种阳光能在皮肤上感觉到光。 |
| Choose your favorite color and order today. | 今天选择您最喜欢的颜色和订单。 |
| Produk ini ringan dan mudah digunakan. | 产品很轻,易于使用。 |
| Pilih warna favoritmu dan pesan sekarang. | 选择您最喜欢的颜色,并立即发送。 |

结论：新引擎与旧模型加载、运行兼容；**商品词和下单语义存在明显误译，质量未达到免人工复核水平**。没有把功能兼容通过写成翻译准确性通过。

## 升级兼容边界

- 回归测试固定原应用 identifier、主程序名、更新签名公钥、工作台更新 URL、currentUser 安装模式；配置/账号/模型格式未修改。
- 新增代理传递、更新错误处理、版本一致性、公开安装包 URL/签名字段及旧通道隔离检查。
- 本机原安装仍为 1.10.0，本轮尚未覆盖用户正式安装；不把静态兼容与打包测试说成实际原地升级实测。
- 发布流程只生成 draft，随后校验真正的 GitHub 签名安装包、签名篡改负例、两个更新通道，再公开发布。未签名本地候选包不用于公开更新。

## 未重新验证或未包含

- 四个平台实时在线下载、长时间直播录制、两员工两电脑和所有第三方 AI API。
- yt-dlp 仍是同一稳定版，不声称平台风控/挂商品/地区访问限制已修复。
- 不更换用户模型权重、不迁移旧独立 1.1.8 数据、不重建飞书机器人。
- 不把本机用户名、Cookie、Key、配对凭据、模型权重、视频素材放入仓库或安装包。
