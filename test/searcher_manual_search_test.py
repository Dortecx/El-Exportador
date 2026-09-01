import importlib.util
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


if __name__ == '__main__':
    unittest.main()
