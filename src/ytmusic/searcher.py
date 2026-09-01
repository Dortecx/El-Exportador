#!/usr/bin/env python3
import sys
import json
import os
import re
import difflib
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

try:
    from ytmusicapi import YTMusic
    from ytmusicapi.auth.browser import setup_browser
except ImportError:
    print(json.dumps({'error': 'ytmusicapi not installed. Run: pip install ytmusicapi'}))
    sys.exit(1)


STATE_ROOT = os.environ.get('M3U_YTMUSIC_STATE_DIR') or os.path.expanduser('~')
AUTH_FILE = os.path.join(STATE_ROOT, '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json')
thread_local = threading.local()

def get_ytmusic():
    if not os.path.exists(AUTH_FILE):
        raise FileNotFoundError('ytmusicapi browser authentication is not configured')
    return YTMusic(AUTH_FILE)

def normalize_browser_headers(headers):
    lines = [line.strip() for line in headers.splitlines() if line.strip()]
    if any(': ' in line for line in lines):
        return headers

    known_headers = {
        'accept', 'accept-language', 'authorization', 'content-type', 'cookie',
        'origin', 'referer', 'user-agent', 'x-goog-authuser', 'x-goog-visitor-id',
        'x-origin', 'x-youtube-client-name', 'x-youtube-client-version',
    }
    normalized = []
    index = 0
    while index + 1 < len(lines):
        name = lines[index].lower()
        if name in known_headers:
            normalized.append(f'{name}: {lines[index + 1]}')
            index += 2
        else:
            index += 1
    return '\n'.join(normalized)

def configure_browser_auth(headers):
    if not isinstance(headers, str) or not headers.strip():
        return {'status': 'failed', 'error': 'Browser headers are required'}
    os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
    try:
        setup_browser(AUTH_FILE, normalize_browser_headers(headers))
        os.chmod(AUTH_FILE, 0o600)
    except Exception as error:
        print(
            f'BROWSER_AUTH_DIAGNOSTIC stage=setup_browser exception={type(error).__name__}',
            file=sys.stderr,
        )
        if os.path.exists(AUTH_FILE):
            os.remove(AUTH_FILE)
        return {'status': 'failed', 'error': 'The browser headers could not be validated'}

    try:
        YTMusic(AUTH_FILE).get_library_playlists(limit=1)
        return {'status': 'authorized'}
    except Exception as error:
        print(
            f'BROWSER_AUTH_DIAGNOSTIC stage=library_validation exception={type(error).__name__}',
            file=sys.stderr,
        )
        if os.path.exists(AUTH_FILE):
            os.remove(AUTH_FILE)
        return {'status': 'failed', 'error': 'The browser headers could not be validated'}

def get_ytmusic_thread():
    if not hasattr(thread_local, 'ytmusic'):
        thread_local.ytmusic = get_ytmusic()
    return thread_local.ytmusic


def get_artist(artist_data):
    if isinstance(artist_data, list) and len(artist_data) > 0:
        return artist_data[0].get('name', str(artist_data[0]))
    if isinstance(artist_data, dict):
        return artist_data.get('name', str(artist_data))
    return str(artist_data) if artist_data else ''


def get_artists(result):
    artists = result.get('artists', [])
    if isinstance(artists, list) and len(artists) > 0:
        return artists[0].get('name', '')
    if isinstance(artists, dict):
        return artists.get('name', '')
    return ''


def contains_japanese(text):
    return bool(re.search(r'[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', text))


def extract_japanese_chars(text):
    return re.findall(r'[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', text)


def title_similarity(title1, title2):
    t1_lower = title1.lower()
    t2_lower = title2.lower()
    if t1_lower in t2_lower or t2_lower in t1_lower:
        return 1.0
    if contains_japanese(title1) and contains_japanese(title2):
        chars1 = set(extract_japanese_chars(title1))
        chars2 = set(extract_japanese_chars(title2))
        if not chars1 or not chars2:
            return 0.0
        common = len(chars1 & chars2)
        total = len(chars1 | chars2)
        return common / total if total > 0 else 0.0
    else:
        return difflib.SequenceMatcher(None, t1_lower, t2_lower).ratio()


EXCLUDED_KEYWORDS = [
    'cover', 'covered by', 'acoustic', 'piano version', 'instrumental', 'remix', 'live', 'nightcore',
    'karaoke', 'fan performance', 'backing track', 'short ver',
    'preview', 'teaser', 'mashup', 'medley', 'tribute', 'homage', 'parody',
    'tv size', 'tv ver', 'short ver', 'short version', 'tv edit', 'anime edit', 'anime ver', 'anime version',
    'vocal only', 'with ensemble', 'short mix', 'radio edit', 'long ver', 'full version',
    'minus bass', 'minus drums', 'minus guitar', 'minus vocal', 'off bass', 'off drums', 'off guitar',
    'off vocal', 'minus one', 'no vocals', 'no vocal'
]


def has_excluded_keyword(title):
    title_lower = title.lower()
    return any(kw in title_lower for kw in EXCLUDED_KEYWORDS)


def penalize_excluded(result_title, original_title):
    result_has_excluded = has_excluded_keyword(result_title)
    original_has_excluded = has_excluded_keyword(original_title)
    if result_has_excluded and not original_has_excluded:
        return 0.0
    return None


ARTIST_ALIASES = {
    '梅田サイファー': ['UMEDA CYPHER', '梅田サイファー', 'Umeda Cypher'],
    'うめたせいふぁー': ['UMEDA CYPHER', '梅田サイファー', 'Umeda Cypher'],
    'UMEDA CYPHER': ['UMEDA CYPHER', '梅田サイファー', 'Umeda Cypher'],
    'ざらめ': ['Zarame'],
    '優里': ['Yuuri'],
    '水槽': ['Suizō', 'suisoh'],
    'キタニタツヤ': ['Kitanitatsuya', 'Tatsuya Kitani', 'キタニタツヤ'],
    'YOASOBI': ['YOASOBI', '야오소비'],
    'LiSA': ['LiSA', 'リサ'],
}


def normalize_artist(artist):
    if not artist:
        return ''
    artist_lower = artist.lower()
    for alias, variants in ARTIST_ALIASES.items():
        if artist_lower == alias.lower() or any(artist_lower == v.lower() for v in variants):
            return alias
    return artist


def artist_has_correct_match(result_artists, original_artist, is_japanese):
    if not original_artist or not result_artists:
        return True
    
    original_normalized = normalize_artist(original_artist)
    result_normalized = normalize_artist(result_artists[0]) if result_artists else ''
    
    if original_normalized.lower() == result_normalized.lower():
        return True
    
    if is_japanese:
        original_jp = ''.join(c for c in original_artist if ord(c) > 0x3000)
        result_jp = ''.join(c for c in result_normalized if ord(c) > 0x3000)
        if original_jp and result_jp and (original_jp in result_jp or result_jp in original_jp):
            return True
    
    return False


def get_all_artists(result):
    artists = result.get('artists', [])
    if artists and isinstance(artists, list):
        return [a.get('name', '') for a in artists if a.get('name')]
    return []


def extract_series_name(title):
    # Caso especial para "My Nonfiction"
    if "My Nonfiction" in title:
        return "My Nonfiction"
    
    series_patterns = [
        r'^(.+?)\u3010.+?\u3011',
        r'^(.+?)\u3001.+?\u3001',
        r'^(.+?)\u300c.+?\u300d',
        r'^(.+?)\u0028.+?\u0029',
        r'^(.+?)\u005b.+?\u005d',
        r'^(.+?)\u007c.+',
        r'^(.+?)\u2015.+',
        r'^(.+?)[\u2022\u2027]',
    ]
    for pattern in series_patterns:
        match = re.match(pattern, title)
        if match:
            return match.group(1).strip()
    return title


def validate_video_id(ytmusic, video_id, result):
    try:
        details = ytmusic.get_track(video_id)
        if details:
            return True
        return False
    except:
        return True


def get_duration_seconds(result):
    duration = result.get('duration', '')
    if not duration:
        return 0
    parts = duration.split(':')
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    return 0


def check_manual_override(ytmusic, artist, title):
    return None


def find_artist_channel_id(ytmusic, artist):
    try:
        results = ytmusic.search(artist, filter='artists', limit=5)
        for result in results:
            if result.get('artist') and result['artist'].get('name'):
                channel_id = result['artist'].get('channelId')
                if channel_id:
                    return channel_id, result['artist']['name']
        return None, None
    except:
        return None, None


def artist_allows_videos(artist):
    return False


def search_with_fallback(ytmusic, artist, title, min_similarity=0.6, collect_alternatives=True):
    """
    Search with fallback logic. Returns (result, query, similarity, status).
    Status: 'matched' (>=0.6), 'ambiguous' (>=0.3 and <0.6), 'unmatched' (<0.3)
    If collect_alternatives=True, yields all candidates sorted by similarity.
    """
    primary_title = extract_series_name(title).strip()
    is_japanese = contains_japanese(primary_title)
    
    override_result = check_manual_override(ytmusic, artist, primary_title)
    if override_result:
        yield override_result, 'MANUAL_OVERRIDE', 1.0, 'matched'
        return
    
    target_channel_id = None
    if artist and is_japanese:
        target_channel_id, found_artist_name = find_artist_channel_id(ytmusic, artist)
        if target_channel_id:
            print(f'DEBUG: Found artist {found_artist_name} with channelId: {target_channel_id}', file=sys.stderr)
    
    queries = []
    if is_japanese:
        if artist:
            queries.append(f'{artist} {primary_title}')
        queries.append(primary_title)
    else:
        if artist and primary_title:
            queries.append(f'{artist} {primary_title}')
        queries.append(primary_title)
    
    seen_video_ids = set()
    all_candidates = []  # Collect all candidates for alternatives
    
    for query in queries:
        if not query.strip():
            continue
        
        try:
            print(f'DEBUG: Searching query: {query} (is_japanese={is_japanese})', file=sys.stderr)
            search_results = ytmusic.search(query, filter='songs', limit=15)
            print(f'DEBUG: Got {len(search_results)} results', file=sys.stderr)
            
            for result in search_results:
                video_id = result.get('videoId')
                if not video_id or video_id in seen_video_ids:
                    continue
                
                if not validate_video_id(ytmusic, video_id, result):
                    seen_video_ids.add(video_id)
                    continue
                
                seen_video_ids.add(video_id)
                
                result_title = result.get('title', '')
                result_artists = get_all_artists(result)
                result_artist = result_artists[0] if result_artists else ''
                
                p1_lower = primary_title.lower()
                r1_lower = result_title.lower()
                is_substring = p1_lower in r1_lower or r1_lower in p1_lower
                print(f'DEBUG: SUBSTRING CHECK: {primary_title} in {result_title} = {is_substring}', file=sys.stderr)
                
                if artist and not artist_has_correct_match(result_artists, artist, is_japanese):
                    print(f'DEBUG: Artist mismatch {result_artist} vs {artist}, skipping', file=sys.stderr)
                    continue
                
                similarity = title_similarity(primary_title, result_title)
                
                excluded_penalty = penalize_excluded(result_title, primary_title)
                if excluded_penalty is not None:
                    print(f'DEBUG: EXCLUDED KEYWORD: {result_title} - penalized to 0.00', file=sys.stderr)
                    similarity = 0.0
                
                duration = get_duration_seconds(result)
                print(f'DEBUG: {primary_title} vs {result_title} (by {result_artist}, {duration}s) = {similarity:.2f}', file=sys.stderr)
                
                # Determine status based on similarity
                if similarity >= 0.6:
                    status = 'matched'
                elif similarity >= 0.3:
                    status = 'ambiguous'
                else:
                    status = 'unmatched'
                
                all_candidates.append((result, query, similarity, status))
        except Exception as e:
            print(f'DEBUG: Search error: {e}', file=sys.stderr)
            continue
    
    if artist and is_japanese and not target_channel_id:
        print(f'DEBUG: Trying artist channel search for {artist}...', file=sys.stderr)
        channel_id, _ = find_artist_channel_id(ytmusic, artist)
        if channel_id:
            target_channel_id = channel_id
    
    if artist:
        print(f'DEBUG: Trying artist-only search: {artist}...', file=sys.stderr)
        try:
            search_results = ytmusic.search(artist, filter='songs', limit=10)
            for result in search_results:
                video_id = result.get('videoId')
                if not video_id or video_id in seen_video_ids:
                    continue
                
                if not validate_video_id(ytmusic, video_id, result):
                    seen_video_ids.add(video_id)
                    continue
                
                seen_video_ids.add(video_id)
                
                result_title = result.get('title', '')
                result_artists = get_all_artists(result)
                result_artist = result_artists[0] if result_artists else ''
                
                if not artist_has_correct_match(result_artists, artist, is_japanese):
                    continue
                
                similarity = title_similarity(primary_title, result_title)
                
                if similarity >= 0.6:
                    status = 'matched'
                elif similarity >= 0.3:
                    status = 'ambiguous'
                else:
                    status = 'unmatched'
                
                all_candidates.append((result, artist, similarity, status))
        except Exception as e:
            print(f'DEBUG: Artist-only search failed: {e}', file=sys.stderr)
    
    # Sort by similarity descending and yield
    all_candidates.sort(key=lambda x: x[2], reverse=True)
    
    if not all_candidates:
        print(f'DEBUG: No match found for {artist} - {title}, marking as unmatched', file=sys.stderr)
        yield None, '', 0.0, 'unmatched'
        return
    
    # Always yield best match first
    best = all_candidates[0]
    print(f'DEBUG: BEST: {best[3]} - {best[2]:.2f} for {artist} - {title}', file=sys.stderr)
    yield best[0], best[1], best[2], best[3]
    
    # If collecting alternatives and we have more, yield top 2 more
    if collect_alternatives:
        for i, candidate in enumerate(all_candidates[1:3], start=1):
            print(f'DEBUG: ALTERNATIVE {i}: {candidate[3]} - {candidate[2]:.2f}', file=sys.stderr)
            yield candidate[0], candidate[1], candidate[2], candidate[3]


def search_tracks(tracks, playlist_name, create_playlist=True, max_workers=15):
    results = []
    total = len(tracks)
    result_map = {}

    def search_single_track(idx, track):
        ytmusic = get_ytmusic_thread()
        artist = track.get('artist', '')
        title = track.get('title', '')
        best_result = None
        best_status = 'unmatched'
        best_similarity = 0.0
        alternatives = []

        for result, query_used, similarity, status in search_with_fallback(
            ytmusic, artist, title, collect_alternatives=True
        ):
            if best_result is None:
                best_result = result
                best_status = status
                best_similarity = similarity
            elif result is not None and len(alternatives) < 2:
                alternatives.append({
                    'title': result.get('title', ''),
                    'artist': get_artists(result),
                    'videoId': result.get('videoId'),
                    'similarity': similarity,
                })

        return {
            'idx': idx,
            'artist': artist,
            'title': title,
            'status': best_status,
            'similarity': best_similarity,
            'alternatives': alternatives,
            'result': best_result,
        }

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_track = {
            executor.submit(search_single_track, idx, track): (idx, track)
            for idx, track in enumerate(tracks)
        }

        for completed, future in enumerate(as_completed(future_to_track), start=1):
            idx, track = future_to_track[future]
            try:
                result = future.result()
            except Exception as error:
                print(f'DEBUG: Error processing track: {error}', file=sys.stderr)
                result = {
                    'idx': idx,
                    'artist': track.get('artist', ''),
                    'title': track.get('title', ''),
                    'status': 'unmatched',
                    'similarity': 0.0,
                    'alternatives': [],
                    'result': None,
                }

            result_map[result['idx']] = result
            print(json.dumps({
                'progress': {
                    'current': completed,
                    'total': total,
                    'artist': result['artist'],
                    'title': result['title'],
                    'status': result['status'],
                }
            }), flush=True)

    for idx in range(total):
        result = result_map[idx]
        matched_result = result['result']
        status = result['status']
        similarity = result['similarity']
        alternatives = result['alternatives']

        if status == 'unmatched' or matched_result is None:
            print(
                f"DEBUG: No match found for {result['artist']} - {result['title']}",
                file=sys.stderr,
            )
            results.append({
                'status': 'unmatched',
                'artist': result['artist'],
                'title': result['title'],
                'videoId': None,
                'bestMatch': None,
                'alternatives': [],
                'similarity': 0.0,
            })
        else:
            results.append({
                'status': status,
                'artist': result['artist'],
                'title': result['title'],
                'videoId': matched_result.get('videoId'),
                'bestMatch': {
                    'title': matched_result.get('title', ''),
                    'artist': get_artists(matched_result),
                    'videoId': matched_result.get('videoId'),
                },
                'alternatives': alternatives,
                'similarity': similarity,
            })

    ytmusic = get_ytmusic()
    video_ids = list(dict.fromkeys(
        result['videoId']
        for result in results
        if result['status'] == 'matched' and result.get('videoId')
    ))

    print(f'DEBUG: Found {len(video_ids)} unique videoIds to add: {video_ids}', file=sys.stderr)

    if create_playlist and video_ids:
        try:
            print(f'DEBUG: Creating playlist {playlist_name}...', file=sys.stderr)
            playlist_id = ytmusic.create_playlist(
                playlist_name,
                'Created by m3u-to-ytmusic',
                video_ids=video_ids,
            )
            print(
                f'DEBUG: Playlist created with ID: {playlist_id} '
                f'and {len(video_ids)} initial songs '
                f'(type: {type(playlist_id).__name__})',
                file=sys.stderr,
            )
            playlist_url = f'https://music.youtube.com/playlist?list={playlist_id}'
        except Exception as error:
            print(f'DEBUG ERROR creating playlist: {error}', file=sys.stderr)
            playlist_id = None
            playlist_url = None
    else:
        if not create_playlist:
            print('DEBUG: Dry run enabled, skipping playlist creation', file=sys.stderr)
        else:
            print('DEBUG: No videoIds found, skipping playlist creation', file=sys.stderr)
        playlist_id = None
        playlist_url = None

    return {
        'playlistId': playlist_id,
        'playlistUrl': playlist_url,
        'matched': sum(1 for result in results if result['status'] == 'matched'),
        'results': results,
    }


def has_unrequested_edition_keyword(result_title, requested_title):
    requested_lower = requested_title.lower()
    return any(
        keyword in result_title.lower() and keyword not in requested_lower
        for keyword in EXCLUDED_KEYWORDS
    )


def search_single(query, artist='', title='', threshold=0.0, offset=0):
    if not isinstance(offset, int) or isinstance(offset, bool) or offset not in (0, 5, 10):
        return {'error': 'Manual search offset must be 0, 5, or 10', 'results': []}

    ytmusic = get_ytmusic()
    expected_title = title.strip() or query
    try:
        candidates = []
        seen_video_ids = set()
        for result in ytmusic.search(query, filter='songs', limit=15):
            video_id = result.get('videoId')
            if not video_id or video_id in seen_video_ids:
                continue
            seen_video_ids.add(video_id)

            result_title = result.get('title', '')
            expected_title_similarity = title_similarity(expected_title, result_title)
            if expected_title_similarity < threshold:
                continue
            if has_unrequested_edition_keyword(result_title, expected_title):
                continue

            query_similarity = title_similarity(query, result_title)
            relevance = (2 * expected_title_similarity) + query_similarity
            candidates.append((relevance, expected_title_similarity, result))

        candidates.sort(key=lambda candidate: (candidate[0], candidate[1]), reverse=True)

        candidates = candidates[:15]
        result_count = len(candidates)
        page_candidates = candidates[offset:offset + 5]
        return {
            'results': [
                {
                    'videoId': result.get('videoId'),
                    'title': result.get('title', ''),
                    'artist': get_artists(result),
                    'duration': result.get('duration', ''),
                }
                for _, _, result in page_candidates
            ],
            'hasMore': offset + 5 < result_count,
            'pageCount': (result_count + 4) // 5,
            'resultCount': result_count,
        }
    except Exception as e:
        return {
            'error': str(e),
            'results': [],
            'hasMore': False,
            'pageCount': 0,
            'resultCount': 0,
        }


def add_to_playlist(playlist_id, video_ids):
    ytmusic = get_ytmusic()
    try:
        print(f'DEBUG add_to_playlist: playlistId={playlist_id}, videoIds={video_ids}', file=sys.stderr)
        add_result = ytmusic.add_playlist_items(playlist_id, video_ids)
        print(f'DEBUG add_to_playlist response: {add_result}', file=sys.stderr)
        return {'success': True, 'added': len(video_ids)}
    except Exception as e:
        print(f'DEBUG ERROR add_to_playlist: {e}', file=sys.stderr)
        return {'error': str(e)}


def main():
    try:
        print('DEBUG: Script started', file=sys.stderr)
        # Leer el input desde los argumentos
        if len(sys.argv) > 1:
            print(f'DEBUG: Reading input from args: {sys.argv[-1]}', file=sys.stderr)
            data = json.loads(sys.argv[-1])
        else:
            print('DEBUG: Reading input from stdin', file=sys.stderr)
            data = json.loads(sys.stdin.read())
        print('DEBUG: Parsed request', file=sys.stderr)
        action = data.get('action', 'search')
        print(f'DEBUG: Action: {action}', file=sys.stderr)
        
        if action == 'browser-auth':
            print(json.dumps(configure_browser_auth(data.get('headers', ''))))
            return

        if action == 'setup':
            print(json.dumps({
                'status': 'configured' if os.path.exists(AUTH_FILE) else 'not_configured',
                'authFile': AUTH_FILE,
            }))
            return
        
        if action == 'search':
            output = search_tracks(
                data.get('tracks', []),
                data.get('playlistName', ''),
                data.get('createPlaylist', True)
            )
            # Imprimir resultados para el cliente
            for result in output.get('results', []):
                progress = {
                    'current': output.get('matched', 0),
                    'total': len(data.get('tracks', [])),
                    'artist': result.get('artist', ''),
                    'title': result.get('title', ''),
                    'status': result.get('status', 'unmatched')
                }
                print(json.dumps({'progress': progress}))
            
            # Imprimir resultado final
            results = output.get('results', [])
            unmatched_tracks = [result for result in results if result.get('status') == 'unmatched']
            ambiguous_tracks = [result for result in results if result.get('status') == 'ambiguous']
            print(json.dumps({
                'playlistId': output.get('playlistId'),
                'playlistUrl': output.get('playlistUrl'),
                'matched': output.get('matched', 0),
                'unmatched': len(unmatched_tracks),
                'ambiguous': len(ambiguous_tracks),
                'unmatchedTracks': unmatched_tracks,
                'ambiguousTracks': ambiguous_tracks,
                'manualReviewTracks': [
                    result for result in results
                    if result.get('status') in ('unmatched', 'ambiguous')
                    ],
            }))
        elif action == 'search-single':
            output = search_single(
                data.get('query', ''),
                data.get('artist', ''),
                data.get('title', ''),
                    data.get('threshold', 0.0),
                    data.get('offset', 0),
            )
            print(json.dumps(output))
        elif action == 'add-to-playlist':
            output = add_to_playlist(data.get('playlistId'), data.get('videoIds', []))
            print(json.dumps(output))
        else:
            print(json.dumps({'error': f'Unknown action: {action}'}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))


if __name__ == '__main__':
    main()