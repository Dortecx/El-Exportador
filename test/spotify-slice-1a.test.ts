import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpotifyClientConfig, SpotifyTokenState } from "../src/spotify/types.js";

function makeTempDir(name: string) {
  return path.join(os.tmpdir(), `spotify-slice-1a-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("spotify slice 1A configuration", () => {
  it("enables Spotify only with a public client ID on Windows and resolves a local callback URL", async () => {
    vi.stubEnv("SPOTIFY_CLIENT_ID", "public-test-id");
    const { getSpotifyClientConfig } = await import("../src/spotify/config.js");

    const config = getSpotifyClientConfig({ platform: "win32", port: 4312 }) satisfies SpotifyClientConfig;

    expect(config).toEqual({
      clientId: "public-test-id",
      enabled: true,
      reason: null,
      redirectUri: "http://127.0.0.1:4312/api/spotify-auth/callback",
      supported: true,
    });
  });

  it("disables Spotify when the client ID is absent or the runtime is not Windows", async () => {
    const { getSpotifyClientConfig, resolveSpotifyTokenPath } = await import("../src/spotify/config.js");
    const stateRoot = makeTempDir("state-root");

    expect(getSpotifyClientConfig({ platform: "win32", port: 3000 })).toMatchObject({
      enabled: false,
      reason: "SPOTIFY_CONFIGURATION_REQUIRED",
      supported: true,
    });

    vi.stubEnv("SPOTIFY_CLIENT_ID", "public-test-id");
    expect(getSpotifyClientConfig({ platform: "linux", port: 3000 })).toMatchObject({
      enabled: false,
      reason: "SPOTIFY_WINDOWS_ONLY",
      supported: false,
    });
    expect(resolveSpotifyTokenPath(stateRoot)).toBe(path.join(stateRoot, ".config", "m3u-to-ytmusic", "spotify_tokens.json"));
  });
});

describe("spotify slice 1A token storage", () => {
  it("persists tokens atomically with restrictive local permissions and removes them on disconnect", async () => {
    const stateRoot = makeTempDir("tokens");
    mkdirSync(stateRoot, { recursive: true });
    const { deleteSpotifyTokenState, readSpotifyTokenState, resolveSpotifyTokenStatePath, writeSpotifyTokenState } = await import("../src/spotify/tokenStore.js");

    const tokenPath = resolveSpotifyTokenStatePath(stateRoot);
    const tokenState = {
      accessToken: "access-token",
      expiresAtEpochMs: 123_456,
      profile: { displayName: "Slice One", id: "user-1" },
      refreshToken: "refresh-token",
      scope: "playlist-modify-private",
      tokenType: "Bearer",
    } satisfies SpotifyTokenState;

    writeSpotifyTokenState(tokenState, tokenPath);

    expect(readSpotifyTokenState(tokenPath)).toEqual(tokenState);
    expect(readdirSync(path.dirname(tokenPath)).filter((entry) => entry.includes("spotify_tokens") && entry !== path.basename(tokenPath))).toEqual([]);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    deleteSpotifyTokenState(tokenPath);
    expect(existsSync(tokenPath)).toBe(false);
    expect(readSpotifyTokenState(tokenPath)).toBeNull();
  });

  it("treats malformed token state as disconnected without exposing stored secret material", async () => {
    const stateRoot = makeTempDir("malformed");
    mkdirSync(path.join(stateRoot, ".config", "m3u-to-ytmusic"), { recursive: true });
    const tokenPath = path.join(stateRoot, ".config", "m3u-to-ytmusic", "spotify_tokens.json");
    writeFileSync(tokenPath, '{"accessToken":"secret-access","refreshToken":', "utf8");

    const { readSpotifyTokenState } = await import("../src/spotify/tokenStore.js");

    expect(readSpotifyTokenState(tokenPath)).toBeNull();
  });
});
