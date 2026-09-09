import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
import { app, conversionRunCountForTest, resetSpotifyWebDependenciesForTest, setSpotifyWebDependenciesForTest } from "../src/web/server.js";

let server: Server | undefined;
const progressResponses = new Set<Response>();
const progressReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const localUiClientId = "a".repeat(32);
let localUiCapability: string | undefined;

async function localServer() {
  server ??= await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, port };
}

async function issueCapability(clientId = localUiClientId) {
  const { origin } = await localServer();
  const response = await fetch(`${origin}/api/ui-capability?clientId=${clientId}`, { headers: { origin } });
  return { capability: (await response.json()).capability as string, origin };
}

async function capability() {
  const { origin } = await localServer();
  if (localUiCapability) return { capability: localUiCapability, origin };
  const issued = await issueCapability();
  localUiCapability = issued.capability;
  return { capability: localUiCapability, origin };
}

async function request(path: string, body?: Record<string, unknown>) {
  const { origin } = await localServer();
  if (body === undefined) {
    const response = await fetch(`${origin}${path}`);
    return { body: await response.json(), status: response.status };
  }
  const { capability: localCapability } = await capability();
  const payload = path === "/api/convert" ? { ...body, runId: body.runId ?? "b".repeat(32) } : body;
  const response = await fetch(`${origin}${path}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", origin, "x-local-ui-capability": localCapability, "x-local-ui-client": localUiClientId },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
}

function progressReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body!.getReader();
  progressReaders.add(reader);
  return reader;
}

async function progressStream(runId = "b".repeat(32), clientId = localUiClientId, localCapability?: string, signal?: AbortSignal) {
  const { origin } = await localServer();
  const capabilityForStream = localCapability ?? (await capability()).capability;
  const response = await fetch(`${origin}/api/convert-progress?clientId=${clientId}&runId=${runId}&capability=${capabilityForStream}`, { headers: { origin }, signal });
  progressResponses.add(response);
  return response;
}

async function closeTestResources(): Promise<void> {
  await Promise.allSettled([...progressReaders].map((reader) => reader.cancel()));
  await Promise.allSettled([...progressResponses].map((response) => response.body?.cancel() ?? Promise.resolve()));
  progressReaders.clear();
  progressResponses.clear();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  server = undefined;
}

async function noEventWithin(reader: ReadableStreamDefaultReader<Uint8Array>, milliseconds: number): Promise<"cross-delivered" | "isolated"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(() => "cross-delivered" as const),
      new Promise<"isolated">((resolve) => { timer = setTimeout(() => resolve("isolated"), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function captureConversionLogs() {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    error,
    info,
    messages: () => JSON.stringify([...info.mock.calls, ...error.mock.calls]),
    restore: () => {
      info.mockRestore();
      error.mockRestore();
    },
  };
}

afterEach(async () => {
  await closeTestResources();
  resetSpotifyWebDependenciesForTest();
  ytmusic.convertWithYtMusic.mockReset();
  localUiCapability = undefined;
});

describe("Spotify web backend", () => {
  it("binds production startup to loopback", () => {
    const source = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
    expect(source).toContain('app.listen(PORT, "127.0.0.1"');
    expect(source).not.toContain("Access-Control-Allow-Origin', '*");
  });

  it("binds the app to loopback and rejects wildcard CORS, foreign origins, and missing capabilities", async () => {
    const { origin } = await localServer();
    const readOnly = await fetch(`${origin}/api/destinations`, { headers: { origin: "http://evil.example" } });
    expect(readOnly.headers.get("access-control-allow-origin")).toBeNull();

    const rejected = await fetch(`${origin}/api/spotify-auth/disconnect`, {
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      method: "POST",
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

    await capability();
    const missingOrInvalidCapability = await fetch(`${origin}/api/spotify-auth/disconnect`, {
      headers: { "content-type": "application/json", origin, "x-local-ui-capability": "invalid", "x-local-ui-client": localUiClientId },
      method: "POST",
    });
    expect(missingOrInvalidCapability.status).toBe(403);
    const rejectedStream = await fetch(`${origin}/api/convert-progress?clientId=${localUiClientId}&runId=${"b".repeat(32)}&capability=invalid`, { headers: { origin } });
    expect(rejectedStream.status).toBe(403);
    await expect(request("/api/spotify-auth/disconnect", {})).resolves.toMatchObject({ status: 200 });
  });

  it("does not cross-deliver fake SSE conversion events between opaque runs", async () => {
    const convert = vi.fn(async (_api, tracks, options) => {
      options.onProgress?.(1, tracks.length, tracks[0].artist, tracks[0].title, "searching");
      return { cancelled: false, outcomes: [{ candidate: { uri: "spotify:track:1" }, source: tracks[0], status: "matched" as const }], remotePlaylist: { status: "not-created" as const } };
    });
    setSpotifyWebDependenciesForTest({
      convert,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });
    const firstRun = "d".repeat(32);
    const secondRun = "e".repeat(32);
    const secondClient = "f".repeat(32);
    const secondCapability = (await issueCapability(secondClient)).capability;
    const firstStream = await progressStream(firstRun);
    const wrongRunStream = await progressStream(firstRun, secondClient, secondCapability);
    expect(wrongRunStream.status).toBe(403);
    const secondStream = await progressStream(secondRun, secondClient, secondCapability);
    const firstReader = progressReader(firstStream);
    const secondReader = progressReader(secondStream);

    await request("/api/convert", { destination: "spotify", dryRun: true, playlistName: "My playlist", runId: firstRun, tracks: [{ artist: "Artist", title: "Song" }] });

    const firstEvent = new TextDecoder().decode((await firstReader.read()).value);
    expect(firstEvent).toContain('"type":"progress"');
    expect(await noEventWithin(secondReader, 25)).toBe("isolated");
    await firstReader.cancel();
    await secondReader.cancel();
  });

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

  it("logs one sanitized Spotify conversion start and completion summary", async () => {
    const logs = captureConversionLogs();
    try {
      setSpotifyWebDependenciesForTest({
        convert: vi.fn(async () => ({
          cancelled: false,
          outcomes: [
            { candidate: { uri: "spotify:track:secret" }, source: { artist: "Secret Artist", title: "Secret Song" }, status: "matched" as const },
            { alternatives: [], candidate: null, confidence: 0, source: { artist: "Missing Artist", title: "Missing Song" }, status: "unmatched" as const },
            { alternatives: [], candidate: null, confidence: 0.4, source: { artist: "Maybe Artist", title: "Maybe Song" }, status: "ambiguous" as const },
            { reason: "search_error", source: { artist: "Broken Artist", title: "Broken Song" }, status: "search_error" as const },
            { reason: "duplicate", source: { artist: "Skipped Artist", title: "Skipped Song" }, status: "skipped" as const },
          ],
          remotePlaylist: { status: "not-created" as const },
        })),
        getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
        getTokenState: () => ({ accessToken: "secret-access", expiresAtEpochMs: 1, refreshToken: "secret-refresh", scope: "", tokenType: "Bearer" }),
      });

      await expect(request("/api/convert", {
        destination: "spotify",
        dryRun: true,
        playlistName: "Secret Playlist",
        tracks: [{ artist: "Secret Artist", title: "Secret Song" }],
      })).resolves.toMatchObject({ status: 200 });

      expect(logs.info.mock.calls).toEqual([
        ["conversion.start", { destination: "spotify", total: 1, dryRun: true }],
        ["conversion.complete", { destination: "spotify", total: 1, matched: 1, unmatched: 1, ambiguous: 1, skipped: 1, searchErrors: 1 }],
      ]);
      expect(logs.error).not.toHaveBeenCalled();
      expect(logs.messages()).not.toContain("Secret Artist");
      expect(logs.messages()).not.toContain("Secret Song");
      expect(logs.messages()).not.toContain("Secret Playlist");
      expect(logs.messages()).not.toContain("spotify:track:secret");
      expect(logs.messages()).not.toContain("secret-access");
      expect(logs.messages()).not.toContain("secret-refresh");
    } finally {
      logs.restore();
    }
  });

  it("logs one sanitized Spotify terminal failure without raw provider details", async () => {
    const logs = captureConversionLogs();
    try {
      setSpotifyWebDependenciesForTest({
        convert: vi.fn(async () => { throw Object.assign(new SpotifyApiError(403), { message: "provider-body-secret" }); }),
        getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
        getTokenState: () => ({ accessToken: "secret-access", expiresAtEpochMs: 1, refreshToken: "secret-refresh", scope: "", tokenType: "Bearer" }),
      });

      await expect(request("/api/convert", {
        destination: "spotify",
        playlistName: "Secret Playlist",
        tracks: [{ artist: "Secret Artist", title: "Secret Song" }],
      })).resolves.toMatchObject({ body: { code: "SPOTIFY_AUTHORIZATION_REQUIRED" }, status: 403 });

      expect(logs.info.mock.calls).toEqual([["conversion.start", { destination: "spotify", total: 1, dryRun: false }]]);
      expect(logs.error.mock.calls).toEqual([["conversion.failed", { destination: "spotify", code: "SPOTIFY_AUTHORIZATION_REQUIRED", phase: "matching" }]]);
      expect(logs.messages()).not.toContain("provider-body-secret");
      expect(logs.messages()).not.toContain("Secret Artist");
      expect(logs.messages()).not.toContain("Secret Song");
      expect(logs.messages()).not.toContain("Secret Playlist");
      expect(logs.messages()).not.toContain("secret-access");
      expect(logs.messages()).not.toContain("secret-refresh");
    } finally {
      logs.restore();
    }
  });

  it("logs sanitized YouTube conversion lifecycle without track details", async () => {
    const logs = captureConversionLogs();
    try {
      ytmusic.convertWithYtMusic.mockResolvedValue({
        ambiguousTracks: [{ artist: "Maybe Artist", title: "Maybe Song" }],
        manualReviewTracks: [],
        matched: 1,
        playlistId: "youtube-secret-playlist-id",
        playlistUrl: "https://youtube.test/secret-playlist",
        results: [{ artist: "Broken Artist", reason: "search_error", status: "search_error", title: "Broken Song" }],
        unmatchedTracks: [{ artist: "Missing Artist", title: "Missing Song" }],
      });

      await expect(request("/api/convert", {
        destination: "youtube",
        dryRun: false,
        playlistName: "Secret Playlist",
        tracks: [{ artist: "Secret Artist", title: "Secret Song" }],
      })).resolves.toEqual({ body: { success: true }, status: 200 });

      expect(logs.info.mock.calls).toEqual([
        ["conversion.start", { destination: "youtube", total: 1, dryRun: false }],
        ["conversion.complete", { destination: "youtube", total: 1, matched: 1, unmatched: 1, ambiguous: 1, searchErrors: 1 }],
      ]);
      expect(logs.error).not.toHaveBeenCalled();
      expect(logs.messages()).not.toContain("Secret Artist");
      expect(logs.messages()).not.toContain("Secret Song");
      expect(logs.messages()).not.toContain("Secret Playlist");
      expect(logs.messages()).not.toContain("youtube-secret-playlist-id");
    } finally {
      logs.restore();
    }
  });

  it("returns a bounded indeterminate Spotify creation state without a playlist identifier", async () => {
    setSpotifyWebDependenciesForTest({
      convert: vi.fn(async () => ({ cancelled: true, outcomes: [], remotePlaylist: { status: "indeterminate" as const } })),
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    const result = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });
    expect(result).toEqual({
      body: expect.objectContaining({
        cancelled: true,
        remotePlaylist: { status: "indeterminate" },
        sideEffects: { inserted: "indeterminate", playlist: "indeterminate" },
        success: true,
      }),
      status: 200,
    });
    expect(result.body).not.toHaveProperty("playlistId");
    expect(result.body).not.toHaveProperty("playlistUrl");
  });

  it("reports an indeterminate Spotify add batch while retaining only confirmed additions", async () => {
    setSpotifyWebDependenciesForTest({
      convert: vi.fn(async () => ({
        cancelled: true,
        outcomes: [],
        remotePlaylist: {
          id: "playlist-1",
          indeterminateUris: ["spotify:track:unconfirmed"],
          insertedUris: ["spotify:track:confirmed"],
          status: "partial" as const,
        },
      })),
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });

    const result = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });
    expect(result).toEqual({
      body: expect.objectContaining({
        cancelled: true,
        remotePlaylist: {
          id: "playlist-1",
          indeterminateUris: ["spotify:track:unconfirmed"],
          insertedUris: ["spotify:track:confirmed"],
          status: "partial",
        },
        sideEffects: { inserted: "indeterminate", playlist: "partial" },
        success: true,
      }),
      status: 200,
    });
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
    const progress = await progressStream();
    const reader = progressReader(progress);

    await request("/api/convert", { destination: "spotify", dryRun: true, playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] });

    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const events = chunk.trim().split("\n\n").map((event) => JSON.parse(event.replace(/^data: /, "")));
    expect(events[0]).toMatchObject({ added: 1, artist: "Artist", status: "searching", title: "Song", total: 1, type: "progress" });
  });

  it("streams normalized Spotify manual-review tracks for ambiguous and unmatched outcomes", async () => {
    const ambiguousCandidate = { albumName: "Candidate Album", artists: [{ name: "Candidate Artist" }], id: "candidate-1", title: "Candidate Song", uri: "spotify:track:candidate-1" };
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
    const progress = await progressStream();
    const reader = progressReader(progress);

    const response = await request("/api/convert", {
      destination: "spotify",
      dryRun: true,
      playlistName: "My playlist",
      tracks: [
        { artist: "Source Artist", title: "Ambiguous Song" },
        { artist: "Missing Artist", title: "Missing Song" },
      ],
    });
    expect(response).toMatchObject({
      body: {
        manualReviewTracks: [
          { artist: "Source Artist", status: "ambiguous", title: "Ambiguous Song" },
          { artist: "Missing Artist", status: "unmatched", title: "Missing Song" },
        ],
      },
      status: 200,
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
    const progress = await progressStream();
    const reader = progressReader(progress);

    await expect(request("/api/convert", { playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toEqual({ body: { success: true }, status: 200 });
    expect(ytmusic.convertWithYtMusic).toHaveBeenLastCalledWith(
      [{ artist: "Artist", title: "Song" }],
      "My playlist",
      expect.objectContaining({ threshold: 0.6 }),
      expect.any(Function),
      expect.any(Function),
    );

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
      searchErrorTracks: [],
      searchErrors: 0,
      total: 1,
      type: "result",
      unmatched: 0,
      unmatchedTracks: [],
    });
  });

  it("propagates fake YouTube search errors as retry-needed results without manual review", async () => {
    ytmusic.convertWithYtMusic.mockResolvedValue({
      ambiguousTracks: [],
      manualReviewTracks: [],
      matched: 0,
      playlistId: null,
      playlistUrl: null,
      results: [{ artist: "Artist", bestMatch: null, reason: "search_error", status: "search_error", title: "Song", videoId: null }],
      unmatchedTracks: [],
    });
    const progress = await progressStream();
    const reader = progressReader(progress);

    await expect(request("/api/convert", { playlistName: "My playlist", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toEqual({ body: { success: true }, status: 200 });

    const event = await reader.read();
    await reader.cancel();
    const payload = JSON.parse(new TextDecoder().decode(event.value).replace(/^data: /, "").trim());
    expect(payload).toMatchObject({
      manualReviewTracks: [],
      searchErrors: 1,
      searchErrorTracks: [{ reason: "search_error", status: "search_error" }],
      type: "result",
    });
  });

  it("threads a supplied YouTube threshold to the conversion client while Spotify remains threshold-agnostic", async () => {
    ytmusic.convertWithYtMusic.mockResolvedValue({ ambiguousTracks: [], manualReviewTracks: [], matched: 0, playlistId: null, playlistUrl: null, unmatchedTracks: [] });
    await expect(request("/api/convert", { playlistName: "My playlist", threshold: 0.5, tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toMatchObject({ status: 200 });
    expect(ytmusic.convertWithYtMusic).toHaveBeenLastCalledWith(
      [{ artist: "Artist", title: "Song" }],
      "My playlist",
      expect.objectContaining({ threshold: 0.5 }),
      expect.any(Function),
      expect.any(Function),
    );

    const convert = vi.fn(async () => ({ cancelled: false, outcomes: [], remotePlaylist: { status: "not-created" as const } }));
    setSpotifyWebDependenciesForTest({
      convert,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });
    await expect(request("/api/convert", { destination: "spotify", playlistName: "My playlist", threshold: "ignored", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toMatchObject({ status: 200 });
    expect(convert).toHaveBeenCalledOnce();
  });

  it("rejects invalid supplied YouTube thresholds while leaving Spotify threshold-agnostic", async () => {
    for (const threshold of [null, "0.6", -0.01, 1.01]) {
      await expect(request("/api/convert", {
        playlistName: "My playlist",
        runId: `${String(threshold).replace(/[^a-z0-9]/gi, "x").padEnd(32, "x").slice(0, 32)}`,
        threshold,
        tracks: [{ artist: "Artist", title: "Song" }],
      })).resolves.toMatchObject({ body: { error: "Conversion threshold must be a finite number from 0 to 1" }, status: 400 });
    }

    const convert = vi.fn(async () => ({ cancelled: false, outcomes: [], remotePlaylist: { status: "not-created" as const } }));
    setSpotifyWebDependenciesForTest({
      convert,
      getClientConfig: () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true }),
      getTokenState: () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" }),
    });
    await expect(request("/api/convert", { destination: "spotify", playlistName: "My playlist", threshold: "ignored", tracks: [{ artist: "Artist", title: "Song" }] })).resolves.toMatchObject({ status: 200 });
    expect(convert).toHaveBeenCalledOnce();
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
      const runId = "c".repeat(32);
      const progress = await progressStream(runId);
      const response = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", runId, tracks: [{ artist: "Artist", title: "Song" }] });
      await progress.body?.cancel();
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

    const runId = "c".repeat(32);
    const progress = await progressStream(runId);
    const response = await request("/api/convert", { destination: "spotify", playlistName: "My playlist", runId, tracks: [{ artist: "Artist", title: "Song" }] });
    await progress.body?.cancel();

    expect(response).toEqual({ body: { code: "SPOTIFY_AUTHORIZATION_REQUIRED", error: "Authorization required", phase: "playlist_create" }, status: 403 });
    expect(JSON.stringify(response.body)).not.toContain(providerDetail);
    expect(JSON.stringify(response.body)).not.toContain("test-access");
  });

  it("classifies fake non-dry-run Spotify create and insert rejections without leaking provider content", async () => {
    const config = () => ({ clientId: "test-client", enabled: true, reason: null, redirectUri: "http://localhost/callback", supported: true });
    const token = () => ({ accessToken: "test-access", expiresAtEpochMs: 1, refreshToken: "test-refresh", scope: "", tokenType: "Bearer" });
    const providerDetail = "provider-response-body-must-not-leak";

    for (const [operation, status, phase] of [["create", 400, "playlist_create"], ["insert", 404, "playlist_insert"]] as const) {
      setSpotifyWebDependenciesForTest({
        convert: async (api) => {
          if (operation === "create") await api.createPrivatePlaylist("playlist-id-must-not-leak", "My playlist");
          else await api.addTracks("playlist-id-must-not-leak", ["spotify:track:track-1"]);
          throw new Error("unreachable");
        },
        createApi: () => ({
          addTracks: vi.fn(async () => { throw Object.assign(new SpotifyApiError(status), { message: providerDetail }); }),
          createPrivatePlaylist: vi.fn(async () => { throw Object.assign(new SpotifyApiError(status), { message: providerDetail }); }),
          getProfile: vi.fn(),
          searchTracks: vi.fn(),
        }),
        getClientConfig: config,
        getTokenState: token,
      });

      const runId = `${operation[0]!.repeat(32)}`;
      const progress = await progressStream(runId);
      const response = await request("/api/convert", { destination: "spotify", dryRun: false, playlistName: "My playlist", runId, tracks: [{ artist: "Artist", title: "Song" }] });
      await progress.body?.cancel();

      expect(response).toEqual({
        body: {
          code: "SPOTIFY_REQUEST_REJECTED",
          error: "Spotify rejected the request. Check the playlist details and selected tracks, then try again.",
          phase,
        },
        status,
      });
      expect(JSON.stringify(response.body)).not.toContain(providerDetail);
      expect(JSON.stringify(response.body)).not.toContain("playlist-id-must-not-leak");
      expect(JSON.stringify(response.body)).not.toContain("test-access");
    }
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

  it("installs response-close cleanup and makes repeated close notifications inert", () => {
    const source = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
    expect(source).toContain('res.once("close", onClose);');
    expect(source).toContain("if (conversionRuns.get(runId) !== run) return;");
    expect(source).toContain('client.res.removeListener("close", client.onClose);');
    expect(source).toContain("conversionRuns.delete(runId);");
  });

    it("cancels and removes an in-flight YouTube run after SSE disconnect without unhandled socket rejection", async () => {
    type DeferredConversionResult = { matched: number; playlistId: string; playlistUrl: string; unmatchedTracks: never[]; ambiguousTracks: never[]; manualReviewTracks: never[] };
    let resolveConversion!: (value: DeferredConversionResult) => void;
    const deferredConversion = new Promise<DeferredConversionResult>((resolve) => { resolveConversion = resolve; });
    ytmusic.convertWithYtMusic.mockImplementationOnce(() => deferredConversion);
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    let conversionResult: Promise<unknown> | undefined;
    process.on("unhandledRejection", captureUnhandledRejection);
    try {
      const runId = "g".repeat(32);
      const controller = new AbortController();
      const stream = await progressStream(runId, localUiClientId, undefined, controller.signal);
      const reader = progressReader(stream);
      const abortedRead = reader.read().catch(() => undefined);
      const conversion = request("/api/convert", {
        playlistName: "My playlist", runId, threshold: 0.6, tracks: [{ artist: "Artist", title: "Song" }],
      });
      // Catch immediately so fixture cleanup cannot surface an expected socket close as unhandled.
      conversionResult = conversion.catch((error) => ({ error }));

      await vi.waitFor(() => expect(ytmusic.convertWithYtMusic).toHaveBeenCalledOnce());
      controller.abort();
      await abortedRead;
      await vi.waitFor(() => expect(conversionRunCountForTest()).toBe(0));
      const cancellationPredicate = ytmusic.convertWithYtMusic.mock.calls[0][4] as () => boolean;
      expect(cancellationPredicate()).toBe(true);

      resolveConversion({
        ambiguousTracks: [], manualReviewTracks: [], matched: 1, playlistId: "must-not-be-reported",
        playlistUrl: "https://youtube.test/must-not-be-reported", unmatchedTracks: [],
      });
      await expect(conversionResult).resolves.toEqual({
        body: { cancelled: true, sideEffects: { inserted: "indeterminate", playlist: "indeterminate" }, success: true }, status: 200,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      resolveConversion({
        ambiguousTracks: [], manualReviewTracks: [], matched: 1, playlistId: "must-not-be-reported",
        playlistUrl: "https://youtube.test/must-not-be-reported", unmatchedTracks: [],
      });
      if (conversionResult) await conversionResult;
      process.off("unhandledRejection", captureUnhandledRejection);
    }
  });
});
