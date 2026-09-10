import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { randomBytes, timingSafeEqual } from "crypto";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { parseFile } from "../parser";
import { SessionService } from "../services/session.service";
import { addToPlaylistOnYtMusic, checkYtMusicAvailable, configureYtMusicBrowserAuth, searchSingleOnYtMusic, validateYtMusicAuth, type YTMusicManualSearchResult } from "../ytmusic/client";
import { GuidedBrowserAuth } from "./guidedBrowserAuth";
import { getSpotifyClientConfig } from "../spotify/config";
import { createSpotifyOAuthManager, exchangeSpotifyAuthorizationCode, hasSpotifyPlaylistModifyPrivateScope, refreshSpotifyAccessToken } from "../spotify/oauth";
import { deleteSpotifyTokenState, readSpotifyTokenState, writeSpotifyTokenState } from "../spotify/tokenStore";
import { SpotifyApi, SpotifyApiError } from "../spotify/api";
import { convertSpotifyTracks, type SpotifyConversionApi, type SpotifyConversionOptions } from "../spotify/converter";
import type { SpotifyClientConfig, SpotifyConversionResult, SpotifySourceTrack, SpotifyTokenState, SpotifyTrackMatch } from "../spotify/types";

// Obtener la ruta del directorio actual usando import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local UI capabilities and SSE runs are intentionally process-local and never persisted.
type SseClient = { req: express.Request; res: express.Response; onClose: () => void };
type LocalUiCapability = { capability: string; origin: string };
type ConversionRun = { capability: string; clientId: string; claimed: boolean; cancelled: boolean; clients: Set<SseClient> };
const localUiCapabilities = new Map<string, LocalUiCapability>();
const conversionRuns = new Map<string, ConversionRun>();
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function createOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function localAppOrigin(req: express.Request): string | null {
  const host = req.get("host");
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) return null;
  return `http://${host}`;
}

function hasSameLocalOrigin(req: express.Request): boolean {
  const origin = req.get("origin");
  const expectedOrigin = localAppOrigin(req);
  return Boolean(origin && expectedOrigin && origin === expectedOrigin);
}

function hasCapability(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const actual = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function requireLocalUiMutation(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const clientId = req.get("x-local-ui-client");
  const capability = req.get("x-local-ui-capability");
  const origin = localAppOrigin(req);
  const registered = typeof clientId === "string" ? localUiCapabilities.get(clientId) : undefined;
  if (!hasSameLocalOrigin(req) || !origin || !registered || registered.origin !== origin || !hasCapability(capability, registered.capability)) {
    res.status(403).json({ error: "Local UI authorization required" });
    return;
  }
  next();
}

function conversionRunForRequest(req: express.Request): { runId: string; run: ConversionRun } | null {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
  const clientId = req.get("x-local-ui-client");
  const capability = req.get("x-local-ui-capability");
  const registered = typeof clientId === "string" ? localUiCapabilities.get(clientId) : undefined;
  if (!OPAQUE_ID_PATTERN.test(runId) || typeof clientId !== "string" || !registered || !hasCapability(capability, registered.capability)) return null;
  const run = conversionRuns.get(runId) ?? { capability: registered.capability, clientId, claimed: false, cancelled: false, clients: new Set<SseClient>() };
  if (run.clientId !== clientId || !hasCapability(capability, run.capability)) return null;
  conversionRuns.set(runId, run);
  return { runId, run };
}

function sendToRun(runId: string, event: { type: string; [key: string]: unknown }): void {
  const run = conversionRuns.get(runId);
  run?.clients.forEach((client) => {
    try {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error("Error sending conversion event:", err);
    }
  });
}

function cancelDisconnectedRun(runId: string, run: ConversionRun): void {
  if (conversionRuns.get(runId) !== run) return;
  run.cancelled = true;
  conversionRuns.delete(runId);
  for (const client of run.clients) {
    client.req.removeListener("close", client.onClose);
    client.res.removeListener("close", client.onClose);
    if (!client.res.destroyed && !client.res.writableEnded) client.res.end();
  }
  run.clients.clear();
}

export const app = express();
const guidedBrowserAuth = new GuidedBrowserAuth(configureYtMusicBrowserAuth);
const PORT = parseInt(process.env.PORT || "3000", 10);

type SpotifyWebDependencies = {
  convert: (api: SpotifyConversionApi, tracks: SpotifySourceTrack[], options: SpotifyConversionOptions) => Promise<SpotifyConversionResult>;
  createApi: (accessToken: string) => SpotifyConversionApi;
  getClientConfig: () => SpotifyClientConfig;
  getTokenState: () => SpotifyTokenState | null;
  now: () => number;
  refreshToken: (clientId: string, currentTokenState: SpotifyTokenState) => Promise<SpotifyTokenState | null>;
  writeTokenState: (tokenState: SpotifyTokenState) => void;
  isYtMusicAvailable: () => Promise<boolean>;
  validateYtMusicAuth: () => ReturnType<typeof validateYtMusicAuth>;
};

const defaultSpotifyWebDependencies: SpotifyWebDependencies = {
  convert: convertSpotifyTracks,
  createApi: (accessToken) => new SpotifyApi({ accessToken, fetch: globalThis.fetch }),
  getClientConfig: () => getSpotifyClientConfig({ port: PORT }),
  getTokenState: readSpotifyTokenState,
  now: Date.now,
  refreshToken: (clientId, currentTokenState) => refreshSpotifyAccessToken({ clientId, currentTokenState, fetch: globalThis.fetch }),
  writeTokenState: writeSpotifyTokenState,
  isYtMusicAvailable: checkYtMusicAvailable,
  validateYtMusicAuth,
};
let spotifyWebDependencies = defaultSpotifyWebDependencies;

/** Test-only HTTP seams; production keeps using the local token store and Spotify API client. */
export function setSpotifyWebDependenciesForTest(overrides: Partial<SpotifyWebDependencies>): void {
  spotifyWebDependencies = { ...spotifyWebDependencies, ...overrides };
}

export function resetSpotifyWebDependenciesForTest(): void {
  spotifyWebDependencies = defaultSpotifyWebDependencies;
  localUiCapabilities.clear();
  conversionRuns.clear();
}

/** Test-only visibility into process-local SSE run cleanup. */
export function conversionRunCountForTest(): number {
  return conversionRuns.size;
}

/** Returns a callback page that exposes only the local auth outcome to its opener. */
export function renderSpotifyCallbackReturnPage(result: { returnOrigin?: string; status: string }): string {
  const connected = result.status === "connected";
  const status = connected ? "connected" : "error";
  const reason = connected ? "null" : '"authentication_failed"';
  const targetOrigin = typeof result.returnOrigin === "string" ? JSON.stringify(result.returnOrigin) : "null";
  const heading = connected ? "Spotify connected" : "Spotify connection failed";
  const message = connected
    ? "You can return to El Exportador."
    : "Return to El Exportador to try again.";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head><body><p>${message}</p><script>(() => {
    const message = { type: "spotify-auth-complete", status: "${status}", reason: ${reason} };
    const targetOrigin = ${targetOrigin};
    if (window.opener && window.opener !== window && targetOrigin) {
      window.opener.postMessage(message, targetOrigin);
      window.close();
      return;
    }
    window.location.replace("/");
  })();</script></body></html>`;
}

async function spotifyConnection(): Promise<{ api?: SpotifyConversionApi; code?: string; status: number }> {
  const config = spotifyWebDependencies.getClientConfig();
  if (!config.enabled || !config.clientId) return { code: config.reason ?? "SPOTIFY_CONFIGURATION_REQUIRED", status: 503 };
  let tokenState = spotifyWebDependencies.getTokenState();
  if (!tokenState) return { code: "SPOTIFY_AUTHENTICATION_REQUIRED", status: 401 };
  const shouldRefresh = tokenState.expiresAtEpochMs <= spotifyWebDependencies.now() + 60_000;
  const testDefaultRefresh = process.env.NODE_ENV === "test" && spotifyWebDependencies.refreshToken === defaultSpotifyWebDependencies.refreshToken;
  if (shouldRefresh && !testDefaultRefresh) {
    try {
      const refreshed = await spotifyWebDependencies.refreshToken(config.clientId, tokenState);
      if (!refreshed || !hasSpotifyPlaylistModifyPrivateScope(refreshed.scope)) return { code: "SPOTIFY_AUTHENTICATION_REQUIRED", status: 401 };
      spotifyWebDependencies.writeTokenState(refreshed);
      tokenState = refreshed;
    } catch {
      return { code: "SPOTIFY_AUTHENTICATION_REQUIRED", status: 401 };
    }
  }
  return { api: spotifyWebDependencies.createApi(tokenState.accessToken), status: 200 };
}

function spotifyConnectionError(res: express.Response, connection: { code?: string; status: number }): express.Response {
  const code = connection.code ?? "SPOTIFY_AUTHENTICATION_REQUIRED";
  const authorizationRequired = code === "SPOTIFY_AUTHORIZATION_REQUIRED";
  return res.status(connection.status).json({ error: authorizationRequired ? "Authorization required" : code === "SPOTIFY_AUTHENTICATION_REQUIRED" ? "Authentication required" : "Spotify is unavailable", code });
}

type ConversionLogDestination = "spotify" | "youtube";
type ConversionCompletionSummary = {
  destination: ConversionLogDestination;
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  searchErrors: number;
  skipped?: number;
};

function logConversionStart(destination: ConversionLogDestination, total: number, dryRun: unknown): void {
  console.info("conversion.start", { destination, total, dryRun: dryRun === true });
}

function logConversionComplete({ searchErrors: _searchErrors, ...summary }: ConversionCompletionSummary): void {
  console.info("conversion.complete", summary);
}

function logConversionFailure(destination: ConversionLogDestination, code: string, phase?: string): void {
  console.error("conversion.failed", { destination, code, ...(phase ? { phase } : {}) });
}

type SpotifyErrorPhase = "preflight_profile" | "matching" | "playlist_create" | "playlist_insert";
type SpotifyManualReviewOutcome = SpotifyTrackMatch;
type ConversionPreflightCode = "AUTHENTICATION_REQUIRED" | "AUTHORIZATION_REQUIRED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE";
type ConversionPreflightResult =
  | { status: "ready" }
  | { status: "not_ready"; code: ConversionPreflightCode; phase?: SpotifyErrorPhase };

type PhasedSpotifyApiError = SpotifyApiError & { spotifyErrorPhase?: SpotifyErrorPhase };

function spotifyConversionError(error: unknown, fallbackPhase: SpotifyErrorPhase = "matching"): { code: "SPOTIFY_AUTHENTICATION_REQUIRED" | "SPOTIFY_AUTHORIZATION_REQUIRED" | "SPOTIFY_RATE_LIMITED" | "SPOTIFY_REQUEST_REJECTED" | "SPOTIFY_PROVIDER_UNAVAILABLE"; error: string; phase: SpotifyErrorPhase; status: number } {
  const phase = error instanceof SpotifyApiError ? (error as PhasedSpotifyApiError).spotifyErrorPhase ?? fallbackPhase : fallbackPhase;
  if (error instanceof SpotifyApiError && error.status === 401) {
    return { code: "SPOTIFY_AUTHENTICATION_REQUIRED", error: "Authentication required", phase, status: 401 };
  }
  if (error instanceof SpotifyApiError && error.status === 403) {
    return { code: "SPOTIFY_AUTHORIZATION_REQUIRED", error: "Authorization required", phase, status: 403 };
  }
  if (error instanceof SpotifyApiError && error.status === 429) {
    return { code: "SPOTIFY_RATE_LIMITED", error: "Spotify is rate limited", phase, status: 429 };
  }
  if (error instanceof SpotifyApiError && error.status >= 400 && error.status < 500) {
    return { code: "SPOTIFY_REQUEST_REJECTED", error: "Spotify rejected the request. Check the playlist details and selected tracks, then try again.", phase, status: error.status };
  }
  return { code: "SPOTIFY_PROVIDER_UNAVAILABLE", error: "Spotify is unavailable", phase, status: 503 };
}

function spotifyApiWithErrorPhases(api: SpotifyConversionApi): SpotifyConversionApi {
  const withPhase = <T>(phase: SpotifyErrorPhase, operation: () => Promise<T>): Promise<T> => operation().catch((error: unknown) => {
    if (error instanceof SpotifyApiError) Object.defineProperty(error, "spotifyErrorPhase", { value: phase });
    throw error;
  });
  function searchTracks(query: string, shouldCancel?: () => boolean): ReturnType<SpotifyConversionApi["searchTracks"]>;
  function searchTracks(query: string, limit?: number, offset?: number, shouldCancel?: () => boolean): ReturnType<SpotifyConversionApi["searchTracks"]>;
  function searchTracks(query: string, limitOrShouldCancel?: number | (() => boolean), offset?: number, shouldCancel?: () => boolean): ReturnType<SpotifyConversionApi["searchTracks"]> {
    return typeof limitOrShouldCancel === "number"
      ? withPhase("matching", () => api.searchTracks(query, limitOrShouldCancel, offset, shouldCancel))
      : withPhase("matching", () => api.searchTracks(query, limitOrShouldCancel));
  }
  return {
    addTracks: (playlistId, uris, shouldCancel) => withPhase("playlist_insert", () => api.addTracks(playlistId, uris, shouldCancel)),
    createPrivatePlaylist: (userId, name, shouldCancel) => withPhase("playlist_create", () => api.createPrivatePlaylist(userId, name, shouldCancel)),
    getProfile: (shouldCancel) => withPhase("preflight_profile", () => api.getProfile(shouldCancel)),
    searchTracks,
  };
}

function conversionPreflightFailure(code: ConversionPreflightCode, phase?: SpotifyErrorPhase): ConversionPreflightResult {
  return { status: "not_ready", code, ...(phase ? { phase } : {}) };
}

async function spotifyConversionPreflight(): Promise<ConversionPreflightResult> {
  const connection = await spotifyConnection();
  if (!connection.api) {
    return conversionPreflightFailure(connection.status === 401 ? "AUTHENTICATION_REQUIRED" : connection.status === 403 ? "AUTHORIZATION_REQUIRED" : "PROVIDER_UNAVAILABLE");
  }
  try {
    await connection.api.getProfile();
    return { status: "ready" };
  } catch (error) {
    if (error instanceof SpotifyApiError && error.status === 401) {
      return conversionPreflightFailure("AUTHENTICATION_REQUIRED", "preflight_profile");
    }
    if (error instanceof SpotifyApiError && error.status === 403) {
      return conversionPreflightFailure("AUTHORIZATION_REQUIRED", "preflight_profile");
    }
    return conversionPreflightFailure(error instanceof SpotifyApiError && error.status === 429
      ? "RATE_LIMITED"
      : "PROVIDER_UNAVAILABLE");
  }
}

async function youTubeMusicConversionPreflight(): Promise<ConversionPreflightResult> {
  try {
    const validation = await spotifyWebDependencies.validateYtMusicAuth();
    if (validation.status === "valid") return { status: "ready" };
    return conversionPreflightFailure(validation.status === "unexpected_failure" ? "PROVIDER_UNAVAILABLE" : "AUTHENTICATION_REQUIRED");
  } catch {
    return conversionPreflightFailure("PROVIDER_UNAVAILABLE");
  }
}

const spotifyAuth = createSpotifyOAuthManager({
  deleteTokenState: deleteSpotifyTokenState,
  exchangeAuthorizationCode: async (request) => {
    const result = await exchangeSpotifyAuthorizationCode({ ...request, fetch: globalThis.fetch });
    return result.diagnostic?.provider === "missing_scope" ? { authorizationRequired: true } : result.tokenState;
  },
  getClientConfig: () => getSpotifyClientConfig({ port: PORT }),
  readTokenState: readSpotifyTokenState,
  writeTokenState: writeSpotifyTokenState,
});

const MANUAL_SEARCH_QUEUE_LIMIT = 20;
const SPOTIFY_MANUAL_SEARCH_LIMIT = 5;
const SPOTIFY_MANUAL_SEARCH_OFFSETS = new Set([0, 5, 10]);

type ManualSearchJob = {
  key: string;
  query: string;
  artist: string;
  title: string;
  threshold: number;
  offset: number;
  callers: Set<symbol>;
  promise: Promise<YTMusicManualSearchResult>;
  resolve: (result: YTMusicManualSearchResult) => void;
  reject: (error: unknown) => void;
  queued: boolean;
};

const manualSearchQueue: ManualSearchJob[] = [];
const manualSearchJobs = new Map<string, ManualSearchJob>();
let manualSearchRunning = false;

function normalizeManualSearchPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function manualSearchKey(query: string, artist: string, title: string, threshold: number, offset: number): string {
  return [...[query, artist, title].map(normalizeManualSearchPart), threshold.toFixed(2), String(offset)].join("\u0000");
}

function isTransientEmptyJsonParseError(error: unknown): boolean {
  return error instanceof Error && /Expecting value/i.test(error.message);
}

function waitForManualSearchRetry(retry: number): Promise<void> {
  const exponentialDelay = 1_000 * 2 ** retry;
  const jitter = Math.floor(Math.random() * 501);
  return new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
}

async function searchManualTrackWithRetry(query: string, artist: string, title: string, threshold: number, offset: number): Promise<YTMusicManualSearchResult> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await searchSingleOnYtMusic(query, artist, title, threshold, offset);
    } catch (error) {
      if (!isTransientEmptyJsonParseError(error) || retry >= 2) throw error;
      await waitForManualSearchRetry(retry);
    }
  }
}

function drainManualSearchQueue(): void {
  if (manualSearchRunning) return;
  const job = manualSearchQueue.shift();
  if (!job) return;
  job.queued = false;

  if (job.callers.size === 0) {
    manualSearchJobs.delete(job.key);
    drainManualSearchQueue();
    return;
  }

  manualSearchRunning = true;
  void searchManualTrackWithRetry(job.query, job.artist, job.title, job.threshold, job.offset)
    .then(job.resolve, job.reject)
    .finally(() => {
      manualSearchRunning = false;
      if (manualSearchJobs.get(job.key) === job) manualSearchJobs.delete(job.key);
      drainManualSearchQueue();
    });
}

function enqueueManualSearch(query: string, artist: string, title: string, threshold: number, offset: number): {
  promise: Promise<YTMusicManualSearchResult>;
  abandon: () => void;
} | null {
  const key = manualSearchKey(query, artist, title, threshold, offset);
  const caller = Symbol("manual-search-caller");
  let job = manualSearchJobs.get(key);

  let queued = false;
  if (!job) {
    if (manualSearchQueue.length >= MANUAL_SEARCH_QUEUE_LIMIT) return null;
    let resolve!: (result: YTMusicManualSearchResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<YTMusicManualSearchResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    job = { key, query, artist, title, threshold, offset, callers: new Set(), promise, resolve, reject, queued: true };
    manualSearchJobs.set(key, job);
    manualSearchQueue.push(job);
    queued = true;
  }

  job.callers.add(caller);
  if (queued) drainManualSearchQueue();
  return {
    promise: job.promise,
    abandon: () => {
      job!.callers.delete(caller);
      if (job!.queued && job!.callers.size === 0) {
        const queueIndex = manualSearchQueue.indexOf(job!);
        if (queueIndex !== -1) manualSearchQueue.splice(queueIndex, 1);
        if (manualSearchJobs.get(key) === job) manualSearchJobs.delete(key);
      }
    },
  };
}

// Middleware
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Ruta absoluta a la carpeta 'public'
const publicDir = path.resolve(__dirname, '../../public');

// Verificar que la carpeta 'public' exista
if (!fs.existsSync(publicDir)) {
  console.error(`❌ Error: La carpeta 'public' no existe en: ${publicDir}`);
  process.exit(1);
}
app.use(express.static(publicDir));

// Local-only browser control: never grant wildcard or LAN CORS access.
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && hasSameLocalOrigin(req)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Local-UI-Client, X-Local-UI-Capability");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(origin && hasSameLocalOrigin(req) ? 204 : 403);
    return;
  }
  next();
});

app.get("/api/ui-capability", (req, res) => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
  const origin = localAppOrigin(req);
  if (!OPAQUE_ID_PATTERN.test(clientId) || !origin || (req.get("origin") && !hasSameLocalOrigin(req))) {
    return res.status(403).json({ error: "Local UI authorization required" });
  }
  const capability = createOpaqueId();
  localUiCapabilities.set(clientId, { capability, origin });
  return res.json({ capability });
});

app.use("/api", (req, res, next) => {
  if (req.method !== "POST") return next();
  requireLocalUiMutation(req, res, next);
});

app.post("/api/ytmusic-auth/browser/start", async (_req, res) => {
  const result = await guidedBrowserAuth.start();
  res.status(result.status === "error" ? 400 : 200).json(result);
});

app.get("/api/ytmusic-auth/browser/status", (_req, res) => {
  res.json(guidedBrowserAuth.status());
});

app.post("/api/ytmusic-auth/browser/cancel", async (_req, res) => {
  res.json(await guidedBrowserAuth.cancel());
});

app.post("/api/ytmusic-auth/browser/disconnect", async (_req, res) => {
  await guidedBrowserAuth.disconnect();
  SessionService.logout(res);
  res.json({ status: "idle" });
});

app.post("/api/spotify-auth/start", (req, res) => {
  const result = spotifyAuth.start(req.get("origin"));
  res.status(result.status === "error" ? 400 : 200).json(result);
});

app.get("/api/spotify-auth/callback", async (req, res) => {
  const result = await spotifyAuth.handleCallback({
    code: req.query.code,
    error: req.query.error,
    state: req.query.state,
  });
  res.status(result.status === "connected" ? 200 : 400).type("html").send(renderSpotifyCallbackReturnPage(result));
});

app.get("/api/spotify-auth/status", (_req, res) => {
  const { configured, supported, connected, reason, profile } = spotifyAuth.status();
  res.json({ configured, supported, connected, reason, profile });
});

app.post("/api/spotify-auth/cancel", (_req, res) => {
  res.json(spotifyAuth.cancel());
});

app.post("/api/spotify-auth/disconnect", (_req, res) => {
  spotifyAuth.disconnect();
  res.json({ status: "idle", connected: false });
});

app.get("/api/auth-status", async (req, res) => {
  const authenticated = await checkYtMusicAvailable();
  if (authenticated && req.cookies?.ytmusic_session !== "authenticated") {
    SessionService.setAuthenticated(res);
  } else if (!authenticated && req.cookies?.ytmusic_session === "authenticated") {
    res.clearCookie("ytmusic_session");
  }
  res.json({ authenticated });
});

app.post("/api/convert/cancel", (req, res) => {
  const boundRun = conversionRunForRequest(req);
  if (!boundRun) return res.status(403).json({ error: "Conversion run authorization required" });
  boundRun.run.cancelled = true;
  return res.json({ cancelled: true });
});

app.post("/api/conversion-preflight", async (req, res) => {
  const requestedDestination = typeof req.body?.destination === "string" ? req.body.destination.trim().toLocaleLowerCase() : "";
  const destination = requestedDestination === "ytmusic" ? "youtube" : requestedDestination;
  if (destination !== "youtube" && destination !== "spotify") {
    return res.status(400).json(conversionPreflightFailure("PROVIDER_UNAVAILABLE"));
  }
  return res.json(destination === "spotify" ? await spotifyConversionPreflight() : await youTubeMusicConversionPreflight());
});

app.get("/api/destinations", async (_req, res) => {
  const config = spotifyWebDependencies.getClientConfig();
  const connected = Boolean(spotifyWebDependencies.getTokenState());
  const youtubeAvailable = await spotifyWebDependencies.isYtMusicAvailable().catch(() => false);
  res.json({
    destinations: {
      spotify: {
        available: config.enabled && connected,
        configured: config.enabled,
        connected,
        reason: config.reason ?? (connected ? null : "SPOTIFY_AUTHENTICATION_REQUIRED"),
        supported: config.supported,
      },
      youtube: { available: youtubeAvailable },
    },
  });
});

app.post("/api/spotify/search-single", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const limit = req.body?.limit;
  const offset = req.body?.offset;
  if (!query) return res.status(400).json({ error: "A search query is required" });
  if (limit !== SPOTIFY_MANUAL_SEARCH_LIMIT || !Number.isInteger(offset) || !SPOTIFY_MANUAL_SEARCH_OFFSETS.has(offset)) {
    return res.status(400).json({ error: "Spotify manual search limit must be 5 and offset must be 0, 5, or 10" });
  }
  const connection = await spotifyConnection();
  if (!connection.api) return spotifyConnectionError(res, connection);
  try {
    const results = await (connection.api.searchTracks as (query: string, pageLimit: number, pageOffset: number) => ReturnType<SpotifyConversionApi["searchTracks"]>)(query, limit, offset);
    return res.json({ results, hasMore: offset < 10 && results.length === limit });
  } catch (error) {
    const failure = spotifyConversionError(error, "matching");
    if (failure.code === "SPOTIFY_AUTHENTICATION_REQUIRED" || failure.code === "SPOTIFY_AUTHORIZATION_REQUIRED") {
      return res.status(failure.status).json({ error: failure.error, code: failure.code, phase: failure.phase });
    }
    return res.status(502).json({ error: "Spotify search failed", code: "SPOTIFY_SEARCH_FAILED" });
  }
});

app.post("/api/spotify/add-to-playlist", async (req, res) => {
  const playlistId = typeof req.body?.playlistId === "string" ? req.body.playlistId.trim() : "";
  const tracks = req.body?.tracks;
  const uris = Array.isArray(tracks) ? [...new Set(tracks.map((track) => typeof track?.uri === "string" ? track.uri.trim() : "").filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))] : [];
  if (!playlistId || !Array.isArray(tracks) || uris.length === 0) {
    return res.status(400).json({ error: "A playlist and selected tracks are required" });
  }
  const connection = await spotifyConnection();
  if (!connection.api) return spotifyConnectionError(res, connection);
  try {
    const result = await connection.api.addTracks(playlistId, uris);
    if (result.cancelled || result.insertedUris.length !== uris.length) {
      return res.status(502).json({ error: "Could not confirm all selected tracks were added" });
    }
    return res.json({ success: true, count: result.insertedUris.length });
  } catch (error) {
    const failure = spotifyConversionError(error, "playlist_insert");
    if (failure.code !== "SPOTIFY_PROVIDER_UNAVAILABLE") {
      return res.status(failure.status).json({ error: failure.error, code: failure.code, phase: failure.phase });
    }
    return res.status(502).json({ error: "Could not add selected tracks", code: "SPOTIFY_PLAYLIST_FAILED" });
  }
});

app.post("/api/add-to-playlist", async (req, res) => {
  const playlistId = typeof req.body?.playlistId === "string" ? req.body.playlistId.trim() : "";
  const tracks = req.body?.tracks;

  if (!playlistId || !Array.isArray(tracks)) {
    return res.status(400).json({ error: "A playlist and selected tracks are required" });
  }

  const videoIds = [...new Set(
    tracks
      .map((track) => typeof track?.videoId === "string" ? track.videoId.trim() : "")
      .filter(Boolean)
  )];

  if (videoIds.length === 0) {
    return res.status(400).json({ error: "At least one selected track is required" });
  }

  try {
    const result = await addToPlaylistOnYtMusic(playlistId, videoIds);
    const addedCount = result?.added;
    if (result?.success !== true || !Number.isInteger(addedCount) || addedCount !== videoIds.length) {
      return res.status(502).json({ error: "Could not confirm all selected tracks were added" });
    }
    return res.json({ success: true, count: addedCount });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "AUTHENTICATION_REQUIRED") {
      return res.status(401).json({ error: "Authentication required", code: "AUTHENTICATION_REQUIRED" });
    }
    return res.status(502).json({ error: "Could not add selected tracks" });
  }
});

app.post("/api/search-single", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const artist = typeof req.body?.artist === "string" ? req.body.artist.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const threshold = req.body?.threshold;
      const offset = req.body?.offset;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 0.60) {
      return res.status(400).json({ error: "Manual search threshold must be a finite number from 0 to 0.60" });
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10 || offset % 5 !== 0) {
        return res.status(400).json({ error: "Manual search offset must be 0, 5, or 10" });
      }
      if (!query) {
    return res.status(400).json({ error: "A search query is required" });
  }

  const queuedSearch = enqueueManualSearch(query, artist, title, threshold, offset);
  if (!queuedSearch) {
    return res.status(429).json({ error: "Manual search queue is full. Please try again shortly." });
  }

  let abandoned = false;
  let responseComplete = false;
  const abandon = () => {
    if (abandoned || responseComplete) return;
    abandoned = true;
    queuedSearch.abandon();
  };
  req.once("aborted", abandon);
  res.once("close", abandon);

  try {
    const result = await queuedSearch.promise;
    if (abandoned) return;
    responseComplete = true;
    if (result.error) {
      return res.status(502).json({ error: "YouTube Music search failed" });
    }
    const pageCount = result.pageCount;
    const resultCount = result.resultCount;
    return res.json({
      results: result.results || [],
      hasMore: result.hasMore === true,
      pageCount: typeof pageCount === "number" && Number.isInteger(pageCount) && pageCount >= 0 ? pageCount : 0,
      resultCount: typeof resultCount === "number" && Number.isInteger(resultCount) && resultCount >= 0 ? resultCount : 0,
    });
  } catch (err) {
    if (abandoned) return;
    responseComplete = true;
    if ((err as { code?: unknown })?.code === "AUTHENTICATION_REQUIRED") {
      return res.status(401).json({ error: "Authentication required", code: "AUTHENTICATION_REQUIRED" });
    }
    return res.status(502).json({ error: "YouTube Music search failed" });
      } finally {
        req.removeListener("aborted", abandon);
        res.removeListener("close", abandon);
      }
});

// Endpoint para parsear contenido M3U
app.post("/api/parse-m3u", async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    
    // Crear un archivo temporal para parsear
    const tempFilePath = path.join(os.tmpdir(), `temp_playlist_${Date.now()}.m3u`);
    fs.writeFileSync(tempFilePath, content);
    
    // Parsear el archivo
    const result = parseFile(tempFilePath);
    
    // Eliminar el archivo temporal
    fs.unlinkSync(tempFilePath);
    
    return res.json({
      tracks: result.tracks,
      playlistName: result.playlistName || path.basename(tempFilePath, path.extname(tempFilePath))
    });
  } catch (err) {
    console.error("Error al parsear M3U:", err);
    return res.status(500).json({ error: "Failed to parse M3U content" });
  }
});

// Endpoint para convertir la playlist
app.post("/api/convert", async (req, res) => {
  const boundRun = conversionRunForRequest(req);
  if (!boundRun || boundRun.run.claimed) return res.status(403).json({ error: "Conversion run authorization required" });
  const { runId, run } = boundRun;
  run.claimed = true;
  // Keep the admitted run's cancellation state after SSE cleanup removes it from delivery.
  const shouldCancel = () => run.cancelled;
  // A run is one-shot. Its buffered SSE terminal event is sent before this response finishes.
  res.once("finish", () => {
    if (conversionRuns.get(runId) === run) conversionRuns.delete(runId);
  });
  try {
      const { tracks, playlistName, dryRun } = req.body;
      const suppliedThreshold = req.body?.threshold;
      const threshold = suppliedThreshold === undefined ? 0.6 : suppliedThreshold;
    const requestedDestination = typeof req.body?.destination === "string" ? req.body.destination.trim().toLocaleLowerCase() : "youtube";
    const destination = requestedDestination === "ytmusic" ? "youtube" : requestedDestination;
    if (!tracks || !playlistName) {
      return res.status(400).json({ error: "Tracks and playlistName are required" });
    }
    if (destination !== "youtube" && destination !== "spotify") {
      return res.status(400).json({ error: "Destination must be youtube or spotify" });
    }
    if (destination === "youtube" && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
          return res.status(400).json({ error: "Conversion threshold must be a finite number from 0 to 1" });
        }
        if (shouldCancel()) return res.json({ success: true, cancelled: true, sideEffects: { inserted: 0, playlist: "not-created" } });
        if (destination === "spotify") {
      if (!Array.isArray(tracks)) return res.status(400).json({ error: "Tracks and playlistName are required" });
      logConversionStart("spotify", tracks.length, dryRun);
      const connection = await spotifyConnection();
      if (!connection.api) {
        logConversionFailure("spotify", connection.code ?? "SPOTIFY_AUTHENTICATION_REQUIRED");
        return spotifyConnectionError(res, connection);
      }
      try {
        const progressCallback = (current: number, total: number, artist: string, title: string, status: string) => {
          sendToRun(runId, { type: "progress", added: current, total, artist, title, status });
        };
        const result = await spotifyWebDependencies.convert(spotifyApiWithErrorPhases(connection.api), tracks as SpotifySourceTrack[], { dryRun, playlistName, onProgress: progressCallback, shouldCancel });
        const matched = result.outcomes.filter((outcome) => outcome.status === "matched").length;
        const unmatched = result.outcomes.filter((outcome) => outcome.status === "unmatched").length;
        const ambiguous = result.outcomes.filter((outcome) => outcome.status === "ambiguous").length;
        const skipped = result.outcomes.filter((outcome) => outcome.status === "skipped").length;
        const searchErrorTracks = result.outcomes.filter((outcome) => outcome.status === "search_error").map((outcome) => ({
          artist: outcome.source.artist,
          reason: outcome.reason,
          status: outcome.status,
          title: outcome.source.title,
        }));
        const manualReviewTracks = result.outcomes
          .filter((outcome): outcome is SpotifyManualReviewOutcome => outcome.status === "unmatched" || outcome.status === "ambiguous")
          .map((outcome) => ({
            artist: outcome.source.artist,
            title: outcome.source.title,
            status: outcome.status,
            bestMatch: outcome.candidate,
            alternatives: outcome.alternatives,
          }));
        const remotePlaylist = result.remotePlaylist;
        const payload = {
          provider: "spotify",
          total: tracks.length,
          matched,
          unmatched,
          ambiguous,
          skipped,
          searchErrors: searchErrorTracks.length,
          searchErrorTracks,
          cancelled: result.cancelled,
          manualReviewTracks,
          remotePlaylist,
          sideEffects: {
            inserted: remotePlaylist.status === "indeterminate" || (remotePlaylist.status !== "not-created" && remotePlaylist.indeterminateUris?.length) ? "indeterminate" : remotePlaylist.status === "not-created" ? 0 : remotePlaylist.insertedUris.length,
            playlist: remotePlaylist.status,
          },
          ...(remotePlaylist.status === "created" || remotePlaylist.status === "partial" ? { playlistId: remotePlaylist.id, playlistUrl: remotePlaylist.url } : {}),
        };
        sendToRun(runId, { type: "result", ...payload });
        if (!result.cancelled) logConversionComplete({ destination: "spotify", total: tracks.length, matched, unmatched, ambiguous, skipped, searchErrors: searchErrorTracks.length });
        return res.json({ success: true, ...payload });
      } catch (error) {
        const failure = spotifyConversionError(error);
        logConversionFailure("spotify", failure.code, failure.phase);
        sendToRun(runId, { type: "error", code: failure.code });
        return res.status(failure.status).json({ error: failure.error, code: failure.code, ...(failure.phase ? { phase: failure.phase } : {}) });
      }
    }
    
    logConversionStart("youtube", Array.isArray(tracks) ? tracks.length : 0, dryRun);

    // Importar la función de conversión
    const { convertWithYtMusic } = await import("../../src/ytmusic/client");
    
    // Configurar callback de progreso
    const progressCallback = (current: number, total: number, artist: string, title: string, status: string) => {
      // Enviar progreso al cliente (usando SSE)
      sendToRun(runId, {
        type: "progress",
        added: current,
        total,
        artist,
        title,
        status
      });
    };
    
    // Convertir la playlist
    const result = await convertWithYtMusic(tracks, playlistName, { dryRun, threshold }, progressCallback, shouldCancel);
    if (shouldCancel()) {
      const payload = { cancelled: true, sideEffects: { inserted: "indeterminate", playlist: "indeterminate" } };
      sendToRun(runId, { type: "result", ...payload });
      return res.json({ success: true, ...payload });
    }

    const unmatchedTracks = result.unmatchedTracks || [];
    const ambiguousTracks = result.ambiguousTracks || [];
    const searchErrorTracks = result.searchErrorTracks || (result.results || []).filter((track) => track.status === "search_error");
    const baseManualReviewTracks = result.manualReviewTracks || [...unmatchedTracks, ...ambiguousTracks];
    const manualReviewKeys = new Set(baseManualReviewTracks.map((track) => `${track.artist}\u0000${track.title}\u0000${track.status}`));
    const manualReviewTracks = [
      ...baseManualReviewTracks,
      ...searchErrorTracks.filter((track) => !manualReviewKeys.has(`${track.artist}\u0000${track.title}\u0000${track.status}`)),
    ];
    const playlistCreationFailure = result.playlistCreationFailure;
    const payload = {
      type: "result",
      total: tracks.length,
      matched: result.matched,
      unmatched: unmatchedTracks.length,
      ambiguous: ambiguousTracks.length,
      searchErrors: searchErrorTracks.length,
      searchErrorTracks,
      playlistId: playlistCreationFailure ? null : result.playlistId,
      playlistUrl: playlistCreationFailure ? null : result.playlistUrl,
      unmatchedTracks,
      ambiguousTracks,
      manualReviewTracks,
      ...(playlistCreationFailure ? { playlistCreationFailure, sideEffects: { inserted: 0, playlist: "failed" } } : {}),
    };

    // Enviar resultado al cliente
    sendToRun(runId, payload);
    if (playlistCreationFailure) {
      logConversionFailure("youtube", playlistCreationFailure.code, "playlist_create");
      return res.json({ success: false, error: playlistCreationFailure.message, code: playlistCreationFailure.code, ...payload });
    }
    logConversionComplete({ destination: "youtube", total: tracks.length, matched: result.matched, unmatched: unmatchedTracks.length, ambiguous: ambiguousTracks.length, searchErrors: searchErrorTracks.length });
    
    return res.json({ success: true });
  } catch (err) {
    if (shouldCancel() || err instanceof DOMException && err.name === "AbortError") {
      const payload = { cancelled: true, sideEffects: { inserted: "indeterminate", playlist: "indeterminate" } };
      sendToRun(runId, { type: "result", ...payload });
      return res.json({ success: true, ...payload });
    }
    if ((err as { code?: unknown })?.code === "AUTHENTICATION_REQUIRED") {
      logConversionFailure("youtube", "AUTHENTICATION_REQUIRED");
      return res.status(401).json({ error: "Authentication required", code: "AUTHENTICATION_REQUIRED" });
    }
    logConversionFailure("youtube", "CONVERSION_FAILED");
    sendToRun(runId, { type: "error", code: "CONVERSION_FAILED" });
    return res.status(500).json({ error: "Failed to convert playlist" });
  }
});

// An EventSource can only subscribe to the opaque run owned by its local UI capability.
app.get("/api/convert-progress", (req, res) => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
  const runId = typeof req.query.runId === "string" ? req.query.runId : "";
  const capability = typeof req.query.capability === "string" ? req.query.capability : "";
  const origin = localAppOrigin(req);
  const registered = localUiCapabilities.get(clientId);
  if (!OPAQUE_ID_PATTERN.test(clientId) || !OPAQUE_ID_PATTERN.test(runId) || !origin || (req.get("origin") && !hasSameLocalOrigin(req))
    || !registered || registered.origin !== origin || !hasCapability(capability, registered.capability)) {
    res.status(403).json({ error: "Local UI authorization required" });
    return;
  }
  let run = conversionRuns.get(runId);
  if (run && (run.clientId !== clientId || !hasCapability(capability, run.capability))) {
    res.status(403).json({ error: "Conversion run authorization required" });
    return;
  }
  if (!run) {
    run = { capability, clientId, claimed: false, cancelled: false, clients: new Set() };
    conversionRuns.set(runId, run);
  }
  const onClose = () => {
    // A disconnected local UI cannot safely confirm downstream side effects.
    // Cancel, detach, and remove this run before any later delivery can occur.
    cancelDisconnectedRun(runId, run!);
  };
  const client: SseClient = { req, res, onClose };
  run.clients.add(client);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  req.once("close", onClose);
  res.once("close", onClose);
});

// Endpoint para limpiar localStorage
app.get("/clear-localstorage", (_req, res) => {
  res.send(
    `<script>
      localStorage.removeItem('m3uState');
      alert('localStorage limpiado. Refresca la página.');
      window.close();
    </script>`
  );
});

// Servir index.html en la ruta raíz
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Redirigir todas las demás solicitudes a index.html para manejar rutas del frontend
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

if (process.env.NODE_ENV !== "test") {
  console.log(`Iniciando servidor en el puerto ${PORT}...`);
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  }).on('error', (err) => {
    console.error('Error al iniciar el servidor:', err);
  });
}