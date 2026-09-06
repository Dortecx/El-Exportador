import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const ytmusic = vi.hoisted(() => ({ convertWithYtMusic: vi.fn() }));
vi.mock("../src/ytmusic/client", () => ({
  addToPlaylistOnYtMusic: vi.fn(),
  checkYtMusicAvailable: vi.fn(async () => false),
  configureYtMusicBrowserAuth: vi.fn(),
  convertWithYtMusic: ytmusic.convertWithYtMusic,
  searchSingleOnYtMusic: vi.fn(),
  validateYtMusicAuth: vi.fn(),
}));

import { SpotifyApiError } from "../src/spotify/api.js";
import { app, resetSpotifyWebDependenciesForTest, setSpotifyWebDependenciesForTest } from "../src/web/server.js";

let server: Server | undefined;

async function request(path: string, body?: unknown) {
  server ??= await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
}

afterEach(async () => {
  resetSpotifyWebDependenciesForTest();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("Spotify web backend", () => {
  it("reports destination availability without credentials and safely routes Spotify conversion with injected dependencies", async () => {
    const convert = vi.fn(async () => ({
      cancelled: false,
      outcomes: [{ candidate: { uri: "spotify:track:1" }, source: { artist: "Artist", title: "Song" }, status: "matched" as const }],
      remotePlaylist: { id: "playlist-1", insertedUris: ["spotify:track:1"], status: "created" as const, url: "https://spotify.test/playlist-1" },
    }));
    setSpotifyWebDependenciesForTest({
      convert,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
      isYtMusicAvailable: async () => true,
    });

    await expect(request("/api/destinations")).resolves.toMatchObject({
      body: { destinations: { spotify: { available: true, connected: true }, youtube: { available: true } } },
      status: 200,
    });
    await expect(request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toMatchObject({
      body: { matched: 1, provider: "spotify", remotePlaylist: { id: "playlist-1" }, sideEffects: { inserted: 1, playlist: "created" }, success: true },
      status: 200,
    });
    expect(convert).toHaveBeenCalledOnce();
  });

  it("streams fake Spotify search progress over SSE before its result", async () => {
    const convert = vi.fn(async (_api, tracks, options) => {
      options.onProgress?.(1, tracks.length, tracks[0].artist, tracks[0].title, "searching");
      return {
        cancelled: false,
        outcomes: [{ candidate: { uri: "spotify:track:1" }, source: tracks[0], status: "matched" as const }],
        remotePlaylist: { status: "not-created" as const },
      };
    });
    setSpotifyWebDependenciesForTest({
      convert,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });
    server ??= await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    const progress = await fetch(`http://127.0.0.1:${port}/api/convert-progress`);
    const reader = progress.body!.getReader();

    await request("/api/convert", { destination: "spotify", dryRun: true, playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });

    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const events = chunk.trim().split("\n\n").map((event) => JSON.parse(event.replace(/^data: /, "")));
    expect(events[0]).toMatchObject({ added: 1, artist: "Artist", status: "searching", title: "Song", total: 1, type: "progress" });
  });

  it("streams normalized Spotify manual-review tracks for ambiguous and unmatched outcomes", async () => {
    const ambiguousCandidate = { artists: [{ name: "Candidate Artist" }], id: "candidate-1", title: "Candidate Song", uri: "spotify:track:candidate-1" };
    const alternative = { artists: [{ name: "Alternative Artist" }], id: "candidate-2", title: "Alternative Song", uri: "spotify:track:candidate-2" };
    setSpotifyWebDependenciesForTest({
      convert: vi.fn(async () => ({
        cancelled: false,
        outcomes: [
          {
            alternatives: [alternative],
            candidate: ambiguousCandidate,
            confidence: 0.72,
            source: { artist: "Source Artist", title: "Ambiguous Song" },
            status: "ambiguous" as const,
          },
          {
            alternatives: [],
            candidate: null,
            confidence: 0,
            source: { artist: "Missing Artist", title: "Missing Song" },
            status: "unmatched" as const,
          },
        ],
        remotePlaylist: { status: "not-created" as const },
      })),
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });
    server ??= await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    const progress = await fetch(`http://127.0.0.1:${port}/api/convert-progress`);
    const reader = progress.body!.getReader();

    await request("/api/convert", {
      destination: "spotify",
      dryRun: true,
      playlistName: "My playlist",
      tracks: [
        { artist: "Source Artist", title: "Ambiguous Song" },
        { artist: "Missing Artist", title: "Missing Song" },
      ],
    });

    const event = await reader.read();
    await reader.cancel();
    const payload = JSON.parse(new TextDecoder().decode(event.value).replace(/^data: /, "").trim());
    expect(payload).toMatchObject({
      manualReviewTracks: [
        {
          alternatives: [alternative],
          artist: "Source Artist",
          bestMatch: ambiguousCandidate,
          status: "ambiguous",
          title: "Ambiguous Song",
        },
        {
          alternatives: [],
          artist: "Missing Artist",
          bestMatch: null,
          status: "unmatched",
          title: "Missing Song",
        },
      ],
      provider: "spotify",
      type: "result",
    });
  });

  it("preserves the omitted-destination YouTube response and SSE result payload", async () => {
    ytmusic.convertWithYtMusic.mockResolvedValue({
      ambiguousTracks: [],
      manualReviewTracks: [],
      matched: 1,
      playlistId: "youtube-playlist",
      playlistUrl: "https://youtube.test/playlist",
      unmatchedTracks: [],
    });
    server ??= await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    const progress = await fetch(`http://127.0.0.1:${port}/api/convert-progress`);
    const reader = progress.body!.getReader();

    await expect(request("/api/convert", { playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toEqual({ body: { success: true }, status: 200 });

    const event = await reader.read();
    await reader.cancel();
    const payload = JSON.parse(new TextDecoder().decode(event.value).replace(/^data: /, "").trim());
    expect(payload).toEqual({
      ambiguous: 0,
      ambiguousTracks: [],
      manualReviewTracks: [],
      matched: 1,
      playlistId: "youtube-playlist",
      playlistUrl: "https://youtube.test/playlist",
      total: 1,
      type: "result",
      unmatched: 0,
      unmatchedTracks: [],
    });
  });

  it("rejects disabled Spotify configuration and empty Spotify manual inputs before invoking Spotify", async () => {
    const createApi = vi.fn();
    setSpotifyWebDependenciesForTest({
      createApi,
      getClientConfig: () => ({ clientId: null, enabled: false, reason: "SPOTIFY_CONFIGURATION_REQUIRED", redirectUri: null, supported: true }),
      getTokenState: () => null,
    });

    await expect(request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [] })).resolves.toMatchObject({ body: { code: "SPOTIFY_CONFIGURATION_REQUIRED" }, status: 503 });
    await expect(request("/api/spotify/search-single", { query: "   " })).resolves.toMatchObject({ body: { error: "A search query is required" }, status: 400 });
    await expect(request("/api/spotify/add-to-playlist", { playlistId: " ", tracks: [] })).resolves.toMatchObject({ body: { error: "A playlist and selected tracks are required" }, status: 400 });
    expect(createApi).not.toHaveBeenCalled();
  });

  it("returns safe Spotify errors when provider operations fail", async () => {
    const api = {
      addTracks: vi.fn(async () => { throw new Error("provider internals"); }),
      createPrivatePlaylist: vi.fn(),
      getProfile: vi.fn(),
      searchTracks: vi.fn(async () => { throw new Error("provider internals"); }),
    };
    setSpotifyWebDependenciesForTest({
      convert: vi.fn(async () => { throw new Error("provider internals"); }),
      createApi: () => api,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    await expect(request("/api/spotify/search-single", { limit: 5, offset: 0, query: "Artist Song" })).resolves.toMatchObject({ body: { code: "SPOTIFY_SEARCH_FAILED" }, status: 502 });
    await expect(request("/api/spotify/add-to-playlist", { playlistId: "playlist-1", tracks: [{ uri: "spotify:track:1" }] })).resolves.toMatchObject({ body: { code: "SPOTIFY_PLAYLIST_FAILED" }, status: 502 });
    await expect(request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toMatchObject({ body: { code: "SPOTIFY_PROVIDER_UNAVAILABLE" }, status: 503 });
  });

  it("classifies fake Spotify 401 and 403 conversion failures without exposing provider details", async () => {
    const config = () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true });
    const token = () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" });
    for (const [status, code] of [[401, "SPOTIFY_AUTHENTICATION_REQUIRED"], [403, "SPOTIFY_AUTHORIZATION_REQUIRED"], [429, "SPOTIFY_RATE_LIMITED"], [503, "SPOTIFY_PROVIDER_UNAVAILABLE"]] as const) {
      setSpotifyWebDependenciesForTest({
        convert: vi.fn(async () => { throw new SpotifyApiError(status); }),
        getClientConfig: config,
        getTokenState: token,
      });
      const response = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });
      expect(response).toMatchObject({ body: { code }, status: status === 401 ? 401 : status === 403 ? 403 : status === 429 ? 429 : 503 });
      if (status === 401 || status === 403) expect(response.body).toMatchObject({ phase: "matching" });
      expect(JSON.stringify(response.body)).not.toContain("test-access");
    }
  });

  it("serializes a fake post-match private playlist 403 with only the playlist-create phase", async () => {
    const providerDetail = "provider-body-must-not-leak";
    setSpotifyWebDependenciesForTest({
      convert: async (api) => {
        await api.searchTracks("Artist Song");
        const profile = await api.getProfile();
        await api.createPrivatePlaylist(profile.id, "My playlist");
        throw new Error("unreachable");
      },
      createApi: () => ({
        addTracks: vi.fn(),
        createPrivatePlaylist: vi.fn(async () => { throw Object.assign(new SpotifyApiError(403), { message: providerDetail }); }),
        getProfile: vi.fn(async () => ({ id: "profile-must-not-leak" })),
        searchTracks: vi.fn(async () => []),
      }),
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    const response = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });

    expect(response).toEqual({ body: { code: "SPOTIFY_AUTHORIZATION_REQUIRED", error: "Authorization required", phase: "playlist_create" }, status: 403 });
    expect(JSON.stringify(response.body)).not.toContain(providerDetail);
    expect(JSON.stringify(response.body)).not.toContain("test-access");
  });

  it("returns only normalized conversion-preflight readiness for both providers", async () => {
        const getProfile = vi.fn(async () => ({ accessToken: "must-not-leak", id: "profile-must-not-leak" }));
        setSpotifyWebDependenciesForTest({
          createApi: () => ({ addTracks: vi.fn(), createPrivatePlaylist: vi.fn(), getProfile, searchTracks: vi.fn() }),
          getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
          getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
          validateYtMusicAuth: async () => ({ status: "valid" }),
        });

        await expect(request("/api/conversion-preflight", { destination: "spotify" })).resolves.toEqual({ body: { status: "ready" }, status: 200 });
        await expect(request("/api/conversion-preflight", { destination: "youtube" })).resolves.toEqual({ body: { status: "ready" }, status: 200 });
        expect(getProfile).toHaveBeenCalledOnce();

        setSpotifyWebDependenciesForTest({ getTokenState: () => null, validateYtMusicAuth: async () => ({ status: "invalid", reason: "authentication_required" }) });
        await expect(request("/api/conversion-preflight", { destination: "spotify" })).resolves.toEqual({ body: { code: "AUTHENTICATION_REQUIRED", status: "not_ready" }, status: 200 });
        await expect(request("/api/conversion-preflight", { destination: "youtube" })).resolves.toEqual({ body: { code: "AUTHENTICATION_REQUIRED", status: "not_ready" }, status: 200 });
      });

      it("maps fake Spotify profile authorization failures to the bounded preflight result", async () => {
    setSpotifyWebDependenciesForTest({
      createApi: () => ({ addTracks: vi.fn(), createPrivatePlaylist: vi.fn(), getProfile: vi.fn(async () => { throw Object.assign(new SpotifyApiError(403), { message: "provider-body-must-not-leak" }); }), searchTracks: vi.fn() }),
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    await expect(request("/api/conversion-preflight", { destination: "spotify" })).resolves.toEqual({ body: { code: "AUTHORIZATION_REQUIRED", phase: "preflight_profile", status: "not_ready" }, status: 200 });
  });

  it("maps unavailable providers and invalid destinations to the bounded preflight result", async () => {
        setSpotifyWebDependenciesForTest({
          getClientConfig: () => ({ clientId: null, enabled: false, reason: "SPOTIFY_CONFIGURATION_REQUIRED", redirectUri: null, supported: true }),
          validateYtMusicAuth: async () => ({ status: "unexpected_failure" }),
        });

        await expect(request("/api/conversion-preflight", { destination: "spotify" })).resolves.toEqual({ body: { code: "PROVIDER_UNAVAILABLE", status: "not_ready" }, status: 200 });
        await expect(request("/api/conversion-preflight", { destination: "youtube" })).resolves.toEqual({ body: { code: "PROVIDER_UNAVAILABLE", status: "not_ready" }, status: 200 });
        await expect(request("/api/conversion-preflight", { destination: "unsupported" })).resolves.toEqual({ body: { code: "PROVIDER_UNAVAILABLE", status: "not_ready" }, status: 400 });
      });

      it("supports Spotify manual search and safe bulk add while rejecting disconnected, invalid, and partial requests", async () => {
    const api = {
      addTracks: vi.fn(async () => ({ cancelled: false, insertedUris: ["spotify:track:1"] })),
      createPrivatePlaylist: vi.fn(),
      getProfile: vi.fn(),
      searchTracks: vi.fn(async () => [{ artists: [{ name: "Artist" }], id: "1", title: "Song", uri: "spotify:track:1" }]),
    };
    setSpotifyWebDependenciesForTest({
      createApi: () => api,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    await expect(request("/api/spotify/search-single", { limit: 5, offset: 0, query: "Artist Song" })).resolves.toMatchObject({ body: { hasMore: false, results: [expect.objectContaining({ uri: "spotify:track:1" })] }, status: 200 });
    await expect(request("/api/spotify/add-to-playlist", { playlistId: "playlist-1", tracks: [{ uri: "youtube:video:unsafe" }] })).resolves.toMatchObject({ body: { error: "A playlist and selected tracks are required" }, status: 400 });
    await expect(request("/api/spotify/add-to-playlist", { playlistId: "playlist-1", tracks: [{ uri: "spotify:track:1" }] })).resolves.toMatchObject({ body: { count: 1, success: true }, status: 200 });
    await expect(request("/api/spotify/add-to-playlist", { playlistId: "playlist-1", tracks: [{ uri: "spotify:track:1" }, { uri: "spotify:track:2" }] })).resolves.toMatchObject({ body: { error: "Could not confirm all selected tracks were added" }, status: 502 });

    await expect(request("/api/spotify/search-single", { limit: 5, offset: 5, query: "Artist Song" })).resolves.toMatchObject({ body: { hasMore: false }, status: 200 });
    await expect(request("/api/spotify/search-single", { limit: 5, offset: 10, query: "Artist Song" })).resolves.toMatchObject({ body: { hasMore: false }, status: 200 });
    await expect(request("/api/spotify/search-single", { limit: 10, offset: 0, query: "Artist Song" })).resolves.toMatchObject({ status: 400 });
    await expect(request("/api/spotify/search-single", { limit: 5, offset: 15, query: "Artist Song" })).resolves.toMatchObject({ status: 400 });
    expect(api.searchTracks).toHaveBeenNthCalledWith(1, "Artist Song", 5, 0);
    expect(api.searchTracks).toHaveBeenNthCalledWith(2, "Artist Song", 5, 5);
    expect(api.searchTracks).toHaveBeenNthCalledWith(3, "Artist Song", 5, 10);

    setSpotifyWebDependenciesForTest({ getTokenState: () => null });
    await expect(request("/api/spotify/search-single", { limit: 5, offset: 0, query: "Artist Song" })).resolves.toMatchObject({ body: { code: "SPOTIFY_AUTHENTICATION_REQUIRED" }, status: 401 });
    await expect(request("/api/convert", { destination: "unsupported", playlistName: "My playlist", tracks: [] })).resolves.toMatchObject({ status: 400 });
  });

  it("refreshes expired fake token state before Spotify operations and persists rotation", async () => {
    const createApi = vi.fn(() => ({ addTracks: vi.fn(), createPrivatePlaylist: vi.fn(), getProfile: vi.fn(), searchTracks: vi.fn(async () => []) }));
    const writeTokenState = vi.fn();
    const refreshToken = vi.fn(async (clientId: string, currentTokenState: { refreshToken: string }) => {
      expect(clientId).toBe("test-client");
      expect(currentTokenState.refreshToken).toBe("old-refresh");
      return { accessToken: "rotated-access", expiresAtEpochMs: 999_999, refreshToken: "rotated-refresh", scope: "playlist-modify-private", tokenType: "Bearer" };
    });
    setSpotifyWebDependenciesForTest({
      createApi,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "expired-access", expiresAtEpochMs: 1, refreshToken: "old-refresh", scope: "playlist-modify-private", tokenType: "Bearer" }),
      now: () => 100_000,
      refreshToken,
      writeTokenState,
    });
    await expect(request("/api/spotify/search-single", { limit: 5, offset: 0, query: "Artist Song" })).resolves.toMatchObject({ status: 200 });
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(writeTokenState).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }));
    expect(createApi).toHaveBeenCalledWith("rotated-access");
  });

  it("maps fake refresh failure to bounded authentication-required output", async () => {
    setSpotifyWebDependenciesForTest({
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "expired-access", expiresAtEpochMs: 1, refreshToken: "old-refresh", scope: "playlist-modify-private", tokenType: "Bearer" }),
      now: () => 100_000,
      refreshToken: vi.fn(async () => null),
    });
    const result = await request("/api/spotify/search-single", { limit: 5, offset: 0, query: "Artist Song" });
    expect(result).toEqual({ body: { code: "SPOTIFY_AUTHENTICATION_REQUIRED", error: "Authentication required" }, status: 401 });
    expect(JSON.stringify(result.body)).not.toContain("expired-access");
  });
});
