import type { SpotifyAddTracksResult, SpotifyCancellationCheck, SpotifyFetch, SpotifyPlaylist, SpotifyProfile, SpotifyTrackCandidate } from "./types";

const SPOTIFY_API_URL = "https://api.spotify.com/v1";
// Spotify may provide an unbounded retry hint; wait no longer than one minute per retry.
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;

export class SpotifyApiError extends Error {
  constructor(public readonly status: number) {
    super(`Spotify API request failed with status ${status}`);
  }
}

export class SpotifyAddTracksError extends Error {
  constructor(
    /** Confirmed prior batches only. */
    public readonly insertedUris: string[],
    /** The failed POST may have succeeded remotely. */
    public readonly indeterminateUris: string[],
  ) {
    super("Spotify playlist track insertion outcome is indeterminate");
  }
}

/** A cancellation interrupted a dispatched create POST, so Spotify may have created a playlist. */
export class SpotifyPlaylistCreationIndeterminateError extends Error {
  constructor() {
    super("Spotify playlist creation outcome is indeterminate");
  }
}

export type SpotifyApiOptions = {
  accessToken: string;
  fetch: SpotifyFetch;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

function retryAfterMilliseconds(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MILLISECONDS)
    : 1_000;
}

function spotifyOperation(path: string, method = "GET"): string {
  if (path.startsWith("/search?")) return "track-search";
  if (path === "/me") return "profile";
  if (path === "/me/playlists" && method === "POST") return "playlist-create";
  if (path.startsWith("/playlists/") && path.endsWith("/items") && method === "POST") return "playlist-insert";
  return "request";
}

function candidate(item: {
  album?: { name?: string };
  artists?: { name?: string }[];
  duration_ms?: number;
  id?: string;
  name?: string;
  uri?: string;
}): SpotifyTrackCandidate | null {
  if (!item.id || !item.name || !item.uri) return null;
  return {
    ...(item.album?.name ? { albumName: item.album.name } : {}),
    artists: (item.artists ?? []).flatMap((artist) => artist.name ? [{ name: artist.name }] : []),
    durationMs: item.duration_ms,
    id: item.id,
    title: item.name,
    uri: item.uri,
  };
}

type SearchAdmission = "normal" | "probe";

class SpotifySearchCircuitBreaker {
  private admissionLevel = 1;
  private cooldownDeadline = 0;
  private cooldownPromise: Promise<number> | undefined;
  private inRecovery = 0;
  private probeActive = false;
  private probeFailures = 0;
  private recoverySuccesses = 0;
  private state: "closed" | "open" | "recovering" = "closed";

  constructor(
    private readonly maxRecoveryAdmission: number,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  async acquire(shouldCancel: SpotifyCancellationCheck | undefined, maxProbeFailures: number): Promise<SearchAdmission> {
    let observedProbeFailures = this.probeFailures;
    let sleptOpenDeadline = 0;
    for (;;) {
      if (shouldCancel?.()) throw new DOMException("Spotify operation cancelled", "AbortError");
      if (this.state === "closed") return "normal";
      if (this.state === "recovering" && this.inRecovery < this.admissionLevel) {
        this.inRecovery += 1;
        return "normal";
      }
      if (this.state === "open" && (this.now() >= this.cooldownDeadline || this.cooldownDeadline <= sleptOpenDeadline) && !this.probeActive) {
        this.probeActive = true;
        console.info("[spotify] search circuit probe", { admissionLevel: 1 });
        return "probe";
      }
      if (this.probeFailures > observedProbeFailures) {
        observedProbeFailures = this.probeFailures;
        if (observedProbeFailures > maxProbeFailures) throw new SpotifyApiError(429);
      }
      if (this.state === "open") {
        sleptOpenDeadline = Math.max(sleptOpenDeadline, await this.waitForCooldown());
      } else {
        await this.sleep(25);
      }
    }
  }

  private waitForCooldown(): Promise<number> {
    if (!this.cooldownPromise) {
      this.cooldownPromise = (async () => {
        let observedDeadline = this.cooldownDeadline;
        for (;;) {
          await this.sleep(Math.max(0, observedDeadline - this.now()));
          if (this.cooldownDeadline <= observedDeadline) return observedDeadline;
          observedDeadline = this.cooldownDeadline;
        }
      })().finally(() => { this.cooldownPromise = undefined; });
    }
    return this.cooldownPromise;
  }

  release(admission: SearchAdmission, status: number): void {
    if (admission === "probe") {
      this.probeActive = false;
      if (status === 429) return;
      if (status < 200 || status >= 300) {
        this.state = "closed";
        return;
      }
      this.state = "recovering";
      this.admissionLevel = 1;
      this.recoverySuccesses = 0;
      this.inRecovery = 0;
      console.info("[spotify] search circuit probe success", { admissionLevel: this.admissionLevel });
      return;
    }
    if (this.state === "recovering" && this.inRecovery > 0) this.inRecovery -= 1;
    if (this.state === "recovering" && status !== 429 && status >= 200 && status < 300) {
      this.recoverySuccesses += 1;
      if (this.admissionLevel < this.maxRecoveryAdmission && this.recoverySuccesses >= this.admissionLevel) {
        this.recoverySuccesses = 0;
        this.admissionLevel = Math.min(this.maxRecoveryAdmission, this.admissionLevel + 1);
        console.info("[spotify] search circuit admission", { admissionLevel: this.admissionLevel });
      }
      if (this.admissionLevel >= this.maxRecoveryAdmission) this.state = "closed";
    }
  }

  open(milliseconds: number, fromProbe: boolean): void {
    this.cooldownDeadline = Math.max(this.cooldownDeadline, this.now() + milliseconds);
    this.state = "open";
    this.inRecovery = 0;
    this.recoverySuccesses = 0;
    if (fromProbe) {
      this.probeActive = false;
      this.probeFailures += 1;
      console.warn("[spotify] search circuit probe failure", { waitMs: Math.max(0, this.cooldownDeadline - this.now()) });
    } else {
      console.warn("[spotify] search circuit opened", { waitMs: Math.max(0, this.cooldownDeadline - this.now()) });
    }
  }
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const spotifySearchCircuitBreakers = new WeakMap<(milliseconds: number) => Promise<void>, SpotifySearchCircuitBreaker>();

export class SpotifyApi {
  private readonly maxRetries: number;
  private readonly searchCircuitBreaker: SpotifySearchCircuitBreaker;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: SpotifyApiOptions) {
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? defaultSleep;
    const existingBreaker = spotifySearchCircuitBreakers.get(this.sleep);
    this.searchCircuitBreaker = existingBreaker ?? new SpotifySearchCircuitBreaker(5, this.sleep, () => this.now());
    if (!existingBreaker) spotifySearchCircuitBreakers.set(this.sleep, this.searchCircuitBreaker);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async request(path: string, init: RequestInit = {}, shouldCancel?: SpotifyCancellationCheck, onRequestDispatched?: () => void): Promise<Response> {
    const operation = spotifyOperation(path, init.method);
    const usesSearchCircuit = operation === "track-search";
    for (let attempt = 0; ; attempt += 1) {
      let admission: SearchAdmission = "normal";
      if (shouldCancel?.()) {
        console.warn("[spotify] request cancelled", { attempt: attempt + 1, operation, stage: "before-wait" });
        throw new DOMException("Spotify operation cancelled", "AbortError");
      }
      if (usesSearchCircuit) admission = await this.searchCircuitBreaker.acquire(shouldCancel, this.maxRetries);
      if (shouldCancel?.()) {
        console.warn("[spotify] request cancelled", { attempt: attempt + 1, operation, stage: "after-wait" });
        throw new DOMException("Spotify operation cancelled", "AbortError");
      }
      const controller = new AbortController();
      const cancellationWatch = shouldCancel ? setInterval(() => {
        if (shouldCancel()) {
          console.warn("[spotify] request cancelled", { attempt: attempt + 1, operation, stage: "in-flight" });
          controller.abort();
        }
      }, 20) : undefined;
      let response: Response;
      const startedAt = this.now();
      try {
        onRequestDispatched?.();
        console.info("[spotify] request attempt", { attempt: attempt + 1, operation });
        response = await this.options.fetch(`${SPOTIFY_API_URL}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${this.options.accessToken}`, ...init.headers },
          signal: controller.signal,
        });
      } catch (error) {
        if (usesSearchCircuit) this.searchCircuitBreaker.release(admission, 0);
        throw error;
      } finally {
        if (cancellationWatch) clearInterval(cancellationWatch);
      }
      const elapsedMs = Math.max(0, this.now() - startedAt);
      console.info("[spotify] request response", { attempt: attempt + 1, elapsedMs, operation, status: response.status });
      if (usesSearchCircuit) this.searchCircuitBreaker.release(admission, response.status);
      if (response.status !== 429) {
        if (!response.ok) throw new SpotifyApiError(response.status);
        return response;
      }
      const waitMs = retryAfterMilliseconds(response);
      console.warn("[spotify] rate limited", { attempt: attempt + 1, operation, status: 429, waitMs });
      if (usesSearchCircuit) {
        this.searchCircuitBreaker.open(waitMs, admission === "probe");
      } else if (attempt < this.maxRetries) {
        await this.sleep(waitMs);
      }
      if (attempt >= this.maxRetries) throw new SpotifyApiError(response.status);
      console.info("[spotify] retry", { attempt: attempt + 2, operation });
    }
  }

  async getProfile(): Promise<SpotifyProfile> {
    const body = await (await this.request("/me")).json() as { display_name?: string; id?: string };
    if (!body.id) throw new SpotifyApiError(502);
    return { id: body.id, ...(body.display_name ? { displayName: body.display_name } : {}) };
  }

  async createPrivatePlaylist(_userId: string, name: string, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyPlaylist> {
    let postDispatched = false;
    try {
      const body = await (await this.request("/me/playlists", {
        body: JSON.stringify({ name, public: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, shouldCancel, () => { postDispatched = true; })).json() as { external_urls?: { spotify?: string }; id?: string; name?: string };
      if (!body.id) throw new SpotifyApiError(502);
      return { id: body.id, isPrivate: true, name: body.name ?? name, ...(body.external_urls?.spotify ? { url: body.external_urls.spotify } : {}) };
    } catch (error) {
      if (postDispatched && (shouldCancel?.() || error instanceof DOMException && error.name === "AbortError")) {
        throw new SpotifyPlaylistCreationIndeterminateError();
      }
      throw error;
    }
  }

  async searchTracks(query: string, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyTrackCandidate[]>;
  async searchTracks(query: string, limit?: number, offset?: number, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyTrackCandidate[]>;
  async searchTracks(
    query: string,
    limitOrShouldCancel: number | SpotifyCancellationCheck = 5,
    offset = 0,
    shouldCancel?: SpotifyCancellationCheck,
  ): Promise<SpotifyTrackCandidate[]> {
    const limit = typeof limitOrShouldCancel === "function" ? 5 : limitOrShouldCancel;
    const cancellationCheck = typeof limitOrShouldCancel === "function" ? limitOrShouldCancel : shouldCancel;
    const body = await (await this.request(`/search?${new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      q: query,
      type: "track",
    })}`, {}, cancellationCheck)).json() as {
      tracks?: { items?: Parameters<typeof candidate>[0][] };
    };
    return (body.tracks?.items ?? []).flatMap((item) => {
      const parsed = candidate(item);
      return parsed ? [parsed] : [];
    });
  }

  async addTracks(playlistId: string, uris: string[], shouldCancel?: () => boolean): Promise<SpotifyAddTracksResult> {
    let snapshotId: string | undefined;
    const insertedUris: string[] = [];
    for (let offset = 0; offset < uris.length; offset += 100) {
      if (shouldCancel?.()) return { cancelled: true, insertedUris, snapshotId };
      const batch = uris.slice(offset, offset + 100);
      let postDispatched = false;
      try {
        const body = await (await this.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
          body: JSON.stringify({ uris: batch }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }, shouldCancel, () => { postDispatched = true; })).json() as { snapshot_id?: string };
        snapshotId = body.snapshot_id;
        insertedUris.push(...batch);
      } catch (error) {
        if (shouldCancel?.() || error instanceof DOMException && error.name === "AbortError") {
          // A dispatched POST can have succeeded even though cancellation prevented
          // confirmation. Keep only confirmed prior batches separate from this batch.
          return { cancelled: true, insertedUris, ...(postDispatched ? { indeterminateUris: batch } : {}), snapshotId };
        }
        // Never represent the failed batch as absent: a transport/provider failure
        // after POST can still have added it remotely.
        throw new SpotifyAddTracksError(insertedUris, batch);
      }
    }
    return { cancelled: false, insertedUris, snapshotId };
  }
}
