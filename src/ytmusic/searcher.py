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
except ImportError:
    print(json.dumps({'error': 'ytmusicapi not installed. Run: pip install ytmusicapi'}))
    sys.exit(1)

AUTH_FILE = os.path.join(os.path.expanduser('~'), '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json')

# Thread-local storage for ytmusic clients
thread_local = threading.local()

def get_ytmusic():
    if not os.path.exists(AUTH_FILE):
        raise FileNotFoundError(f'Auth file not found: {AUTH_FILE}')
    return YTMusic(AUTH_FILE)

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
    
    # Check for exact substring match first
    if t1_lower in t2_lower or t2_lower in t1_lower:
        return 1.0
    
    # Handle Japanese titles in format "[Kanji] - [Romaji]"
    if contains_japanese(title1) or contains_japanese(title2):
        # Extract kanji and romaji from both titles
        kanji1, romaji1 = extract_japanese_title(title1)
        kanji2, romaji2 = extract_japanese_title(title2)
        
        # Compare all combinations
        combinations = [
            (kanji1, kanji2),      # Kanji vs Kanji
            (kanji1, romaji2),     # Kanji vs Romaji
            (romaji1, kanji2),     # Romaji vs Kanji
            (romaji1, romaji2),    # Romaji vs Romaji
            (title1, title2)       # Original vs Original
        ]
        
        max_similarity = 0.0
        for t1, t2 in combinations:
            if not t1 or not t2:
                continue
            
            # Use character-based similarity for Japanese
            chars1 = set(extract_japanese_chars(t1))
            chars2 = set(extract_japanese_chars(t2))
            if chars1 and chars2:
                common = len(chars1 & chars2)
                total = len(chars1 | chars2)
                similarity = common / total if total > 0 else 0.0
                max_similarity = max(max_similarity, similarity)
            else:
                # Fall back to difflib for non-Japanese comparisons
                similarity = difflib.SequenceMatcher(None, t1.lower(), t2.lower()).ratio()
                max_similarity = max(max_similarity, similarity)
        
        return max_similarity
    else:
        # For non-Japanese titles, use difflib
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
        
    # Store original queries for fallback
    original_queries = queries.copy()
    
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
        print(f'DEBUG: No match found for {artist} - {title}, trying normalized search', file=sys.stderr)
        
        # Try with normalized text
        normalized_artist = normalize_text(artist)
        normalized_title = normalize_text(primary_title)
        
        if normalized_artist != artist or normalized_title != primary_title:
            print(f'DEBUG: Normalized: {artist}->{normalized_artist}, {title}->{normalized_title}', file=sys.stderr)
            
            # Search with normalized queries
            normalized_queries = []
            if is_japanese:
                if normalized_artist:
                    normalized_queries.append(f'{normalized_artist} {normalized_title}')
                normalized_queries.append(normalized_title)
            else:
                if normalized_artist and normalized_title:
                    normalized_queries.append(f'{normalized_artist} {normalized_title}')
                normalized_queries.append(normalized_title)
            
            for query in normalized_queries:
                if not query.strip():
                    continue
                
                try:
                    print(f'DEBUG: Searching normalized query: {query}', file=sys.stderr)
                    search_results = ytmusic.search(query, filter='songs', limit=15)
                    
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
                        
                        similarity = calculate_similarity(result, artist, primary_title, target_channel_id)
                        status = 'matched' if similarity >= min_similarity else 'ambiguous' if similarity >= 0.3 else 'unmatched'
                        
                        if status in ['matched', 'ambiguous']:
                            all_candidates.append((result, query, similarity, status))
                except Exception as e:
                    print(f'Error searching for normalized "{query}": {e}', file=sys.stderr)
        
        if not all_candidates:
            print(f'DEBUG: No match found even after normalization for {artist} - {title}', file=sys.stderr)
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


def extract_japanese_title(title):
    """Extract kanji and romaji from Japanese titles in format '[Kanji] - [Romaji]'"""
    import re
    title = title.strip()
    match = re.match(r"^(.+?)\s*[-–]\s*(.+)$", title)
    if match:
        return match.groups()  # (kanji, romaji)
    return [title, ""]  # If no hyphen, return just the title


def normalize_text(text):
    """Remove accents and special characters from text"""
    if not text:
        return ""
    # Common accent/diacritic replacements
    replacements = {
        'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u',
        'à': 'a', 'è': 'e', 'ì': 'i', 'ò': 'o', 'ù': 'u',
        'ä': 'a', 'ë': 'e', 'ï': 'i', 'ö': 'o', 'ü': 'u',
        'â': 'a', 'ê': 'e', 'î': 'i', 'ô': 'o', 'û': 'u',
        'ñ': 'n', 'ç': 'c', '^': '', '¨': '', '~': '',
        '´': '', '`': '', '"': '', "'": '', '^': '',
    }
    result = "".join(replacements.get(c, c) for c in text)
    return result


def search_tracks(tracks, playlist_name, create_playlist=True, max_workers=25):  # Increased from 15 to 25
    results = []
    total = len(tracks)
    completed = 0
    result_map = {}
    
    def search_single_track(idx, track):
        ytmusic = get_ytmusic_thread()
        artist = track.get('artist', '')
        title = track.get('title', '')
        
        best_result = None
        best_status = 'unmatched'
        best_similarity = 0.0
        alternatives = []
        
        # Collect best match and alternatives
        for result, query_used, similarity, status in search_with_fallback(ytmusic, artist, title, collect_alternatives=True):
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
            'matched': best_result,
            'status': best_status,
            'similarity': best_similarity,
            'alternatives': alternatives,
            'result': best_result
        }
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_track = {
            executor.submit(search_single_track, idx, track): (idx, track)
            for idx, track in enumerate(tracks)
        }
        
        for future in as_completed(future_to_track):
            try:
                result = future.result()
                result_map[result['idx']] = result
                completed += 1
                
                progress_status = result.get('status', 'unmatched')
                progress_line = json.dumps({
                    'progress': {
                        'current': completed,
                        'total': total,
                        'artist': result['artist'],
                        'title': result['title'],
                        'status': progress_status
                    }
                })
                print(progress_line, flush=True)
            except Exception as e:
                print(f'DEBUG: Error processing track: {e}', file=sys.stderr)
    
    for idx in range(total):
        result = result_map[idx]
        matched_result = result['result']
        status = result.get('status', 'unmatched')
        similarity = result.get('similarity', 0.0)
        alternatives = result.get('alternatives', [])
        
        # Use status from result (matched/ambiguous/unmatched)
        if status == 'unmatched' or matched_result is None:
            artist_name = result.get('artist', 'UNKNOWN')
            title_name = result['title']
            print(f'DEBUG: No match found for {artist_name} - {title_name}', file=sys.stderr)
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
    video_ids = [r['videoId'] for r in results if r['status'] == 'matched' and r.get('videoId')]
    
    print(f'DEBUG: Found {len(video_ids)} videoIds to add: {video_ids}', file=sys.stderr)
    
    if create_playlist and video_ids:
        try:
            print(f'DEBUG: Creating playlist {playlist_name}...', file=sys.stderr)
            playlist_id = ytmusic.create_playlist(playlist_name, 'Created by m3u-to-ytmusic')
            print(f'DEBUG: Playlist created with ID: {playlist_id} (type: {type(playlist_id).__name__})', file=sys.stderr)
            
            for vid in video_ids:
                print(f'DEBUG: ADDING videoId={vid} to playlist {playlist_id}', file=sys.stderr)
            
            add_result = ytmusic.add_playlist_items(playlist_id, video_ids)
            print(f'DEBUG: add_playlist_items FULL RESPONSE: {json.dumps(add_result, indent=2)}', file=sys.stderr)
            
            playlist_url = f'https://music.youtube.com/playlist?list={playlist_id}'
        except Exception as e:
            print(f'DEBUG ERROR creating playlist: {e}', file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            playlist_url = None
            playlist_id = None
    else:
        if not create_playlist:
            print('DEBUG: Dry run enabled, skipping playlist creation', file=sys.stderr)
        else:
            print('DEBUG: No videoIds found, skipping playlist creation', file=sys.stderr)
        playlist_id = None
        playlist_url = None
    
    matched_count = sum(1 for r in results if r['status'] == 'matched')
    
    return {
        'playlistId': playlist_id,
        'playlistUrl': playlist_url,
        'matched': matched_count,
        'results': results
    }


def search_single(query):
    ytmusic = get_ytmusic()
    try:
        results = ytmusic.search(query, filter='songs', limit=3)
        formatted = []
        for r in results[:3]:
            formatted.append({
                'videoId': r.get('videoId'),
                'title': r.get('title', ''),
                'artist': get_artists(r),
                'duration': r.get('duration', ''),
            })
        return {'results': formatted}
    except Exception as e:
        return {'error': str(e), 'results': []}


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
        data = json.loads(sys.stdin.read())
        action = data.get('action', 'search')
        
        if action == 'setup':
            if os.path.exists(AUTH_FILE):
                print(json.dumps({'status': 'configured', 'authFile': AUTH_FILE}))
            else:
                print(json.dumps({'status': 'not_configured', 'authFile': AUTH_FILE}))
            return
        
        if action == 'search':
            output = search_tracks(
                data.get('tracks', []),
                data.get('playlistName', ''),
                data.get('createPlaylist', True)
            )
            print(json.dumps(output))
        elif action == 'search-single':
            output = search_single(data.get('query', ''))
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