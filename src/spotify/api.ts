import type { SpotifyAddTracksResult, SpotifyFetch, SpotifyPlaylist, SpotifyProfile, SpotifyTrackCandidate } from "./types";

const SPOTIFY_API_URL = "https://api.spotify.com/v1";
// Spotify may provide an unbounded retry hint; wait no longer than one minute per retry.
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;

export class SpotifyApiError extends Error {
  constructor(public readonly status: number) {
    super(`Spotify API request failed with status ${status}`);
  }
}

export class SpotifyAddTracksError extends Error {
  constructor(public readonly insertedUris: string[]) {
    super("Spotify playlist track insertion failed");
  }
}

export type SpotifyApiOptions = {
  accessToken: string;
  fetch: SpotifyFetch;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
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
  private cooldownPromise: Promise<void> | undefined;

  constructor(private readonly options: SpotifyApiOptions) {
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async waitForCooldown(): Promise<void> {
    await this.cooldownPromise;
  }

  private extendCooldown(milliseconds: number): Promise<void> {
    if (!this.cooldownPromise) {
      this.cooldownPromise = this.sleep(milliseconds).finally(() => { this.cooldownPromise = undefined; });
    }
    return this.cooldownPromise;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForCooldown();
      const response = await this.options.fetch(`${SPOTIFY_API_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.options.accessToken}`, ...init.headers },
      });
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

  async createPrivatePlaylist(_userId: string, name: string): Promise<SpotifyPlaylist> {
    const body = await (await this.request("/me/playlists", {
      body: JSON.stringify({ name, public: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })).json() as { external_urls?: { spotify?: string }; id?: string; name?: string };
    if (!body.id) throw new SpotifyApiError(502);
    return { id: body.id, isPrivate: true, name: body.name ?? name, ...(body.external_urls?.spotify ? { url: body.external_urls.spotify } : {}) };
  }

  async searchTracks(query: string, limit = 5, offset = 0): Promise<SpotifyTrackCandidate[]> {
    const body = await (await this.request(`/search?${new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      q: query,
      type: "track",
    })}`)).json() as {
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
        })).json() as { snapshot_id?: string };
        snapshotId = body.snapshot_id;
        insertedUris.push(...batch);
      } catch {
        throw new SpotifyAddTracksError(insertedUris);
      }
    }
    return { cancelled: false, insertedUris, snapshotId };
  }
}
