import { SpotifyPlaylistCreationIndeterminateError } from "./api";
import { buildSpotifySearchQuery, matchSpotifyTrack } from "./matcher";
import type { SpotifyAddTracksResult, SpotifyCancellationCheck, SpotifyConversionOutcome, SpotifyConversionResult, SpotifyPlaylist, SpotifyProfile, SpotifyProgressCallback, SpotifySourceTrack, SpotifyTrackCandidate } from "./types";

const MAX_CONCURRENT_SPOTIFY_SEARCHES = 15;

export type SpotifyConversionApi = {
  addTracks(playlistId: string, uris: string[], shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyAddTracksResult>;
  createPrivatePlaylist(userId: string, name: string, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyPlaylist>;
  getProfile(shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyProfile>;
  searchTracks: {
    (query: string, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyTrackCandidate[]>;
    (query: string, limit?: number, offset?: number, shouldCancel?: SpotifyCancellationCheck): Promise<SpotifyTrackCandidate[]>;
  };
};

export type SpotifyConversionOptions = {
  dryRun?: boolean;
  playlistName: string;
  onProgress?: SpotifyProgressCallback;
  shouldCancel?: (index: number, track: SpotifySourceTrack) => boolean;
  shouldSkip?: (track: SpotifySourceTrack) => boolean;
};

export async function convertSpotifyTracks(
  api: SpotifyConversionApi,
  tracks: SpotifySourceTrack[],
  options: SpotifyConversionOptions,
): Promise<SpotifyConversionResult> {
  const outcomesByIndex: Array<SpotifyConversionOutcome | undefined> = new Array(tracks.length);
  let nextIndex = 0;
  let cancelled = false;

  async function worker(): Promise<void> {
    while (!cancelled) {
      const index = nextIndex++;
      const track = tracks[index];
      if (!track) return;
      if (options.shouldCancel?.(index, track)) {
        cancelled = true;
        return;
      }
      if (options.shouldSkip?.(track)) {
        outcomesByIndex[index] = { source: track, status: "skipped" };
        continue;
      }
      options.onProgress?.(index + 1, tracks.length, track.artist, track.title, "searching");
      if (options.shouldCancel?.(index, track)) {
        cancelled = true;
        return;
      }
      try {
        const candidates = await api.searchTracks(buildSpotifySearchQuery(track), () => options.shouldCancel?.(index, track) ?? false);
        if (options.shouldCancel?.(index, track)) {
          cancelled = true;
          return;
        }
        outcomesByIndex[index] = matchSpotifyTrack(track, candidates);
      } catch (error) {
        if (options.shouldCancel?.(index, track) || error instanceof DOMException && error.name === "AbortError") {
          cancelled = true;
          return;
        }
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SPOTIFY_SEARCHES, tracks.length) }, () => worker()));
  const outcomes = outcomesByIndex.filter((outcome): outcome is SpotifyConversionOutcome => outcome !== undefined);
  const uris = outcomes.flatMap((outcome) => outcome.status === "matched" && outcome.candidate ? [outcome.candidate.uri] : []);
  const lastTrack = tracks[tracks.length - 1];
  const cancelledBeforeCreation = lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false;
  if (options.dryRun || cancelled || uris.length === 0 || cancelledBeforeCreation) {
    return { cancelled: cancelled || cancelledBeforeCreation, outcomes, remotePlaylist: { status: "not-created" } };
  }

  const profile = await api.getProfile(() => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
  if (lastTrack && options.shouldCancel?.(tracks.length, lastTrack)) {
    return { cancelled: true, outcomes, remotePlaylist: { status: "not-created" } };
  }
  let playlist: SpotifyPlaylist;
  try {
    playlist = await api.createPrivatePlaylist(profile.id, options.playlistName, () => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
  } catch (error) {
    if (error instanceof SpotifyPlaylistCreationIndeterminateError) {
      return { cancelled: true, outcomes, remotePlaylist: { status: "indeterminate" } };
    }
    if (lastTrack && (options.shouldCancel?.(tracks.length, lastTrack) || error instanceof DOMException && error.name === "AbortError")) {
      return { cancelled: true, outcomes, remotePlaylist: { status: "not-created" } };
    }
    throw error;
  }
  if (lastTrack && options.shouldCancel?.(tracks.length, lastTrack)) {
    return { cancelled: true, outcomes, remotePlaylist: { id: playlist.id, insertedUris: [], status: "partial", ...(playlist.url ? { url: playlist.url } : {}) } };
  }
  try {
    const added = await api.addTracks(playlist.id, uris, () => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
    const conversionCancelled = cancelled || added.cancelled;
    const status = conversionCancelled || outcomes.some((outcome) => outcome.status !== "matched") ? "partial" : "created";
    return { cancelled: conversionCancelled, outcomes, remotePlaylist: { id: playlist.id, insertedUris: added.insertedUris, status, ...(playlist.url ? { url: playlist.url } : {}) } };
  } catch (error) {
    const insertedUris = error instanceof Error && "insertedUris" in error && Array.isArray(error.insertedUris)
      ? error.insertedUris.filter((uri): uri is string => typeof uri === "string")
      : [];
    return {
      cancelled,
      outcomes,
      remotePlaylist: {
          id: playlist.id,
          insertedUris,
          ...(error instanceof Error && "indeterminateUris" in error && Array.isArray(error.indeterminateUris)
            ? { indeterminateUris: error.indeterminateUris.filter((uri): uri is string => typeof uri === "string").slice(0, 100) }
            : {}),
          insertionError: "SPOTIFY_INSERT_INDETERMINATE",
          status: "partial",
          ...(playlist.url ? { url: playlist.url } : {}),
        },
    };
  }
}
