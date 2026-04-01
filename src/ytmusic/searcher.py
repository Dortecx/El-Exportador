#!/usr/bin/env python3
import sys
import json
import os

try:
    from ytmusicapi import YTMusic
except ImportError:
    print(json.dumps({"error": "ytmusicapi not installed. Run: pip install ytmusicapi"}))
    sys.exit(1)

AUTH_FILE = os.path.join(os.path.expanduser("~"), ".config", "m3u-to-ytmusic", "ytmusic_auth.json")


def get_artist(artist_data):
    if isinstance(artist_data, list) and len(artist_data) > 0:
        return artist_data[0].get("name", str(artist_data[0]))
    if isinstance(artist_data, dict):
        return artist_data.get("name", str(artist_data))
    return str(artist_data) if artist_data else ""


def get_artists(result):
    artists = result.get("artists", [])
    if isinstance(artists, list) and len(artists) > 0:
        return artists[0].get("name", "")
    if isinstance(artists, dict):
        return artists.get("name", "")
    return ""


def get_ytmusic():
    if not os.path.exists(AUTH_FILE):
        raise FileNotFoundError(f"Auth file not found: {AUTH_FILE}")
    return YTMusic(AUTH_FILE)


def search_tracks(tracks, playlist_name):
    ytmusic = get_ytmusic()
    results = []
    
    for track in tracks:
        query = f"{track.get('artist', '')} {track.get('title', '')}".strip()
        try:
            search_results = ytmusic.search(query, filter="songs", limit=1)
            if search_results:
                result = search_results[0]
                results.append({
                    "status": "matched",
                    "artist": track.get("artist", ""),
                    "title": track.get("title", ""),
                    "videoId": result.get("videoId"),
                    "bestMatch": {
                        "title": result.get("title", ""),
                        "artist": get_artists(result),
                        "videoId": result.get("videoId"),
                    }
                })
            else:
                results.append({
                    "status": "unmatched",
                    "artist": track.get("artist", ""),
                    "title": track.get("title", ""),
                    "videoId": None,
                    "bestMatch": None
                })
        except Exception as e:
            results.append({
                "status": "unmatched",
                "artist": track.get("artist", ""),
                "title": track.get("title", ""),
                "videoId": None,
                "bestMatch": None,
                "error": str(e)
            })
    
    video_ids = [r["videoId"] for r in results if r["status"] == "matched" and r.get("videoId")]
    
    if video_ids:
        try:
            playlist_id = ytmusic.create_playlist(playlist_name, "Created by m3u-to-ytmusic")
            ytmusic.add_playlist_items(playlist_id, video_ids)
            playlist_url = f"https://music.youtube.com/playlist?list={playlist_id}"
        except Exception as e:
            playlist_url = None
            playlist_id = None
    else:
        playlist_id = None
        playlist_url = None
    
    matched_count = sum(1 for r in results if r["status"] == "matched")
    
    return {
        "playlistId": playlist_id,
        "playlistUrl": playlist_url,
        "matched": matched_count,
        "results": results
    }


def search_single(query):
    ytmusic = get_ytmusic()
    try:
        results = ytmusic.search(query, filter="songs", limit=3)
        formatted = []
        for r in results[:3]:
            formatted.append({
                "videoId": r.get("videoId"),
                "title": r.get("title", ""),
                "artist": get_artists(r),
                "duration": r.get("duration", ""),
            })
        return {"results": formatted}
    except Exception as e:
        return {"error": str(e), "results": []}


def add_to_playlist(playlist_id, video_ids):
    ytmusic = get_ytmusic()
    try:
        ytmusic.add_playlist_items(playlist_id, video_ids)
        return {"success": True, "added": len(video_ids)}
    except Exception as e:
        return {"error": str(e)}


def main():
    try:
        data = json.loads(sys.stdin.read())
        action = data.get("action", "search")
        
        if action == "setup":
            if os.path.exists(AUTH_FILE):
                print(json.dumps({"status": "configured", "authFile": AUTH_FILE}))
            else:
                print(json.dumps({"status": "not_configured", "authFile": AUTH_FILE}))
            return
        
        if action == "search":
            output = search_tracks(data.get("tracks", []), data.get("playlistName", ""))
            print(json.dumps(output))
        elif action == "search-single":
            output = search_single(data.get("query", ""))
            print(json.dumps(output))
        elif action == "add-to-playlist":
            output = add_to_playlist(data.get("playlistId"), data.get("videoIds", []))
            print(json.dumps(output))
        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))
            
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
    except FileNotFoundError as e:
        print(json.dumps({"error": str(e), "hint": "Run 'ytmusicapi oauth' to authenticate"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
