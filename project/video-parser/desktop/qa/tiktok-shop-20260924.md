# TikTok live compatibility patch 1 — 2026-09-24

## Scope and cause

Installed application: 1.1.8-beta.3, bundled yt-dlp 2026.08.19.
The reported room was `https://www.tiktok.com/@rirismayani94/live`.
The official webcast room API returned status 2 and an FLV video stream, but no
HLS stream. The upstream extractor then called its optional web HLS endpoint;
HTTP 400 was converted to `UserNotLive`. The username HTML also intermittently
omitted the room ID. Neither result proves that a host is offline.

The small extractor override first checks the public user-room endpoint, verifies
the returned username, and delegates the resolved room to yt-dlp. It preserves
confirmed FLV formats instead of calling the unnecessary HLS fallback. Explicit
status 4 remains offline; HTTP errors and indeterminate statuses remain errors.

## Verification

- 12 offline regression tests passed against QA-only yt-dlp 2026.08.19.
- Covered FLV URL/map/SDK variants, audio-only exclusion, malformed SDK JSON,
  fallback retention without FLV, cross-room isolation, HTTP errors, true offline,
  unknown state, owner matching, request-state reset, and missing HTML room ID.
- Native live-recording pipeline passed using the reported username, not just a
  fixed room ID or a direct CDN URL. Local proxy: HTTP 127.0.0.1:10808.
- First recording: 12.040 seconds, 1,657,530 bytes, H.264 640x1280 + AAC.
- Final-plugin recording: 6.316 seconds, 847,621 bytes, H.264 640x1280 + AAC.
  The harness ran for approximately 13 seconds; recorded media duration is
  shorter because startup/probing and stopping are part of that elapsed time.
- Both files passed full FFmpeg decode, not just metadata probing.
- Installed executable loaded the same plugin automatically and returned
  `7689089410050820872 is_live format=rtmp-pull uploader=rirismayani94`.

Final plugin: 3,961 bytes, SHA-256
`6740A559F709B6B773D143AAA1D6D2775BF88E156970A2DECC44F4B2DFF8D422`.

QA output root:
`F:\820\yinglian-personal-qa\tiktok-shop-20260924`.
No cookies, API keys, signed media URLs, or Feishu credentials are included here.

## Local deployment

Added only:
`D:\跑量影链工坊试用版\resources\bin\yt-dlp-plugins\yinglian\yt_dlp_plugins\extractor\yinglian_tiktok_live.py`.

No main executable, app configuration, login storage, Feishu pairing, model,
Windows proxy, or existing recording was replaced. A new recording launches the
engine and picks up the plugin; an already-failed job must be retried. Version
remains beta.3 with compatibility patch 1. This is not a new published release,
and the previously built beta.3 installer does NOT contain this patch.
Future installers include the source plugin via the existing resources glob.

To roll back only this patch, remove that exact plugin directory after closing
any active recorder. Do not remove the application or its configuration.

## Shopping-linked short videos: separate, not yet closed

Upstream issue: https://github.com/yt-dlp/yt-dlp/issues/13928.
Sample: `https://www.tiktok.com/@fujiiian/video/7460373937537551634`.
Stock yt-dlp returned `format=audio video=none audio=mp3` despite exit status 0.
This reproduces an audio-only extraction case; it does not establish that every
Indonesian shopping-linked video fails or that it shares the live-room cause.

The desktop application already routes short videos through its official embed
and player resolver, not just the stock extractor. The sample's official embed
page returned HTTP 200 and the expected video ID, but a successful full desktop
download of the user's failing short-video sample is not yet verified. The user
has been asked for that URL and its error. Do not claim this live patch fixes
short-video download failures, all platforms, or long-duration reliability.
