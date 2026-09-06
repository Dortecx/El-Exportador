import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpotifyTokenState } from "../src/spotify/types.js";

const serverSource = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
const portableBuildScript = readFileSync(new URL("../scripts/build-portable-win.ps1", import.meta.url), "utf8");

function makeTokenState(overrides: Partial<SpotifyTokenState> = {}): SpotifyTokenState {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAtEpochMs: 123_456,
    scope: "playlist-modify-private",
    tokenType: "Bearer",
    profile: { id: "spotify-user", displayName: "Slice 1B" },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
});

describe("spotify PKCE auth manager", () => {
  it("creates a PKCE authorization attempt with verifier, challenge, TTL, and a safe authorize URL", async () => {
    const { createPkcePair, createSpotifyOAuthManager } = await import("../src/spotify/oauth.js");

    const pair = createPkcePair(() => Buffer.alloc(64, 7));
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const manager = createSpotifyOAuthManager({
      exchangeAuthorizationCode: vi.fn(),
      getClientConfig: () => ({
        clientId: "public-test-id",
        enabled: true,
        reason: null,
        redirectUri: "http://127.0.0.1:4312/api/spotify-auth/callback",
        supported: true,
      }),
      now: () => 50_000,
      readTokenState: () => null,
      writeTokenState: vi.fn(),
    });

    const started = manager.start("http://127.0.0.1:4312");
    expect(started).toMatchObject({ status: "started", expiresAtEpochMs: 650_000 });
    if (started.status !== "started") throw new Error("expected started result");
    const url = new URL(started.authorizeUrl);
    expect(url.origin).toBe("https://accounts.spotify.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("public-test-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4312/api/spotify-auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("playlist-modify-private");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(started.authorizeUrl).not.toContain(pair.codeVerifier);
  });

  it("binds each PKCE attempt to one validated local app origin", async () => {
    const { createSpotifyOAuthManager } = await import("../src/spotify/oauth.js");
    const createManager = () => createSpotifyOAuthManager({
      getClientConfig: () => ({
        clientId: "public-test-id",
        enabled: true,
        reason: null,
        redirectUri: "http://127.0.0.1:4312/api/spotify-auth/callback",
        supported: true,
      }),
      readTokenState: () => null,
      writeTokenState: vi.fn(),
    });

    expect(createManager().start("http://localhost:4312")).toMatchObject({ status: "started" });
    expect(createManager().start("http://127.0.0.1:4312")).toMatchObject({ status: "started" });
    expect(createManager().start()).toEqual({ reason: "SPOTIFY_AUTH_ORIGIN_INVALID", status: "error" });
    expect(createManager().start("http://localhost:4313")).toEqual({ reason: "SPOTIFY_AUTH_ORIGIN_INVALID", status: "error" });
    expect(createManager().start("https://localhost:4312")).toEqual({ reason: "SPOTIFY_AUTH_ORIGIN_INVALID", status: "error" });
    expect(createManager().start("http://evil.test:4312")).toEqual({ reason: "SPOTIFY_AUTH_ORIGIN_INVALID", status: "error" });
  });

  it("rejects start attempts without a public client ID or Windows runtime support", async () => {
    const { createSpotifyOAuthManager } = await import("../src/spotify/oauth.js");

    const missingClientId = createSpotifyOAuthManager({
      getClientConfig: () => ({ enabled: false, supported: true, reason: "SPOTIFY_CONFIGURATION_REQUIRED", redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback" }),
      readTokenState: () => null,
      writeTokenState: vi.fn(),
    });
    expect(missingClientId.start()).toEqual({ reason: "SPOTIFY_CONFIGURATION_REQUIRED", status: "error" });

    const unsupportedRuntime = createSpotifyOAuthManager({
      getClientConfig: () => ({ enabled: false, supported: false, reason: "SPOTIFY_WINDOWS_ONLY", redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback" }),
      readTokenState: () => null,
      writeTokenState: vi.fn(),
    });
    expect(unsupportedRuntime.start()).toEqual({ reason: "SPOTIFY_WINDOWS_ONLY", status: "error" });
  });

  it("rejects invalid, expired, denied, cancelled, exchange-failed, and reused callback state with safe reason codes only", async () => {
    const writeTokenState = vi.fn();
    let currentTime = 10_000;
    const { createSpotifyOAuthManager } = await import("../src/spotify/oauth.js");
    const manager = createSpotifyOAuthManager({
      exchangeAuthorizationCode: vi.fn(async () => makeTokenState()),
      getClientConfig: () => ({
        clientId: "public-test-id",
        enabled: true,
        reason: null,
        redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
        supported: true,
      }),
      now: () => currentTime,
      readTokenState: () => null,
      writeTokenState,
    });

    const started = manager.start("http://127.0.0.1:3000");
    if (started.status !== "started") throw new Error("expected started result");
    const firstState = new URL(started.authorizeUrl).searchParams.get("state");
    if (!firstState) throw new Error("missing state");

    await expect(manager.handleCallback({ code: "fake-code", state: "wrong-state" })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_STATE_INVALID",
      status: "error",
    });
    expect(writeTokenState).not.toHaveBeenCalled();

    currentTime = started.expiresAtEpochMs + 1;
    await expect(manager.handleCallback({ code: "fake-code", state: firstState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_STATE_EXPIRED",
      status: "error",
    });

    currentTime = 20_000;
    const restarted = manager.start("http://127.0.0.1:3000");
    if (restarted.status !== "started") throw new Error("expected restarted result");
    const secondState = new URL(restarted.authorizeUrl).searchParams.get("state");
    if (!secondState) throw new Error("missing second state");
    expect(manager.cancel()).toEqual({ status: "cancelled" });
    await expect(manager.handleCallback({ code: "fake-code", state: secondState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_CANCELLED",
      status: "error",
    });

    const denied = manager.start("http://127.0.0.1:3000");
    if (denied.status !== "started") throw new Error("expected denied result");
    const deniedState = new URL(denied.authorizeUrl).searchParams.get("state");
    if (!deniedState) throw new Error("missing denied state");
    await expect(manager.handleCallback({ error: "access_denied", state: deniedState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_DENIED",
      status: "error",
    });

    const malformed = manager.start("http://127.0.0.1:3000");
    if (malformed.status !== "started") throw new Error("expected malformed result");
    const malformedState = new URL(malformed.authorizeUrl).searchParams.get("state");
    if (!malformedState) throw new Error("missing malformed state");
    await expect(manager.handleCallback({ state: malformedState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_STATE_INVALID",
      status: "error",
    });

    const exchangeFailed = createSpotifyOAuthManager({
      exchangeAuthorizationCode: vi.fn(async () => null),
      getClientConfig: () => ({
        clientId: "public-test-id",
        enabled: true,
        reason: null,
        redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
        supported: true,
      }),
      now: () => 30_000,
      readTokenState: () => null,
      writeTokenState,
    });
    const failed = exchangeFailed.start("http://127.0.0.1:3000");
    if (failed.status !== "started") throw new Error("expected failed result");
    const failedState = new URL(failed.authorizeUrl).searchParams.get("state");
    if (!failedState) throw new Error("missing failed state");
    await expect(exchangeFailed.handleCallback({ code: "fake-code", state: failedState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_EXCHANGE_FAILED",
      status: "error",
    });

    const third = manager.start("http://127.0.0.1:3000");
    if (third.status !== "started") throw new Error("expected third result");
    const thirdState = new URL(third.authorizeUrl).searchParams.get("state");
    if (!thirdState) throw new Error("missing third state");
    await expect(manager.handleCallback({ code: "fake-code", state: thirdState })).resolves.toMatchObject({ returnOrigin: "http://127.0.0.1:3000", status: "connected" });
    await expect(manager.handleCallback({ code: "fake-code", state: thirdState })).resolves.toMatchObject({
      reason: "SPOTIFY_AUTH_STATE_INVALID",
      status: "error",
    });
    expect(writeTokenState).toHaveBeenCalledTimes(1);
  });

  it("keeps fake-only public-client exchange and refresh seams without secrets", async () => {
    const { createSpotifyOAuthManager, refreshSpotifyAccessToken } = await import("../src/spotify/oauth.js");
    const exchangeAuthorizationCode = vi.fn(async (request: Record<string, unknown>) => {
      expect(request.clientSecret).toBeUndefined();
      expect(request.clientId).toBe("public-test-id");
      expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      return makeTokenState({ accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresAtEpochMs: 777_000 });
    });
    const manager = createSpotifyOAuthManager({
      exchangeAuthorizationCode,
      getClientConfig: () => ({ clientId: "public-test-id", enabled: true, reason: null, redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback", supported: true }),
      readTokenState: () => null,
      writeTokenState: vi.fn(),
    });
    const started = manager.start("http://127.0.0.1:3000");
    if (started.status !== "started") throw new Error("expected started result");
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("missing state");
    await expect(manager.handleCallback({ code: "fake-code", state })).resolves.toMatchObject({ returnOrigin: "http://127.0.0.1:3000", status: "connected" });

    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe("client_id=public-test-id&grant_type=refresh_token&refresh_token=fresh-refresh");
      expect(JSON.stringify(init)).not.toContain("secret");
      return new Response(JSON.stringify({ access_token: "renewed-access", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    });
    await expect(refreshSpotifyAccessToken({
      clientId: "public-test-id",
      currentTokenState: makeTokenState({ accessToken: "fresh-access", refreshToken: "fresh-refresh" }),
      fetch,
      now: () => 1_000,
    })).resolves.toMatchObject({ accessToken: "renewed-access", expiresAtEpochMs: 3_601_000, refreshToken: "fresh-refresh" });
  });

  it("persists only tokens granted the private playlist scope", async () => {
    const writeTokenState = vi.fn();
    const manager = (await import("../src/spotify/oauth.js")).createSpotifyOAuthManager({
      exchangeAuthorizationCode: vi.fn(async () => makeTokenState({ scope: "user-read-email" })),
      getClientConfig: () => ({ clientId: "public-test-id", enabled: true, reason: null, redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback", supported: true }),
      readTokenState: () => null,
      writeTokenState,
    });
    const started = manager.start("http://127.0.0.1:3000");
    if (started.status !== "started") throw new Error("expected started result");
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (!state) throw new Error("missing state");
    await expect(manager.handleCallback({ code: "fake-code", state })).resolves.toEqual({ returnOrigin: "http://127.0.0.1:3000", status: "error", reason: "SPOTIFY_AUTHORIZATION_REQUIRED" });
    expect(writeTokenState).not.toHaveBeenCalled();
  });
});

describe("spotify auth route and packaging safety", () => {
  it("adds safe Spotify auth lifecycle routes without altering YouTube auth logout behavior", () => {
    expect(serverSource).toContain('app.post("/api/spotify-auth/start"');
    expect(serverSource).toContain('spotifyAuth.start(req.get("origin"))');
    expect(serverSource).toContain('app.get("/api/spotify-auth/callback"');
    expect(serverSource).toContain("exchangeAuthorizationCode: async (request) =>");
    expect(serverSource).toContain("exchangeSpotifyAuthorizationCode({ ...request, fetch: globalThis.fetch })");
    expect(serverSource).toContain('app.get("/api/spotify-auth/status"');
    expect(serverSource).toContain('app.post("/api/spotify-auth/cancel"');
    expect(serverSource).toContain('app.post("/api/spotify-auth/disconnect"');
    expect(serverSource).toContain('app.post("/api/ytmusic-auth/browser/disconnect", async (_req, res) => {');
    expect(serverSource).toContain("SessionService.logout(res);");

    const spotifyDisconnectSection = serverSource.match(/app\.post\("\/api\/spotify-auth\/disconnect"[\s\S]*?\n\}\);/);
    expect(spotifyDisconnectSection?.[0]).toContain("res.json({ status: \"idle\", connected: false });");
    expect(spotifyDisconnectSection?.[0]).not.toContain("SessionService.logout(res)");
  });

  it("keeps callback and status responses sanitized", async () => {
    const { renderSpotifyAuthCallbackPage } = await import("../src/spotify/oauth.js");
    const callbackPage = renderSpotifyAuthCallbackPage({
      reason: "SPOTIFY_AUTH_EXCHANGE_FAILED",
      status: "error",
    });

    expect(callbackPage).toContain("SPOTIFY_AUTH_EXCHANGE_FAILED");
    expect(callbackPage).not.toContain("access-token");
    expect(callbackPage).not.toContain("refresh-token");
    expect(callbackPage).not.toContain("fake-code");
    expect(serverSource).toContain("configured");
    expect(serverSource).toContain("supported");
    expect(serverSource).toContain("connected");
    expect(serverSource).not.toContain("authorizeUrl).json({ accessToken");
  });

  it("includes required Spotify runtime files while excluding secrets and local state paths from packaging", () => {
    expect(portableBuildScript).toContain('"src\\spotify\\config.ts"');
    expect(portableBuildScript).toContain('"src\\spotify\\tokenStore.ts"');
    expect(portableBuildScript).toContain('"src\\spotify\\types.ts"');
    expect(portableBuildScript).toContain('"src\\spotify\\oauth.ts"');
    expect(portableBuildScript).toContain('".config"');
    expect(portableBuildScript).toContain('"profile"');
    expect(portableBuildScript).toContain('"profiles"');
    expect(portableBuildScript).toContain('"token"');
    expect(portableBuildScript).toContain('"tokens"');
    expect(portableBuildScript).toContain('"credential"');
    expect(portableBuildScript).toContain('"credentials"');
    expect(portableBuildScript).not.toContain("SPOTIFY_CLIENT_SECRET");
    expect(portableBuildScript).not.toContain(path.join(os.homedir(), ".config"));
  });
});
