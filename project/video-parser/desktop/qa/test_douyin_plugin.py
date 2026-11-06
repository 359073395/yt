"""Offline regressions for the pinned Douyin web-detail compatibility plugin."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from yt_dlp import YoutubeDL
from yt_dlp.utils import ExtractorError

PLUGIN = Path(__file__).resolve().parents[1] / 'src-tauri/resources/bin/yt-dlp-plugins/yinglian/yt_dlp_plugins/extractor/yinglian_douyin.py'
spec = importlib.util.spec_from_file_location('yinglian_douyin_test', PLUGIN)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
VIDEO = '6961737553342991651'
URL = 'https://www.douyin.com/video/' + VIDEO


class DouyinPluginTests(unittest.TestCase):
    def setUp(self):
        self.ie = module._YingLianDouyinIE(YoutubeDL({'quiet': True}, auto_init=False))
        for name, value in [('ttwid', 'unit-visitor'), ('passport_csrf_token', 'unit-csrf'),
                            ('UIFID', 'unit-browser-id'), ('sessionid', 'unit-auth')]:
            self.ie._set_cookie('.douyin.com', name, value)
        self.ie._request_webpage = Mock(side_effect=AssertionError('Unexpected bootstrap request'))
        self.ie._download_json = Mock(return_value={'aweme_detail': {'aweme_id': VIDEO}})
        self.ie._parse_aweme_video_app = Mock(return_value={'id': VIDEO, 'http_headers': {'Accept': '*/*'}})

    def test_signed_request_and_cdn_referer(self):
        with patch.object(module.time, 'time', return_value=1700000000):
            info = self.ie._real_extract(URL)
        args, kwargs = self.ie._download_json.call_args
        self.assertEqual(args[0], 'https://www.douyin.com/aweme/v1/web/aweme/detail/')
        self.assertEqual(kwargs['query'], {'aweme_id': VIDEO, 'aid': 6383,
            'uifid': 'unit-browser-id', 'timestamp': '1700000000',
            'x-secsdk-web-signature': 'ae15bdf75e9e2e9484d7ad289be06ac7'})
        self.assertEqual(info['http_headers'], {'Accept': '*/*', 'Referer': 'https://www.douyin.com/'})
        self.ie._request_webpage.assert_not_called()
        self.assertEqual(self.ie._get_cookies(URL)['sessionid'].value, 'unit-auth')

    def test_supported_identifier_aliases(self):
        for name in module._YingLianDouyinIE._UIFID_NAMES:
            with self.subTest(name=name):
                self.ie._get_cookies = Mock(return_value={
                    'ttwid': SimpleNamespace(value='visitor'),
                    'passport_csrf_token': SimpleNamespace(value='csrf'),
                    name: SimpleNamespace(value='identifier')})
                self.assertEqual(self.ie._web_session(VIDEO), 'identifier')

    def test_public_session_bootstrap(self):
        self.ie._downloader.cookiejar.clear()
        def request(url, *args, **kwargs):
            if url.endswith('/ttwid/register'):
                self.ie._set_cookie('.douyin.com', 'ttwid', 'new-visitor')
                return SimpleNamespace(headers={})
            return SimpleNamespace(headers={'x-tt-trace-host': 'public-identifier'})
        self.ie._request_webpage.side_effect = request
        self.ie._real_extract(URL)
        self.assertEqual(self.ie._download_json.call_args.kwargs['query']['uifid'], 'public-identifier')
        cookies = self.ie._get_cookies(URL)
        self.assertNotIn('sessionid', cookies)
        self.assertEqual(cookies['ttwid'].value, 'new-visitor')
        self.assertEqual(len(cookies['passport_csrf_token'].value), 32)

    def test_missing_public_session_stops(self):
        self.ie._downloader.cookiejar.clear()
        self.ie._request_webpage.side_effect = None
        with self.assertRaisesRegex(ExtractorError, '网页会话'):
            self.ie._real_extract(URL)
        self.ie._download_json.assert_not_called()

    def test_missing_identifier_stops(self):
        self.ie._downloader.cookiejar.clear('.douyin.com', '/', 'UIFID')
        self.ie._request_webpage.side_effect = None
        self.ie._request_webpage.return_value = SimpleNamespace(headers={})
        with self.assertRaisesRegex(ExtractorError, '网页请求标识'):
            self.ie._real_extract(URL)
        self.ie._download_json.assert_not_called()

    def test_wrong_video_is_never_downloaded(self):
        self.ie._download_json.return_value = {'aweme_detail': {'aweme_id': '999999'}}
        with self.assertRaisesRegex(ExtractorError, '作品编号不匹配'):
            self.ie._real_extract(URL)
        self.ie._parse_aweme_video_app.assert_not_called()

    def test_unavailable_content_is_not_reported_as_expired_login(self):
        for response in [{}, {'aweme_detail': None}, {'aweme_detail': []}, False]:
            with self.subTest(response=response):
                self.ie._download_json.return_value = response
                with self.assertRaisesRegex(ExtractorError, '未返回该作品'):
                    self.ie._real_extract(URL)
        self.ie._parse_aweme_video_app.assert_not_called()

    def test_http_errors_are_preserved_without_retry(self):
        for code in [403, 429]:
            with self.subTest(code=code):
                self.ie._download_json.reset_mock()
                error = ExtractorError(f'HTTP Error {code}', expected=True)
                self.ie._download_json.side_effect = error
                with self.assertRaises(ExtractorError) as raised:
                    self.ie._real_extract(URL)
                self.assertIs(raised.exception, error)
                self.ie._download_json.assert_called_once()


if __name__ == '__main__':
    unittest.main()
