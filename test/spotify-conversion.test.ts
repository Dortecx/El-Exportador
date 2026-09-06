import { describe, expect, it, vi } from "vitest";
import { SpotifyApi } from "../src/spotify/api.js";
import { convertSpotifyTracks } from "../src/spotify/converter.js";
import { matchSpotifyTrack } from "../src/spotify/matcher.js";
import type { SpotifyFetch } from "../src/spotify/types.js";

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });
}

function fakeFetch(responses: Response[]): SpotifyFetch {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
}

const source = { artist: "The Artist", durationMs: 180_000, title: "A Song" };

const matchingItem = {
  artists: [{ name: "The Artist" }],
  duration_ms: 180_500,
  id: "track-1",
  name: "A Song",
  uri: "spotify:track:track-1",
};

const matchingCandidate = {
  artists: [{ name: "The Artist" }],
  durationMs: 180_500,
  id: "track-1",
  title: "A Song",
  uri: "spotify:track:track-1",
};

describe("Spotify conversion core", () => {
  it("creates private playlists through the authenticated-user endpoint", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("https://api.spotify.com/v1/me/playlists");
      expect(init).toMatchObject({ body: JSON.stringify({ name: "My playlist", public: false }), headers: { Authorization: "Bearer test-token", "content-type": "application/json" }, method: "POST" });
      return response({ id: "playlist-1", name: "My playlist" });
    });
    const api = new SpotifyApi({ accessToken: "test-token", fetch });
    await expect(api.createPrivatePlaylist("profile-must-not-appear-in-route", "My playlist")).resolves.toMatchObject({ id: "playlist-1", isPrivate: true });
  });

  it("uses injected fetch for profile, private playlist creation, track search, URI batch insertion, and bounded Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = fakeFetch([
      response({ id: "user-1", display_name: "Test User" }),
      response({}, 429, { "retry-after": "2" }),
      response({ id: "playlist-1", external_urls: { spotify: "https://open.spotify.com/playlist/playlist-1" } }),
      response({ tracks: { items: [matchingItem] } }),
      response({ snapshot_id: "snapshot-1" }),
    ]);
    const api = new SpotifyApi({ accessToken: "test-token", fetch, maxRetries: 1, sleep });

    await expect(api.getProfile()).resolves.toEqual({ displayName: "Test User", id: "user-1" });
    await expect(api.createPrivatePlaylist("user-1", "My playlist")).resolves.toMatchObject({ id: "playlist-1", isPrivate: true });
    await expect(api.searchTracks("The Artist A Song")).resolves.toEqual([expect.objectContaining({ uri: "spotify:track:track-1" })]);
    await expect(api.addTracks("playlist-1", ["spotify:track:track-1"])).resolves.toEqual({ cancelled: false, insertedUris: ["spotify:track:track-1"], snapshotId: "snapshot-1" });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("inserts authenticated playlist items in URI batches of at most 100", async () => {
    const uris = Array.from({ length: 101 }, (_, index) => `spotify:track:${index}`);
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("https://api.spotify.com/v1/playlists/playlist-1/items");
      expect(init).toMatchObject({
        headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
        method: "POST",
      });
      const body = JSON.parse(String(init?.body));
      const batchStart = (fetch.mock.calls.length - 1) * 100;
      expect(body.uris).toEqual(uris.slice(batchStart, batchStart + 100));
      return response({ snapshot_id: `snapshot-${fetch.mock.calls.length}` }, fetch.mock.calls.length === 1 ? 201 : 200);
    });
    const api = new SpotifyApi({ accessToken: "test-token", fetch });

    await expect(api.addTracks("playlist-1", uris)).resolves.toEqual({
      cancelled: false,
      insertedUris: uris,
      snapshotId: "snapshot-2",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([input]) => String(input).includes("/items"))).toBe(true);
  });

  it("caps Retry-After delays at one minute", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = fakeFetch([
      response({}, 429, { "retry-after": "999999999" }),
      response({ id: "user-1" }),
    ]);
    const api = new SpotifyApi({ accessToken: "test-token", fetch, maxRetries: 1, sleep });

    await expect(api.getProfile()).resolves.toEqual({ id: "user-1" });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("matches deterministically using artist, title, and duration and keeps tied viable candidates ambiguous", () => {
    expect(matchSpotifyTrack(source, [matchingCandidate])).toMatchObject({ status: "matched", candidate: { uri: "spotify:track:track-1" } });
    expect(matchSpotifyTrack(source, [
      { ...matchingCandidate, id: "track-2", uri: "spotify:track:track-2" },
      matchingCandidate,
    ])).toMatchObject({ status: "ambiguous" });
    expect(matchSpotifyTrack(source, [{ ...matchingCandidate, artists: [{ name: "Another Artist" }] }])).toMatchObject({ status: "unmatched" });
  });

  it("dry-runs without creating a playlist and only inserts matched URIs while reporting ambiguous, unmatched, skipped, cancelled, and partial remote state", async () => {
    const api = {
      addTracks: vi.fn(async () => ({ cancelled: false, insertedUris: ["spotify:track:track-1"], snapshotId: "snapshot-1" })),
      createPrivatePlaylist: vi.fn(async () => ({ id: "playlist-1", isPrivate: true, name: "My playlist", url: "https://open.spotify.com/playlist/playlist-1" })),
      getProfile: vi.fn(async () => ({ id: "user-1" })),
      searchTracks: vi.fn(async (query: string) => {
        if (query.includes("Ambiguous")) return [
          { ...matchingCandidate, id: "track-2", title: "Ambiguous", uri: "spotify:track:track-2" },
          { ...matchingCandidate, id: "track-3", title: "Ambiguous", uri: "spotify:track:track-3" },
        ];
        if (query.includes("Missing")) return [];
        return [matchingCandidate];
      }),
    };
    const tracks = [source, { ...source, title: "Ambiguous" }, { ...source, title: "Missing" }, { ...source, title: "Skipped" }];
    const dryRun = await convertSpotifyTracks(api, tracks, { dryRun: true, playlistName: "My playlist", shouldCancel: () => false, shouldSkip: (track) => track.title === "Skipped" });
    expect(dryRun.remotePlaylist).toEqual({ status: "not-created" });
    expect(api.createPrivatePlaylist).not.toHaveBeenCalled();
    expect(dryRun.outcomes.map((outcome) => outcome.status)).toEqual(["matched", "ambiguous", "unmatched", "skipped"]);

    const completed = await convertSpotifyTracks(api, [source, { ...source, title: "Missing" }], { playlistName: "My playlist" });
    expect(api.addTracks).toHaveBeenLastCalledWith("playlist-1", ["spotify:track:track-1"], expect.any(Function));
    expect(completed.remotePlaylist).toMatchObject({ id: "playlist-1", insertedUris: ["spotify:track:track-1"], status: "partial" });

    const cancelled = await convertSpotifyTracks(api, tracks, { playlistName: "No remote playlist", shouldCancel: (index) => index === 1 });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.remotePlaylist).toEqual({ status: "not-created" });
  });

  it("reports each Spotify track's search progress with its count, total, and identity", async () => {
    const api = {
      addTracks: vi.fn(),
      createPrivatePlaylist: vi.fn(),
      getProfile: vi.fn(),
      searchTracks: vi.fn(async () => [matchingCandidate]),
    };
    const onProgress = vi.fn();
    const tracks = [source, { ...source, title: "Second Song" }];

    await convertSpotifyTracks(api, tracks, { dryRun: true, onProgress, playlistName: "My playlist" });

    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, "The Artist", "A Song", "searching");
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, "The Artist", "Second Song", "searching");
  });

  it("stops before playlist creation when cancellation is observed after matching", async () => {
    const api = {
      addTracks: vi.fn(async () => ({ cancelled: false, insertedUris: ["spotify:track:track-1"] })),
      createPrivatePlaylist: vi.fn(async () => ({ id: "playlist-1", isPrivate: true, name: "My playlist" })),
      getProfile: vi.fn(async () => ({ id: "user-1" })),
      searchTracks: vi.fn(async () => [matchingCandidate]),
    };

    const result = await convertSpotifyTracks(api, [source], { playlistName: "My playlist", shouldCancel: (index) => index === 1 });

    expect(result).toMatchObject({ cancelled: true, remotePlaylist: { status: "not-created" } });
    expect(api.getProfile).not.toHaveBeenCalled();
    expect(api.createPrivatePlaylist).not.toHaveBeenCalled();
    expect(api.addTracks).not.toHaveBeenCalled();
  });

  it("reports URIs inserted before a later batch fails", async () => {
    const insertedUris = ["spotify:track:track-1"];
    const api = {
      addTracks: vi.fn(async () => { throw Object.assign(new Error("insert failed"), { insertedUris }); }),
      createPrivatePlaylist: vi.fn(async () => ({ id: "playlist-1", isPrivate: true, name: "My playlist" })),
      getProfile: vi.fn(async () => ({ id: "user-1" })),
      searchTracks: vi.fn(async () => [matchingCandidate]),
    };

    const result = await convertSpotifyTracks(api, [source], { playlistName: "My playlist" });

    expect(result.remotePlaylist).toMatchObject({ insertedUris, insertionError: "SPOTIFY_INSERT_FAILED", status: "partial" });
  });

  it("uses a 15-worker pool and keeps outcomes in source order despite out-of-order searches", async () => {
    const tracks = Array.from({ length: 20 }, (_, index) => ({ artist: "The Artist", title: `Song ${index}` }));
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const api = {
      addTracks: vi.fn(),
      createPrivatePlaylist: vi.fn(),
      getProfile: vi.fn(),
      searchTracks: vi.fn(async () => new Promise<Array<typeof matchingCandidate>>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        resolvers.push(() => { active -= 1; resolve([matchingCandidate]); });
      })),
    };

    const conversion = convertSpotifyTracks(api, tracks, { dryRun: true, playlistName: "My playlist" });
    await vi.waitFor(() => expect(api.searchTracks).toHaveBeenCalledTimes(15));
    while (resolvers.length) {
      resolvers.shift()!();
      await Promise.resolve();
    }
    const result = await conversion;

    expect(maxActive).toBe(15);
    expect(result.outcomes.map((outcome) => outcome.source.title)).toEqual(tracks.map((track) => track.title));
  });

  it("shares a single Retry-After cooldown across concurrent searches", async () => {
    let releaseCooldown!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => { releaseCooldown = resolve; }));
    const fetch = fakeFetch([
      response({}, 429, { "retry-after": "1" }),
      response({}, 429, { "retry-after": "1" }),
      response({ tracks: { items: [] } }),
      response({ tracks: { items: [] } }),
    ]);
    const api = new SpotifyApi({ accessToken: "test-token", fetch, maxRetries: 1, sleep });
    const first = api.searchTracks("first");
    const second = api.searchTracks("second");

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(sleep).toHaveBeenCalledOnce();
    releaseCooldown();
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it("preserves completed batches on insertion failure and checks cancellation before each batch", async () => {
    const uris = Array.from({ length: 101 }, (_, index) => `spotify:track:${index}`);
    const failingApi = new SpotifyApi({
      accessToken: "test-token",
      fetch: fakeFetch([response({ snapshot_id: "snapshot-1" }), response({}, 500)]),
    });
    await expect(failingApi.addTracks("playlist-1", uris)).rejects.toMatchObject({ insertedUris: uris.slice(0, 100) });

    const fetch = fakeFetch([response({ snapshot_id: "snapshot-1" })]);
    const api = new SpotifyApi({ accessToken: "test-token", fetch });
    const shouldCancel = vi.fn(() => shouldCancel.mock.calls.length > 1);
    await expect(api.addTracks("playlist-1", uris, shouldCancel)).resolves.toMatchObject({ cancelled: true, insertedUris: uris.slice(0, 100) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
