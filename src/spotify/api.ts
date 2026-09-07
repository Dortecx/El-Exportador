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

function candidate(item: {
  artists?: { name?: string }[];
  duration_ms?: number;
  id?: string;
  name?: string;
  uri?: string;
}): SpotifyTrackCandidate | null {
  if (!item.id || !item.name || !item.uri) return null;
  return {
    artists: (item.artists ?? []).flatMap((artist) => artist.name ? [{ name: artist.name }] : []),
    durationMs: item.duration_ms,
    id: item.id,
    title: item.name,
    uri: item.uri,
  };
}

export class SpotifyApi {
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private cooldownDeadline = 0;
  private cooldownPromise: Promise<void> | undefined;

  constructor(private readonly options: SpotifyApiOptions) {
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async waitForCooldown(): Promise<void> {
    await this.cooldownPromise;
  }

  private extendCooldown(milliseconds: number): Promise<void> {
    // Concurrent 429s share one monotonic deadline; a shorter later hint cannot
    // shorten a cooldown already requested by Spotify.
    this.cooldownDeadline = Math.max(this.cooldownDeadline, this.now() + milliseconds);
    if (!this.cooldownPromise) {
      this.cooldownPromise = (async () => {
        let observedDeadline = this.cooldownDeadline;
        do {
          await this.sleep(Math.max(0, observedDeadline - this.now()));
          // Sleep once per observed deadline. Only a concurrent 429 that extends
          // the deadline warrants another sleep, even if an injected sleep settles
          // immediately without advancing the clock.
          if (this.cooldownDeadline <= observedDeadline) return;
          observedDeadline = this.cooldownDeadline;
        } while (true);
      })().finally(() => { this.cooldownPromise = undefined; });
    }
    return this.cooldownPromise;
  }

  private async request(path: string, init: RequestInit = {}, shouldCancel?: SpotifyCancellationCheck, onRequestDispatched?: () => void): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (shouldCancel?.()) throw new DOMException("Spotify operation cancelled", "AbortError");
      await this.waitForCooldown();
      if (shouldCancel?.()) throw new DOMException("Spotify operation cancelled", "AbortError");
      const controller = new AbortController();
      const cancellationWatch = shouldCancel ? setInterval(() => {
        if (shouldCancel()) controller.abort();
      }, 20) : undefined;
      let response: Response;
      try {
        onRequestDispatched?.();
        response = await this.options.fetch(`${SPOTIFY_API_URL}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${this.options.accessToken}`, ...init.headers },
          signal: controller.signal,
        });
      } finally {
        if (cancellationWatch) clearInterval(cancellationWatch);
      }
      if (response.status !== 429 || attempt >= this.maxRetries) {
        if (!response.ok) throw new SpotifyApiError(response.status);
        return response;
      }
      await this.extendCooldown(retryAfterMilliseconds(response));
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
      try {
        const body = await (await this.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
          body: JSON.stringify({ uris: batch }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }, shouldCancel)).json() as { snapshot_id?: string };
        snapshotId = body.snapshot_id;
        insertedUris.push(...batch);
      } catch (error) {
        if (shouldCancel?.() || error instanceof DOMException && error.name === "AbortError") {
          return { cancelled: true, insertedUris, snapshotId };
        }
        // Never represent the failed batch as absent: a transport/provider failure
        // after POST can still have added it remotely.
        throw new SpotifyAddTracksError(insertedUris, batch);
      }
    }
    return { cancelled: false, insertedUris, snapshotId };
  }
}
