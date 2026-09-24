"""Keep confirmed TikTok FLV streams when the optional HLS endpoint fails.

Uses yt-dlp's documented extractor override; no extra runtime or service.
Only explicit offline status is reported as offline, never an HTTP/API failure.
"""
import json

from yt_dlp.extractor.tiktok import TikTokLiveIE
from yt_dlp.utils import ExtractorError, UserNotLive, int_or_none, url_or_none
from yt_dlp.utils.traversal import traverse_obj

__all__ = []


class _YingLianTikTokLiveIE(TikTokLiveIE, plugin_name='yinglian_flv_1'):
    _flv_room = None

    def _real_extract(self, url):
        self._flv_room = None
        self._room_checked = False
        uploader = self._match_valid_url(url).group('uploader')
        if uploader:
            # Public user-room endpoint also used by TikTokLive. HTML may omit
            # roomId even when the room API confirms an active stream.
            data = self._download_json(
                'https://www.tiktok.com/api-live/user/room/', uploader,
                query={'aid': '1988', 'uniqueId': uploader, 'sourceType': '54'}, fatal=False)
            user = traverse_obj(data, ('data', 'user'), expected_type=dict) or {}
            room_id = user.get('roomId')
            if (isinstance(room_id, str) and room_id.isdecimal() and int(room_id) > 0
                    and str(user.get('uniqueId', '')).casefold() == uploader.casefold()):
                url = f'https://m.tiktok.com/share/live/{room_id}/'
        try:
            return super()._real_extract(url)
        except UserNotLive:
            if self._room_checked:
                raise
            raise ExtractorError(
                'TikTok 未能确认直播间（页面缺少房间号或受访问限制），不代表主播已下播',
                expected=True) from None

    def _call_api(self, url, param, room_id, uploader, key=None):
        # Upstream calls this fallback even after extracting usable FLV formats.
        # A shop live room may have FLV only and return HTTP 400 here.
        if (url == 'https://www.tiktok.com/api/live/detail/'
                and self._flv_room == room_id):
            self.write_debug('YingLian: retaining confirmed live FLV; HLS fallback unnecessary')
            return {}

        self._room_checked = True
        payload = self._download_json(url, room_id, query={'aid': '1988', param: room_id})
        response = payload.get(key) if isinstance(payload, dict) and key else payload
        response = response if isinstance(response, dict) else {}
        status = int_or_none(response.get('status'))
        if status == 2:
            stream = response.get('stream_url')
            stream = stream if isinstance(stream, dict) else {}
            flv = stream.get('flv_pull_url') or {}
            sdk = traverse_obj(stream, ('live_core_sdk_data', 'pull_data', 'stream_data'))
            try:
                sdk = json.loads(sdk) if isinstance(sdk, str) else {}
            except ValueError:
                sdk = {}
            sdk_flv = traverse_obj(sdk, (
                'data', lambda quality, _: str(quality).lower() not in ('ao', 'audio', 'audio_only'),
                'main', 'flv', {url_or_none}))
            has_flv = url_or_none(stream.get('rtmp_pull_url')) or (
                isinstance(flv, dict) and any(
                    url_or_none(value) for quality, value in flv.items()
                    if str(quality).lower() not in ('ao', 'audio', 'audio_only'))) or sdk_flv
            if url == 'https://webcast.tiktok.com/webcast/room/info' and has_flv:
                self._flv_room = room_id
            return response
        if status == 4:
            if uploader:
                raise UserNotLive(video_id=uploader)
            raise ExtractorError('This livestream has ended', expected=True)
        raise ExtractorError(
            'TikTok 未返回有效直播状态（接口异常、网络或访问限制），不能据此判断未开播',
            expected=True)
