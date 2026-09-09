import contextlib
import importlib.util
import io
import pathlib
import sys
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
    spec = importlib.util.spec_from_file_location('searcher_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeYTMusic:
    def search(self, *_args, **_kwargs):
        return [
            {'videoId': 'exact-other-artist', 'title': 'My Song', 'artists': [{'name': 'Other'}]},
            {'videoId': 'live', 'title': 'My Song (Live)', 'artists': [{'name': 'Artist'}]},
            {'videoId': 'acoustic', 'title': 'My Song (Acoustic)', 'artists': [{'name': 'Artist'}]},
            {'videoId': 'partial', 'title': 'My', 'artists': [{'name': 'Artist'}]},
            {'videoId': 'different', 'title': 'Elsewhere', 'artists': [{'name': 'Artist'}]},
            {'videoId': 'exact-other-artist', 'title': 'My Song', 'artists': [{'name': 'Other'}]},
        ]


class SearchSingleThresholdTest(unittest.TestCase):
    def setUp(self):
        self.searcher = load_searcher()
        self.searcher.get_ytmusic = lambda: FakeYTMusic()

    def test_manual_search_allows_artist_mismatches_but_excludes_unrequested_editions(self):
        result = self.searcher.search_single('Artist My Song', 'Artist', 'My Song', 0.0)

        self.assertIn('exact-other-artist', [candidate['videoId'] for candidate in result['results']])
        self.assertNotIn('live', [candidate['videoId'] for candidate in result['results']])
        self.assertNotIn('acoustic', [candidate['videoId'] for candidate in result['results']])
        self.assertEqual(len(result['results']), len({candidate['videoId'] for candidate in result['results']}))

    def test_manual_search_allows_requested_edition_and_applies_threshold(self):
        result = self.searcher.search_single('Artist My Song Acoustic', 'Artist', 'My Song (Acoustic)', 0.60)

        self.assertIn('acoustic', [candidate['videoId'] for candidate in result['results']])
        self.assertNotIn('different', [candidate['videoId'] for candidate in result['results']])

    def test_nync_alias_matches_nsync_results(self):
        self.assertTrue(self.searcher.artist_has_correct_match(
            ['NSYNC'], 'Nync', False
        ))

    def test_contextual_source_suffix_searches_canonical_title_without_changing_source_title(self):
        class ContextualTitleFakeYTMusic:
            def __init__(self):
                self.queries = []

            def search(self, query, *_args, **_kwargs):
                self.queries.append(query)
                return [{
                    'videoId': 'bye-bye-bye',
                    'title': 'Bye Bye Bye',
                    'artists': [{'name': '*NSYNC'}],
                }]

        fake_ytmusic = ContextualTitleFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake_ytmusic
        self.searcher.get_ytmusic = lambda: fake_ytmusic
        source_title = 'Bye Bye Bye - From Deadpool and Wolverine Soundtrack'

        result = self.searcher.search_tracks(
            [{'artist': 'Nync', 'title': source_title}],
            'playlist',
            False,
            max_workers=1,
        )

        self.assertIn('Nync Bye Bye Bye', fake_ytmusic.queries)
        self.assertEqual(result['results'][0]['title'], source_title)
        self.assertEqual(result['results'][0]['bestMatch']['title'], 'Bye Bye Bye')

    def test_automatic_search_does_not_emit_debug_stderr(self):
        class CandidateDebugFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [
                    {'videoId': 'wrong-artist', 'title': 'My Song', 'artists': [{'name': 'Other'}]},
                    {'videoId': 'match', 'title': 'My Song', 'artists': [{'name': 'Artist'}]},
                ]

        fake = CandidateDebugFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            result = self.searcher.search_tracks(
                [{'artist': 'Artist', 'title': 'My Song'}],
                'playlist',
                False,
                max_workers=1,
            )

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['videoId'], 'match')
        self.assertNotIn('DEBUG', stderr.getvalue())

    def test_conversion_threshold_changes_fake_matching_and_rejects_invalid_values(self):
        class ThresholdFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [{'videoId': 'near-match', 'title': 'Abcxyz', 'artists': [{'name': 'Artist'}]}]

        self.searcher.get_ytmusic_thread = lambda: ThresholdFakeYTMusic()
        self.searcher.get_ytmusic = lambda: ThresholdFakeYTMusic()
        tracks = [{'artist': 'Artist', 'title': 'Abcdef'}]

        self.assertEqual(self.searcher.search_tracks(tracks, 'playlist', False, max_workers=1)['results'][0]['status'], 'ambiguous')
        self.assertEqual(self.searcher.search_tracks(tracks, 'playlist', False, max_workers=1, threshold=0.5)['results'][0]['status'], 'matched')
        with self.assertRaises(ValueError):
            self.searcher.search_tracks(tracks, 'playlist', False, max_workers=1, threshold=1.1)


    def test_diacritic_equivalent_artists_match_without_changing_payloads(self):
        class AccentFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [{'videoId': 'accent-match', 'title': 'Song', 'artists': [{'name': 'Adrián Barba'}]}]

        fake = AccentFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks([{'artist': 'Adrian Barba', 'title': 'Song'}], 'playlist', False, max_workers=1)

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['artist'], 'Adrian Barba')
        self.assertEqual(result['results'][0]['bestMatch']['artist'], 'Adrián Barba')

    def test_japanese_title_with_adjacent_romaji_annotation_requires_matching_artist(self):
        class JapaneseAnnotationFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [{'videoId': 'annotation-match', 'title': '朝が来る - Asa ga kuru', 'artists': [{'name': 'Artist'}]}]

        fake = JapaneseAnnotationFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks([{'artist': 'Artist', 'title': '朝が来る'}], 'playlist', False, max_workers=1)

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['bestMatch']['title'], '朝が来る - Asa ga kuru')

    def test_japanese_translation_only_title_is_not_automatically_matched(self):
        class TranslationOnlyFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [{'videoId': 'translation-only', 'title': 'Morning Comes', 'artists': [{'name': 'Artist'}]}]

        fake = TranslationOnlyFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks([{'artist': 'Artist', 'title': '朝が来る'}], 'playlist', False, max_workers=1)

        self.assertEqual(result['results'][0]['status'], 'unmatched')

    def test_unrequested_first_take_japanese_candidate_cannot_win_normal_title_match(self):
        class FirstTakeFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [
                    {'videoId': 'first-take', 'title': '朝が来る (From THE FIRST TAKE)', 'artists': [{'name': 'Artist'}]},
                    {'videoId': 'ordinary', 'title': '朝が来る', 'artists': [{'name': 'Artist'}]},
                ]

        fake = FirstTakeFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks([{'artist': 'Artist', 'title': '朝が来る'}], 'playlist', False, max_workers=1)

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['videoId'], 'ordinary')
        self.assertEqual(result['results'][0]['bestMatch']['title'], '朝が来る')

    def test_requested_first_take_japanese_candidate_remains_eligible(self):
        class FirstTakeFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [
                    {'videoId': 'first-take', 'title': '朝が来る (From THE FIRST TAKE)', 'artists': [{'name': 'Artist'}]},
                    {'videoId': 'ordinary', 'title': '朝が来る', 'artists': [{'name': 'Artist'}]},
                ]

        fake = FirstTakeFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks(
            [{'artist': 'Artist', 'title': '朝が来る - from the first take'}],
            'playlist',
            False,
            max_workers=1,
        )

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['videoId'], 'first-take')
        self.assertEqual(result['results'][0]['bestMatch']['title'], '朝が来る (From THE FIRST TAKE)')

    def test_parenthetical_requested_first_take_japanese_candidate_remains_eligible(self):
        class FirstTakeFakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [
                    {'videoId': 'first-take', 'title': '朝が来る (From THE FIRST TAKE)', 'artists': [{'name': 'Artist'}]},
                    {'videoId': 'ordinary', 'title': '朝が来る', 'artists': [{'name': 'Artist'}]},
                ]

        fake = FirstTakeFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks(
            [{'artist': 'Artist', 'title': '朝が来る (from the first take)'}],
            'playlist',
            False,
            max_workers=1,
        )

        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['videoId'], 'first-take')

    def test_all_fake_automatic_search_failures_return_search_error_after_bounded_retries(self):
        class FailingFakeYTMusic:
            def __init__(self):
                self.calls = 0

            def search(self, *_args, **_kwargs):
                self.calls += 1
                raise RuntimeError('temporary provider failure')

        fake = FailingFakeYTMusic()
        self.searcher.time.sleep = lambda _: None
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        result = self.searcher.search_tracks([{'artist': 'Artist', 'title': 'Song'}], 'playlist', False, max_workers=1)

        self.assertEqual(result['results'][0]['status'], 'search_error')
        self.assertEqual(result['results'][0]['reason'], 'search_error')
        self.assertGreaterEqual(fake.calls, self.searcher.SEARCH_RETRY_ATTEMPTS)

    def test_authentication_errors_are_not_retried(self):
        class AuthenticationFailingFakeYTMusic:
            def __init__(self):
                self.calls = 0

            def search(self, *_args, **_kwargs):
                self.calls += 1
                error = RuntimeError('unauthorized')
                error.response = type('Response', (), {'status_code': 401})()
                raise error

        fake = AuthenticationFailingFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake

        with self.assertRaises(self.searcher.AuthenticationRequiredError):
            self.searcher.search_tracks([{'artist': 'Artist', 'title': 'Song'}], 'playlist', False, max_workers=1)
        self.assertEqual(fake.calls, 1)


class AddToPlaylistNoDebugTest(unittest.TestCase):
    def setUp(self):
        self.searcher = load_searcher()

    def test_add_to_playlist_success_and_failure_emit_no_debug_stderr(self):
        class PlaylistFakeYTMusic:
            def __init__(self, should_fail=False):
                self.should_fail = should_fail

            def add_playlist_items(self, *_args, **_kwargs):
                if self.should_fail:
                    raise RuntimeError('provider failed')
                return {'status': 'ok'}

        stderr = io.StringIO()
        self.searcher.get_ytmusic = lambda: PlaylistFakeYTMusic()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(
                self.searcher.add_to_playlist('playlist', ['video']),
                {'success': True, 'added': 1},
            )

        self.searcher.get_ytmusic = lambda: PlaylistFakeYTMusic(should_fail=True)
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(
                self.searcher.add_to_playlist('playlist', ['video']),
                {'error': 'Could not add selected tracks'},
            )

        self.assertNotIn('DEBUG', stderr.getvalue())


class PaginatedFakeYTMusic:
    def search(self, *_args, **_kwargs):
        return [
            {'videoId': f'candidate-{index}', 'title': 'Manual Song', 'artists': [{'name': 'Artist'}]}
            for index in range(20)
        ]


class SearchSinglePaginationTest(unittest.TestCase):
    def setUp(self):
        self.searcher = load_searcher()
        self.searcher.get_ytmusic = lambda: PaginatedFakeYTMusic()

    def test_manual_search_slices_ranked_candidates_into_five_item_pages(self):
        page = self.searcher.search_single('Manual Song', 'Artist', 'Manual Song', 0.0, offset=5)

        self.assertEqual([candidate['videoId'] for candidate in page['results']], [
            'candidate-5', 'candidate-6', 'candidate-7', 'candidate-8', 'candidate-9',
        ])
        self.assertEqual(page['resultCount'], 15)
        self.assertEqual(page['pageCount'], 3)
        self.assertTrue(page['hasMore'])

    def test_last_full_page_has_no_more_results_so_the_next_search_can_raise_threshold(self):
        page = self.searcher.search_single('Manual Song', 'Artist', 'Manual Song', 0.0, offset=10)

        self.assertEqual([candidate['videoId'] for candidate in page['results']], [
            'candidate-10', 'candidate-11', 'candidate-12', 'candidate-13', 'candidate-14',
        ])
        self.assertFalse(page['hasMore'])
        self.assertEqual(page['resultCount'], 15)
        self.assertEqual(page['pageCount'], 3)

    def test_manual_search_rejects_offsets_outside_the_three_pages(self):
        page = self.searcher.search_single('Manual Song', 'Artist', 'Manual Song', 0.0, offset=15)

        self.assertIn('offset', page['error'])


class KanaRomajiSearchTest(unittest.TestCase):
    def setUp(self):
        self.searcher = load_searcher()

        class FakeKakasi:
            readings = {
                'テスト・ソング': 'tesutosongu',
                'アーティスト': 'aatisuto',
            }

            def convert(self, value):
                return [{'hepburn': self.readings[value]}]

        self.searcher.kakasi = lambda: FakeKakasi()

    def search(self, candidate):
        class KanaRomajiFakeYTMusic:
            def __init__(self):
                self.queries = []

            def search(self, query, *_args, **_kwargs):
                self.queries.append(query)
                return [candidate]

        fake = KanaRomajiFakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        return fake, self.searcher.search_tracks(
            [{'artist': 'アーティスト', 'title': 'テスト・ソング'}],
            'playlist',
            False,
            max_workers=1,
        )

    def test_kana_romaji_title_and_artist_match_and_keep_source_payload(self):
        fake, result = self.search({
            'videoId': 'kana-romaji',
            'title': 'Tesuto Songu',
            'artists': [{'name': 'Aatisuto'}],
        })

        self.assertIn('aatisuto tesutosongu', fake.queries)
        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['artist'], 'アーティスト')
        self.assertEqual(result['results'][0]['title'], 'テスト・ソング')
        self.assertEqual(result['results'][0]['bestMatch']['title'], 'Tesuto Songu')

    def test_kana_romaji_matching_requires_both_title_and_artist(self):
        _, result = self.search({
            'videoId': 'wrong-artist',
            'title': 'Tesuto Songu',
            'artists': [{'name': 'Different Artist'}],
        })

        self.assertEqual(result['results'][0]['status'], 'unmatched')

        _, result = self.search({
            'videoId': 'wrong-title',
            'title': 'Different Title',
            'artists': [{'name': 'Aatisuto'}],
        })

        self.assertEqual(result['results'][0]['status'], 'unmatched')

    def test_kanji_romaji_pair_is_not_automatically_matched(self):
        _, result = self.searcher_test_with_track(
            {'artist': 'アーティスト', 'title': '東京'},
            {'videoId': 'kanji-romaji', 'title': 'Tokyo', 'artists': [{'name': 'Aatisuto'}]},
        )

        self.assertEqual(result['results'][0]['status'], 'unmatched')

    def test_missing_transliteration_dependency_preserves_existing_matching(self):
        self.searcher.kakasi = None
        _, result = self.search({
            'videoId': 'dependency-missing',
            'title': 'Tesuto Songu',
            'artists': [{'name': 'Aatisuto'}],
        })

        self.assertEqual(result['results'][0]['status'], 'unmatched')

    def searcher_test_with_track(self, track, candidate):
        class FakeYTMusic:
            def search(self, *_args, **_kwargs):
                return [candidate]

        fake = FakeYTMusic()
        self.searcher.get_ytmusic_thread = lambda: fake
        self.searcher.get_ytmusic = lambda: fake
        return fake, self.searcher.search_tracks([track], 'playlist', False, max_workers=1)


if __name__ == '__main__':
    unittest.main()
