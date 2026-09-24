# Third-party notices

- `yt-dlp` — The Unlicense — https://github.com/yt-dlp/yt-dlp
- `FFmpeg` Windows build by BtbN — LGPL shared build — https://github.com/BtbN/FFmpeg-Builds
- `whisper.cpp` — MIT — https://github.com/ggml-org/whisper.cpp
- OpenAI Whisper model weights — MIT — https://github.com/openai/whisper
- Transformers.js — Apache-2.0 — https://github.com/huggingface/transformers.js
- M2M100 418M model — MIT — https://huggingface.co/facebook/m2m100_418M

M2M100 is enabled only as an optional, locally cached translation model and is not included in the installer.

## TikTok live compatibility plugin

`resources/bin/yt-dlp-plugins/yinglian` uses yt-dlp's documented extractor-plugin
override mechanism: https://github.com/yt-dlp/yt-dlp#plugins.
It retains confirmed FLV streams when TikTok's optional HLS endpoint fails and
distinguishes unavailable API responses from explicit offline status.
The public user-room endpoint was verified against the TikTokLive project:
https://github.com/isaackogan/TikTokLive/blob/master/TikTokLive/client/web/routes/fetch_room_id_api.py.
No TikTokLive source, runtime, signature service, or extra browser is bundled.
The override delegates media parsing to the bundled yt-dlp extractor.

## Douyin live protocol reference

The native live-room resolver was informed by `jiji262/douyin-downloader`:
https://github.com/jiji262/douyin-downloader (MIT). Its Python runtime and application are not bundled.
The implementation uses the official room/page data and the existing FFmpeg runtime.

Copyright (c) 2026 jiji262

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Feishu app-registration protocol adaptation

The native registration implementation follows `@larksuiteoapi/node-sdk` 1.74.0,
https://github.com/larksuite/node-sdk (MIT). The Node runtime/SDK is not bundled.

Copyright (c) 2022 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
