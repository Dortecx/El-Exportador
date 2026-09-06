import { describe, expect, it, vi } from "vitest";
import { exchangeSpotifyAuthorizationCode } from "../src/spotify/oauth.js";

describe("Spotify Authorization Code + PKCE exchange", () => {
  it("posts the exact public-client PKCE form without a secret and normalizes the token state", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("https://accounts.spotify.com/api/token");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
      expect(init?.body).toBe("grant_type=authorization_code&client_id=public-client&code=authorization-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fspotify-auth%2Fcallback&code_verifier=stored-verifier");
      expect(JSON.stringify(init)).not.toContain("secret");
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600, refresh_token: "refresh", scope: "playlist-modify-private", token_type: "Bearer" }), { status: 200 });
    });

    await expect(exchangeSpotifyAuthorizationCode({
      clientId: "public-client",
      code: "authorization-code",
      codeVerifier: "stored-verifier",
      fetch,
      now: () => 5_000,
      redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
    })).resolves.toEqual({
      diagnostic: null,
      tokenState: { accessToken: "access", expiresAtEpochMs: 3_605_000, refreshToken: "refresh", scope: "playlist-modify-private", tokenType: "Bearer" },
    });
  });

  it("rejects missing private-playlist scope without returning a token", async () => {
    await expect(exchangeSpotifyAuthorizationCode({
      clientId: "public-client",
      code: "authorization-code",
      codeVerifier: "stored-verifier",
      fetch: vi.fn(async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600, refresh_token: "refresh", scope: "user-read-email", token_type: "Bearer" }), { status: 200 })),
      redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
    })).resolves.toEqual({ diagnostic: { provider: "missing_scope", status: 200 }, tokenState: null });
  });

  it("returns bounded diagnostics without credential material for malformed and provider-error responses", async () => {
    const malformed = await exchangeSpotifyAuthorizationCode({
      clientId: "public-client",
      code: "authorization-code",
      codeVerifier: "stored-verifier",
      fetch: vi.fn(async () => new Response(JSON.stringify({ access_token: "access" }), { status: 200 })),
      redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
    });
    const providerError = await exchangeSpotifyAuthorizationCode({
      clientId: "public-client",
      code: "authorization-code",
      codeVerifier: "stored-verifier",
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "authorization-code stored-verifier public-client" }), { status: 400 })),
      redirectUri: "http://127.0.0.1:3000/api/spotify-auth/callback",
    });

    expect(malformed).toEqual({ diagnostic: { provider: "malformed_response", status: 200 }, tokenState: null });
    expect(providerError).toEqual({ diagnostic: { provider: "invalid_grant", status: 400 }, tokenState: null });
    expect(JSON.stringify([malformed, providerError])).not.toContain("authorization-code");
    expect(JSON.stringify([malformed, providerError])).not.toContain("stored-verifier");
    expect(JSON.stringify([malformed, providerError])).not.toContain("public-client");
  });
});
