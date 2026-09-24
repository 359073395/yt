"""Offline regression suite for the bundled yt-dlp compatibility plugin.

Run with a QA-only yt-dlp 2026.08.19 dependency on PYTHONPATH, not a global install.
"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from yt_dlp import YoutubeDL
from yt_dlp.extractor.tiktok import TikTokLiveIE
from yt_dlp.utils import ExtractorError, UserNotLive

PLUGIN = Path(__file__).resolve().parents[1] / 'src-tauri/resources/bin/yt-dlp-plugins/yinglian/yt_dlp_plugins/extractor/yinglian_tiktok_live.py'
spec = importlib.util.spec_from_file_location('yinglian_live_test', PLUGIN)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOM = '7689089410050820872'
PRIMARY = 'https://webcast.tiktok.com/webcast/room/info'
BACKUP = 'https://www.tiktok.com/api/live/detail/'
URL = 'https://www.tiktok.com/@rirismayani94/live'


class LivePluginTests(unittest.TestCase):
    def setUp(self):
        self.ie = module._YingLianTikTokLiveIE(YoutubeDL({'quiet': True}, auto_init=False))
        self.ie._download_json = Mock()

    def call(self, endpoint=PRIMARY, room=ROOM, uploader='rirismayani94'):
        return self.ie._call_api(endpoint, 'room_id', room, uploader,
                                 key='data' if endpoint == PRIMARY else 'LiveRoomInfo')

    def test_valid_flv_does_not_call_broken_backup(self):
        self.ie._download_json.return_value = {'data': {'status': 2, 'stream_url': {
            'rtmp_pull_url': 'https://cdn.example/live.flv'}}}
        self.assertEqual(self.call()['status'], 2)
        self.ie._download_json.side_effect = AssertionError('backup must not be requested')
        self.assertEqual(self.call(BACKUP), {})

    def test_map_flv_retains_video(self):
        self.ie._download_json.return_value = {'data': {'status': 2, 'stream_url': {
            'flv_pull_url': {'HD1': 'https://cdn.example/hd.flv'}}}}
        self.call()
        self.assertEqual(self.ie._flv_room, ROOM)

    def test_audio_only_is_not_treated_as_video(self):
        self.ie._download_json.return_value = {'data': {'status': 2, 'stream_url': {
            'flv_pull_url': {'AO': 'https://cdn.example/audio.flv'}}}}
        self.call()
        self.assertIsNone(self.ie._flv_room)

    def test_sdk_flv_is_preserved_but_malformed_sdk_is_not(self):
        for raw, expected in [('not-json', None), ('{"data":{"hd":{"main":{"flv":"https://cdn.example/sdk.flv"}}}}', ROOM)]:
            with self.subTest(raw=raw):
                self.ie._flv_room = None
                self.ie._download_json.return_value = {'data': {'status': 2, 'stream_url': {
                    'live_core_sdk_data': {'pull_data': {'stream_data': raw}}}}}
                self.call()
                self.assertEqual(self.ie._flv_room, expected)

    def test_backup_still_runs_without_verified_flv(self):
        self.ie._download_json.return_value = {'LiveRoomInfo': {'status': 2, 'liveUrl': 'https://cdn.example/live.m3u8'}}
        self.assertEqual(self.call(BACKUP)['status'], 2)
        self.ie._download_json.assert_called_once()

    def test_verified_room_does_not_apply_to_other_room(self):
        self.ie._flv_room = ROOM
        self.ie._download_json.side_effect = ExtractorError('HTTP 400')
        with self.assertRaisesRegex(ExtractorError, 'HTTP 400'):
            self.call(BACKUP, room='123')

    def test_transport_failure_remains_transport_failure(self):
        self.ie._download_json.side_effect = ExtractorError('HTTP 403')
        with self.assertRaisesRegex(ExtractorError, 'HTTP 403') as caught:
            self.call()
        self.assertNotIsInstance(caught.exception, UserNotLive)

    def test_explicit_offline_is_offline(self):
        self.ie._download_json.return_value = {'data': {'status': 4}}
        with self.assertRaises(UserNotLive):
            self.call()
        with self.assertRaisesRegex(ExtractorError, 'has ended'):
            self.call(uploader=None)

    def test_empty_or_invalid_state_is_not_offline(self):
        for payload in [None, {}, {'status_code': 10201}, {'data': {'status': 0}}, {'data': []}]:
            with self.subTest(payload=payload):
                self.ie._download_json.return_value = payload
                with self.assertRaises(ExtractorError) as caught:
                    self.call()
                self.assertNotIsInstance(caught.exception, UserNotLive)

    def test_user_room_resolves_same_owner_and_resets_prior_state(self):
        self.ie._flv_room = 'stale'
        self.ie._download_json.return_value = {'data': {'user': {'roomId': ROOM, 'uniqueId': 'rirismayani94'}}}
        with patch.object(TikTokLiveIE, '_real_extract', return_value={'id': ROOM}) as upstream:
            self.ie._real_extract(URL)
        upstream.assert_called_once_with(f'https://m.tiktok.com/share/live/{ROOM}/')
        self.assertIsNone(self.ie._flv_room)

    def test_wrong_owner_never_redirects_to_a_different_room(self):
        self.ie._download_json.return_value = {'data': {'user': {'roomId': ROOM, 'uniqueId': 'someone_else'}}}
        with patch.object(TikTokLiveIE, '_real_extract', return_value={}) as upstream:
            self.ie._real_extract(URL)
        upstream.assert_called_once_with(URL)

    def test_missing_html_room_id_is_not_reported_offline(self):
        self.ie._download_json.return_value = {}
        with patch.object(TikTokLiveIE, '_real_extract', side_effect=UserNotLive(video_id='rirismayani94')):
            with self.assertRaises(ExtractorError) as caught:
                self.ie._real_extract(URL)
        self.assertNotIsInstance(caught.exception, UserNotLive)


if __name__ == '__main__':
    unittest.main()
