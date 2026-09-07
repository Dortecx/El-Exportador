export type SpotifySafeErrorCode =
  | "SPOTIFY_CONFIGURATION_REQUIRED"
  | "SPOTIFY_WINDOWS_ONLY"
  | "SPOTIFY_AUTHENTICATION_REQUIRED"
  | "SPOTIFY_RATE_LIMITED"
  | "SPOTIFY_PROVIDER_UNAVAILABLE";

export type SpotifyProfile = {
  id: string;
  displayName?: string;
};

export type SpotifyTokenState = {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochMs: number;
  scope: string;
  tokenType: string;
  profile?: SpotifyProfile;
};

export type SpotifyClientConfig = {
  enabled: boolean;
  supported: boolean;
  reason: SpotifySafeErrorCode | null;
  redirectUri: string;
  clientId?: string;
};

export type SpotifyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SpotifyAddTracksResult = {
  cancelled: boolean;
  /** Batches confirmed by Spotify before this result was produced. */
  insertedUris: string[];
  /** A failed POST may have been applied; these URIs must not be retried automatically. */
  indeterminateUris?: string[];
  snapshotId?: string;
};

export type SpotifySourceTrack = {
  artist: string;
  durationMs?: number;
  title: string;
};

export type SpotifyTrackCandidate = {
  artists: { name: string }[];
  durationMs?: number;
  id: string;
  title: string;
  uri: string;
};

export type SpotifyTrackMatch = {
  alternatives: SpotifyTrackCandidate[];
  candidate: SpotifyTrackCandidate | null;
  confidence: number;
  source: SpotifySourceTrack;
  status: "matched" | "ambiguous" | "unmatched";
};

export type SpotifyPlaylist = {
  id: string;
  isPrivate: true;
  name: string;
  url?: string;
};

/** A callback owned by one local conversion run; it must never be reused across runs. */
export type SpotifyCancellationCheck = () => boolean;

export type SpotifyProgressCallback = (current: number, total: number, artist: string, title: string, status: string) => void;

export type SpotifyConversionOutcome = SpotifyTrackMatch | {
  source: SpotifySourceTrack;
  status: "skipped";
};

export type SpotifyRemotePlaylistState =
  | { status: "not-created" }
  /** A create POST was dispatched but cancellation prevented confirmation; no playlist ID is exposed. */
  | { status: "indeterminate" }
  | {
      id: string;
      /** Only Spotify-confirmed additions. */
      insertedUris: string[];
      /** A bounded batch whose POST outcome could not be confirmed. */
      indeterminateUris?: string[];
      insertionError?: "SPOTIFY_INSERT_INDETERMINATE";
      status: "created" | "partial";
      url?: string;
    };

export type SpotifyConversionResult = {
  cancelled: boolean;
  outcomes: SpotifyConversionOutcome[];
  remotePlaylist: SpotifyRemotePlaylistState;
};
