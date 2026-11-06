"""Douyin web-detail compatibility for the pinned yt-dlp release.

Protocol reference: yt-dlp PR #17826, commit
728fe46fbaa97d6f03efcaf9e766d4db63338b8d (viking1304, Unlicense),
https://github.com/yt-dlp/yt-dlp/pull/17826
The upstream stable release has not incorporated this repair yet.
Only official Douyin endpoints receive the platform-scoped session.
"""
import hashlib
import json
import time
import urllib.parse
import uuid

from yt_dlp.extractor.tiktok import DouyinIE
from yt_dlp.utils import ExtractorError

__all__ = []


class _YingLianDouyinIE(DouyinIE, plugin_name='yinglian_web_detail_1'):
    _SIGNING_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'
    _UIFID_NAMES = ('uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP')

    def _web_session(self, video_id):
        cookies = self._get_cookies(self._WEBPAGE_HOST)
        if not cookies.get('ttwid'):
            self._request_webpage(
                self._WEBPAGE_HOST + 'ttwid/register', video_id,
                data=json.dumps({'aid': 6383, 'service': 'www.douyin.com'}).encode(),
                headers={'Content-Type': 'application/json'})
            if not self._get_cookies(self._WEBPAGE_HOST).get('ttwid'):
                raise ExtractorError('抖音未返回可用的网页会话，请在官方页面完成验证后重试', expected=True)
        if not self._get_cookies(self._WEBPAGE_HOST).get('passport_csrf_token'):
            self._set_cookie('.douyin.com', 'passport_csrf_token', uuid.uuid4().hex)
        cookies = self._get_cookies(self._WEBPAGE_HOST)
        for name in self._UIFID_NAMES:
            if cookies.get(name) and cookies[name].value:
                return cookies[name].value
        response = self._request_webpage(self._WEBPAGE_HOST, video_id)
        uifid = response.headers.get('x-tt-trace-host')
        if not uifid:
            raise ExtractorError('抖音未返回网页请求标识，请在官方页面完成验证后重试', expected=True)
        return uifid

    def _detail_query(self, video_id, uifid):
        timestamp = str(int(time.time()))
        query = {'aweme_id': video_id, 'aid': 6383, 'uifid': uifid, 'timestamp': timestamp}
        encoded = urllib.parse.urlencode(query)
        digest = hashlib.md5(f'{uifid}_{timestamp}_{self._SIGNING_SALT}_{encoded}'.encode()).hexdigest()
        return {**query, 'x-secsdk-web-signature': digest}

    def _real_extract(self, url):
        video_id = self._match_id(url)
        uifid = self._web_session(video_id)
        # Keep HTTP errors intact: 403/429/network failure is not proof that
        # an existing login expired. Do not retry or relabel it as missing login.
        payload = self._download_json(
            self._WEBPAGE_HOST + 'aweme/v1/web/aweme/detail/', video_id,
            query=self._detail_query(video_id, uifid),
            headers={'Referer': self._WEBPAGE_HOST})
        detail = payload.get('aweme_detail') if isinstance(payload, dict) else None
        if not isinstance(detail, dict) or not detail:
            raise ExtractorError('抖音未返回该作品，可能已删除或受账号权限限制', expected=True)
        if str(detail.get('aweme_id')) != video_id:
            raise ExtractorError('抖音返回的作品编号不匹配，未继续下载', expected=True)
        info = self._parse_aweme_video_app(detail)
        info['http_headers'] = {**info.get('http_headers', {}), 'Referer': self._WEBPAGE_HOST}
        return info
