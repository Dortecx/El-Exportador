import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest


def load_searcher():
    ytmusicapi = types.ModuleType('ytmusicapi')
    ytmusicapi.YTMusic = object
    browser = types.ModuleType('ytmusicapi.auth.browser')
    browser.setup_browser = lambda *_: None
    sys.modules['ytmusicapi'] = ytmusicapi
    sys.modules['ytmusicapi.auth'] = types.ModuleType('ytmusicapi.auth')
    sys.modules['ytmusicapi.auth.browser'] = browser
    path = pathlib.Path(__file__).parents[1] / 'src' / 'ytmusic' / 'searcher.py'
    spec = importlib.util.spec_from_file_location('searcher_live_auth_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LiveAuthValidationTest(unittest.TestCase):
    def setUp(self):
        self.searcher = load_searcher()
        self.tempdir = tempfile.TemporaryDirectory()
        self.searcher.AUTH_FILE = str(pathlib.Path(self.tempdir.name) / 'ytmusic_auth.json')

    def tearDown(self):
        self.tempdir.cleanup()

    def test_missing_auth_file_returns_structured_missing_status(self):
        self.assertEqual(self.searcher.validate_auth(), {'status': 'missing', 'reason': 'missing'})

    def test_live_validation_classifies_valid_401_and_unexpected_failures_without_echoing_details(self):
        pathlib.Path(self.searcher.AUTH_FILE).write_text('{}')

        class ValidYTMusic:
            def __init__(self, _path):
                pass

            def get_library_playlists(self, limit):
                self.limit = limit
                return []

        self.searcher.YTMusic = ValidYTMusic
        self.assertEqual(self.searcher.validate_auth(), {'status': 'valid'})

        class UnauthorizedYTMusic(ValidYTMusic):
            def get_library_playlists(self, limit):
                raise RuntimeError('401 Unauthorized: secret-cookie')

        self.searcher.YTMusic = UnauthorizedYTMusic
        self.assertEqual(self.searcher.validate_auth(), {
            'status': 'invalid', 'reason': 'authentication_required'
        })

        class BrokenYTMusic(ValidYTMusic):
            def get_library_playlists(self, limit):
                raise RuntimeError('network failed: secret-cookie')

        self.searcher.YTMusic = BrokenYTMusic
        self.assertEqual(self.searcher.validate_auth(), {
            'status': 'unexpected_failure', 'reason': 'validation_failed'
        })

    def test_search_401_becomes_controlled_authentication_error(self):
        class UnauthorizedYTMusic:
            def search(self, *_args, **_kwargs):
                raise RuntimeError('401 Unauthorized')

        self.searcher.get_ytmusic_thread = lambda: UnauthorizedYTMusic()
        with self.assertRaises(self.searcher.AuthenticationRequiredError):
            self.searcher.search_tracks([{'artist': 'Artist', 'title': 'Song'}], 'playlist', False, max_workers=1)

    def test_playlist_creation_401_becomes_controlled_authentication_error(self):
        class UnauthorizedPlaylistYTMusic:
            def create_playlist(self, *_args, **_kwargs):
                raise RuntimeError('401 Unauthorized')

        match = {'videoId': 'video-id', 'title': 'Song', 'artists': [{'name': 'Artist'}]}
        self.searcher.search_with_fallback = lambda *_args, **_kwargs: iter([
            (match, 'Artist Song', 1.0, 'matched')
        ])
        self.searcher.get_ytmusic_thread = lambda: object()
        self.searcher.get_ytmusic = lambda: UnauthorizedPlaylistYTMusic()

        original_argv = self.searcher.sys.argv
        self.searcher.sys.argv = ['searcher.py', json.dumps({
            'action': 'search',
            'tracks': [{'artist': 'Artist', 'title': 'Song'}],
            'playlistName': 'playlist',
        })]
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout):
                self.searcher.main()
        finally:
            self.searcher.sys.argv = original_argv

        self.assertEqual(json.loads(stdout.getvalue().splitlines()[-1]), {
            'error': 'Authentication required', 'code': 'AUTHENTICATION_REQUIRED'
        })


if __name__ == '__main__':
    unittest.main()
