import { createHash, randomBytes } from "node:crypto";
import type { SpotifyClientConfig, SpotifyFetch, SpotifyProfile, SpotifyTokenState } from "./types";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const DEFAULT_SCOPE = "playlist-modify-private";
const DEFAULT_TTL_MS = 10 * 60 * 1_000;

type ActiveAttempt = {
  codeVerifier: string;
  expiresAtEpochMs: number;
  returnOrigin: string;
  state: string;
};

type CancelledAttempt = {
  expiresAtEpochMs: number;
  returnOrigin: string;
  state: string;
};

export type SpotifyAuthSafeReason =
  | "SPOTIFY_CONFIGURATION_REQUIRED"
  | "SPOTIFY_WINDOWS_ONLY"
  | "SPOTIFY_AUTH_DENIED"
  | "SPOTIFY_AUTH_CANCELLED"
  | "SPOTIFY_AUTH_STATE_INVALID"
  | "SPOTIFY_AUTH_STATE_EXPIRED"
  | "SPOTIFY_AUTH_EXCHANGE_FAILED"
  | "SPOTIFY_AUTH_ORIGIN_INVALID"
  | "SPOTIFY_AUTHORIZATION_REQUIRED";

export type SpotifyAuthStartResult =
  | { status: "started"; authorizeUrl: string; expiresAtEpochMs: number }
  | { status: "error"; reason: SpotifyAuthSafeReason };

export type SpotifyAuthCallbackResult =
  | { returnOrigin: string; status: "connected" }
  | { returnOrigin?: string; status: "error"; reason: SpotifyAuthSafeReason };

export type SpotifyAuthStatusResult = {
  configured: boolean;
  supported: boolean;
  connected: boolean;
  reason: SpotifyAuthSafeReason | null;
  profile?: SpotifyProfile;
};

export type ExchangeRequest = {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type SpotifyTokenExchangeProvider =
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "malformed_response"
  | "network_error"
  | "provider_error"
  | "rate_limited"
  | "missing_scope";

export type SpotifyTokenExchangeDiagnostic = {
  provider: SpotifyTokenExchangeProvider;
  status: number | null;
};

export type SpotifyTokenExchangeResult = {
  diagnostic: SpotifyTokenExchangeDiagnostic | null;
  tokenState: SpotifyTokenState | null;
};

type RefreshRequest = {
  clientId: string;
  refreshToken: string;
};

type AuthorizationRequiredExchange = { authorizationRequired: true };

type SpotifyOAuthManagerOptions = {
  deleteTokenState?: () => void;
  exchangeAuthorizationCode?: (request: ExchangeRequest) => Promise<SpotifyTokenState | AuthorizationRequiredExchange | null>;
  getClientConfig: () => SpotifyClientConfig;
  now?: () => number;
  readTokenState: () => SpotifyTokenState | null;
  refreshAccessToken?: (request: RefreshRequest) => Promise<SpotifyTokenState | null>;
  ttlMs?: number;
  writeTokenState: (tokenState: SpotifyTokenState) => void;
};

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createRandomToken(size: number, random: (size: number) => Buffer): string {
  return encodeBase64Url(random(size));
}

export function createPkcePair(random: (size: number) => Buffer = randomBytes): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = createRandomToken(64, random);
  const codeChallenge = encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function createState(random: (size: number) => Buffer = randomBytes): string {
  return createRandomToken(32, random);
}

function buildAuthorizeUrl(config: SpotifyClientConfig & { clientId: string }, state: string, codeChallenge: string): string {
  const authorizeUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", DEFAULT_SCOPE);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return authorizeUrl.toString();
}

function exchangeProviderCategory(value: unknown, status: number): SpotifyTokenExchangeProvider {
  if (value === "invalid_client" || value === "invalid_grant" || value === "invalid_request") return value;
  if (status === 429) return "rate_limited";
  return "provider_error";
}

function isSpotifyTokenState(value: unknown): value is SpotifyTokenState {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return typeof token.accessToken === "string" && Boolean(token.accessToken)
    && typeof token.refreshToken === "string" && Boolean(token.refreshToken)
    && typeof token.tokenType === "string" && Boolean(token.tokenType)
    && typeof token.scope === "string"
    && typeof token.expiresAtEpochMs === "number" && Number.isFinite(token.expiresAtEpochMs);
}

export function hasSpotifyPlaylistModifyPrivateScope(scope: string): boolean {
  return scope.split(/\s+/).includes(DEFAULT_SCOPE);
}

function tokenStateFromResponse(value: unknown, now: () => number): SpotifyTokenState | null {
  if (!value || typeof value !== "object") return null;
  const token = value as Record<string, unknown>;
  if (typeof token.access_token !== "string" || !token.access_token
    || typeof token.refresh_token !== "string" || !token.refresh_token
    || typeof token.token_type !== "string" || !token.token_type
    || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) return null;

  return {
    accessToken: token.access_token,
    expiresAtEpochMs: now() + Math.floor(token.expires_in * 1_000),
    refreshToken: token.refresh_token,
    scope: typeof token.scope === "string" ? token.scope : "",
    tokenType: token.token_type,
  };
}

/** Exchanges a Spotify authorization code as a public PKCE client; it never accepts a client secret. */
export async function exchangeSpotifyAuthorizationCode(options: ExchangeRequest & {
  fetch?: SpotifyFetch;
  now?: () => number;
}): Promise<SpotifyTokenExchangeResult> {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(SPOTIFY_TOKEN_URL, {
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    return { diagnostic: { provider: "network_error", status: null }, tokenState: null };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { diagnostic: { provider: response.ok ? "malformed_response" : "provider_error", status: response.status }, tokenState: null };
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" ? (payload as Record<string, unknown>).error : undefined;
    return { diagnostic: { provider: exchangeProviderCategory(error, response.status), status: response.status }, tokenState: null };
  }

  const tokenState = tokenStateFromResponse(payload, now);
  if (!tokenState) return { diagnostic: { provider: "malformed_response", status: response.status }, tokenState: null };
  return hasSpotifyPlaylistModifyPrivateScope(tokenState.scope)
    ? { diagnostic: null, tokenState }
    : { diagnostic: { provider: "missing_scope", status: response.status }, tokenState: null };
}

/** Refreshes a public PKCE client token without a client secret. */
export async function refreshSpotifyAccessToken(options: {
  clientId: string;
  currentTokenState: SpotifyTokenState;
  fetch?: SpotifyFetch;
  now?: () => number;
}): Promise<SpotifyTokenState | null> {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: "refresh_token",
    refresh_token: options.currentTokenState.refreshToken,
  });
  let response: Response;
  try {
    response = await fetch(SPOTIFY_TOKEN_URL, {
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!response.ok || !payload || typeof payload !== "object") return null;
  const token = payload as Record<string, unknown>;
  if (typeof token.access_token !== "string" || !token.access_token
    || typeof token.token_type !== "string" || !token.token_type
    || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) return null;
  const refreshed = {
    accessToken: token.access_token,
    expiresAtEpochMs: now() + Math.floor(token.expires_in * 1_000),
    refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : options.currentTokenState.refreshToken,
    scope: typeof token.scope === "string" ? token.scope : options.currentTokenState.scope,
    tokenType: token.token_type,
    ...(options.currentTokenState.profile ? { profile: options.currentTokenState.profile } : {}),
  };
  return hasSpotifyPlaylistModifyPrivateScope(refreshed.scope) ? refreshed : null;
}

export function renderSpotifyAuthCallbackPage(result: SpotifyAuthCallbackResult): string {
  const safeReason = result.status === "error" ? result.reason : "none";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spotify Auth</title>
  </head>
  <body>
    <main data-status="${result.status}" data-reason="${safeReason}">
      <p>${result.status}</p>
      <p>${safeReason}</p>
    </main>
  </body>
</html>`;
}

function isExpired(now: number, expiresAtEpochMs: number): boolean {
  return now > expiresAtEpochMs;
}

function isExpectedLocalAppOrigin(value: unknown, redirectUri: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(value);
    const callback = new URL(redirectUri);
    return value === origin.origin
      && origin.protocol === "http:"
      && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
      && origin.port === callback.port;
  } catch {
    return false;
  }
}

export function createSpotifyOAuthManager(options: SpotifyOAuthManagerOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let activeAttempt: ActiveAttempt | null = null;
  let cancelledAttempt: CancelledAttempt | null = null;

  function clearExpiredMemory(): void {
    const currentTime = now();
    if (activeAttempt && isExpired(currentTime, activeAttempt.expiresAtEpochMs)) activeAttempt = null;
    if (cancelledAttempt && isExpired(currentTime, cancelledAttempt.expiresAtEpochMs)) cancelledAttempt = null;
  }

  function start(returnOrigin?: unknown): SpotifyAuthStartResult {
    clearExpiredMemory();
    const config = options.getClientConfig();
    if (!config.supported) return { status: "error", reason: "SPOTIFY_WINDOWS_ONLY" };
    if (!config.enabled || !config.clientId) return { status: "error", reason: "SPOTIFY_CONFIGURATION_REQUIRED" };
    if (!isExpectedLocalAppOrigin(returnOrigin, config.redirectUri)) return { status: "error", reason: "SPOTIFY_AUTH_ORIGIN_INVALID" };

    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createState();
    const expiresAtEpochMs = now() + ttlMs;
    activeAttempt = { codeVerifier, expiresAtEpochMs, returnOrigin, state };
    cancelledAttempt = null;

    return {
      status: "started",
      authorizeUrl: buildAuthorizeUrl({ ...config, clientId: config.clientId }, state, codeChallenge),
      expiresAtEpochMs,
    };
  }

  async function handleCallback(query: { code?: unknown; error?: unknown; state?: unknown }): Promise<SpotifyAuthCallbackResult> {
    if (cancelledAttempt && isExpired(now(), cancelledAttempt.expiresAtEpochMs)) cancelledAttempt = null;
    const state = typeof query.state === "string" ? query.state.trim() : "";

    if (typeof query.error === "string" && query.error.trim()) {
      const attempt = activeAttempt?.state === state ? activeAttempt : cancelledAttempt?.state === state ? cancelledAttempt : null;
      if (activeAttempt?.state === state) activeAttempt = null;
      if (cancelledAttempt?.state === state) cancelledAttempt = null;
      return { returnOrigin: attempt?.returnOrigin, status: "error", reason: "SPOTIFY_AUTH_DENIED" };
    }

    if (!state) return { status: "error", reason: "SPOTIFY_AUTH_STATE_INVALID" };
    if (cancelledAttempt?.state === state) {
      const returnOrigin = cancelledAttempt.returnOrigin;
      cancelledAttempt = null;
      return { returnOrigin, status: "error", reason: "SPOTIFY_AUTH_CANCELLED" };
    }
    if (!activeAttempt || activeAttempt.state !== state) return { status: "error", reason: "SPOTIFY_AUTH_STATE_INVALID" };
    if (isExpired(now(), activeAttempt.expiresAtEpochMs)) {
      const returnOrigin = activeAttempt.returnOrigin;
      activeAttempt = null;
      return { returnOrigin, status: "error", reason: "SPOTIFY_AUTH_STATE_EXPIRED" };
    }

    const code = typeof query.code === "string" ? query.code.trim() : "";
    if (!code) {
      const returnOrigin = activeAttempt.returnOrigin;
      activeAttempt = null;
      return { returnOrigin, status: "error", reason: "SPOTIFY_AUTH_STATE_INVALID" };
    }

    const currentAttempt = activeAttempt;
    activeAttempt = null;
    const config = options.getClientConfig();
    if (!config.enabled || !config.clientId || !config.supported) {
      return { returnOrigin: currentAttempt.returnOrigin, status: "error", reason: config.supported ? "SPOTIFY_CONFIGURATION_REQUIRED" : "SPOTIFY_WINDOWS_ONLY" };
    }

    const tokenState = options.exchangeAuthorizationCode
      ? await options.exchangeAuthorizationCode({
          clientId: config.clientId,
          code,
          codeVerifier: currentAttempt.codeVerifier,
          redirectUri: config.redirectUri,
        })
      : null;

    if (tokenState && "authorizationRequired" in tokenState && tokenState.authorizationRequired) {
      return { returnOrigin: currentAttempt.returnOrigin, status: "error", reason: "SPOTIFY_AUTHORIZATION_REQUIRED" };
    }
    if (!isSpotifyTokenState(tokenState)) return { returnOrigin: currentAttempt.returnOrigin, status: "error", reason: "SPOTIFY_AUTH_EXCHANGE_FAILED" };
    if (!hasSpotifyPlaylistModifyPrivateScope(tokenState.scope)) {
      return { returnOrigin: currentAttempt.returnOrigin, status: "error", reason: "SPOTIFY_AUTHORIZATION_REQUIRED" };
    }
    options.writeTokenState(tokenState);
    return { returnOrigin: currentAttempt.returnOrigin, status: "connected" };
  }

  function status(): SpotifyAuthStatusResult {
    clearExpiredMemory();
    const config = options.getClientConfig();
    const tokenState = options.readTokenState();
    return {
      configured: Boolean(config.clientId && config.enabled),
      supported: config.supported,
      connected: Boolean(tokenState),
      reason: config.supported ? (config.enabled ? null : "SPOTIFY_CONFIGURATION_REQUIRED") : "SPOTIFY_WINDOWS_ONLY",
      ...(tokenState?.profile ? { profile: tokenState.profile } : {}),
    };
  }

  function cancel(): { status: "idle" | "cancelled" } {
    clearExpiredMemory();
    if (!activeAttempt) return { status: "idle" };
    cancelledAttempt = { state: activeAttempt.state, returnOrigin: activeAttempt.returnOrigin, expiresAtEpochMs: activeAttempt.expiresAtEpochMs };
    activeAttempt = null;
    return { status: "cancelled" };
  }

  function disconnect(): { status: "idle"; connected: false } {
    activeAttempt = null;
    cancelledAttempt = null;
    options.deleteTokenState?.();
    return { status: "idle", connected: false };
  }

  async function refresh(): Promise<SpotifyTokenState | null> {
    const config = options.getClientConfig();
    const currentTokenState = options.readTokenState();
    if (!config.enabled || !config.clientId || !options.refreshAccessToken || !currentTokenState) return null;
    const refreshed = await options.refreshAccessToken({ clientId: config.clientId, refreshToken: currentTokenState.refreshToken });
    if (!isSpotifyTokenState(refreshed) || !hasSpotifyPlaylistModifyPrivateScope(refreshed.scope)) return null;
    options.writeTokenState(refreshed);
    return refreshed;
  }

  return { cancel, disconnect, handleCallback, refresh, start, status };
}
