import { SpotifyApiError, SpotifyPlaylistCreationIndeterminateError } from "./api";
import { buildSpotifySearchQueries, matchSpotifyTrack } from "./matcher";
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
  console.info("[spotify] conversion start", { dryRun: options.dryRun === true, tracks: tracks.length });
  const outcomesByIndex: Array<SpotifyConversionOutcome | undefined> = new Array(tracks.length);
  let nextIndex = 0;
  let cancelled = false;

  function finish(result: SpotifyConversionResult): SpotifyConversionResult {
    const matched = result.outcomes.filter((outcome) => outcome.status === "matched").length;
    const ambiguous = result.outcomes.filter((outcome) => outcome.status === "ambiguous").length;
    const unmatched = result.outcomes.filter((outcome) => outcome.status === "unmatched").length;
    const searchError = result.outcomes.filter((outcome) => outcome.status === "search_error").length;
    const skipped = result.outcomes.filter((outcome) => outcome.status === "skipped").length;
    console.info("[spotify] conversion summary", {
      ambiguous,
      cancelled: result.cancelled,
      matched,
      playlistStatus: result.remotePlaylist.status,
      searchError,
      skipped,
      total: tracks.length,
      unmatched,
    });
    return result;
  }

  async function worker(): Promise<void> {
    while (!cancelled) {
      const index = nextIndex++;
      const track = tracks[index];
      if (!track) return;
      if (options.shouldCancel?.(index, track)) {
        console.warn("[spotify] conversion cancelled", { operation: "track-search", trackOrdinal: index + 1, total: tracks.length });
        cancelled = true;
        return;
      }
      if (options.shouldSkip?.(track)) {
        outcomesByIndex[index] = { source: track, status: "skipped" };
        continue;
      }
      console.info("[spotify] track search start", { trackOrdinal: index + 1, total: tracks.length });
      options.onProgress?.(index + 1, tracks.length, track.artist, track.title, "searching");
      if (options.shouldCancel?.(index, track)) {
        console.warn("[spotify] conversion cancelled", { operation: "track-search", trackOrdinal: index + 1, total: tracks.length });
        cancelled = true;
        return;
      }
      try {
        const candidates: SpotifyTrackCandidate[] = [];
        const seenUris = new Set<string>();
        const shouldCancel = () => options.shouldCancel?.(index, track) ?? false;
        let queryOrdinal = 0;
        for (const query of buildSpotifySearchQueries(track)) {
          queryOrdinal += 1;
          if (shouldCancel()) {
            console.warn("[spotify] conversion cancelled", { operation: "query-search", queryOrdinal, trackOrdinal: index + 1, total: tracks.length });
            cancelled = true;
            return;
          }
          console.info("[spotify] query search start", { queryOrdinal, trackOrdinal: index + 1, total: tracks.length });
          const results = await api.searchTracks(query, shouldCancel);
          console.info("[spotify] query search end", { candidateCount: results.length, queryOrdinal, trackOrdinal: index + 1, total: tracks.length });
          if (shouldCancel()) {
            console.warn("[spotify] conversion cancelled", { operation: "query-search", queryOrdinal, trackOrdinal: index + 1, total: tracks.length });
            cancelled = true;
            return;
          }
          for (const candidate of results) {
            if (seenUris.has(candidate.uri)) continue;
            seenUris.add(candidate.uri);
            candidates.push(candidate);
            if (candidates.length === 15) break;
          }
          if (candidates.length === 15) break;
        }
        outcomesByIndex[index] = matchSpotifyTrack(track, candidates);
        console.info("[spotify] track search end", { candidateCount: candidates.length, status: outcomesByIndex[index]?.status, trackOrdinal: index + 1, total: tracks.length });
      } catch (error) {
        if (options.shouldCancel?.(index, track) || error instanceof DOMException && error.name === "AbortError") {
          console.warn("[spotify] conversion cancelled", { operation: "track-search", trackOrdinal: index + 1, total: tracks.length });
          cancelled = true;
          return;
        }
        if (error instanceof SpotifyApiError && error.status === 429) {
          outcomesByIndex[index] = { reason: "rate_limited", source: track, status: "search_error" };
          console.warn("[spotify] track search retry needed", { reason: "rate_limited", trackOrdinal: index + 1, total: tracks.length });
          continue;
        }
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SPOTIFY_SEARCHES, tracks.length) }, () => worker()));
  const outcomes = outcomesByIndex.filter((outcome): outcome is SpotifyConversionOutcome => outcome !== undefined);
  const uris = outcomes.flatMap((outcome) => outcome.status === "matched" && outcome.candidate ? [outcome.candidate.uri] : []);
  const hasSearchErrors = outcomes.some((outcome) => outcome.status === "search_error");
  const lastTrack = tracks[tracks.length - 1];
  const cancelledBeforeCreation = lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false;
  if (options.dryRun || cancelled || hasSearchErrors || uris.length === 0 || cancelledBeforeCreation) {
    if (cancelledBeforeCreation) console.warn("[spotify] conversion cancelled", { operation: "playlist-create", total: tracks.length });
    return finish({ cancelled: cancelled || cancelledBeforeCreation, outcomes, remotePlaylist: { status: "not-created" } });
  }

  const profile = await api.getProfile(() => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
  if (lastTrack && options.shouldCancel?.(tracks.length, lastTrack)) {
    console.warn("[spotify] conversion cancelled", { operation: "playlist-create", total: tracks.length });
    return finish({ cancelled: true, outcomes, remotePlaylist: { status: "not-created" } });
  }
  let playlist: SpotifyPlaylist;
  try {
    playlist = await api.createPrivatePlaylist(profile.id, options.playlistName, () => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
  } catch (error) {
    if (error instanceof SpotifyPlaylistCreationIndeterminateError) {
      console.warn("[spotify] conversion cancelled", { operation: "playlist-create", total: tracks.length });
      return finish({ cancelled: true, outcomes, remotePlaylist: { status: "indeterminate" } });
    }
    if (lastTrack && (options.shouldCancel?.(tracks.length, lastTrack) || error instanceof DOMException && error.name === "AbortError")) {
      console.warn("[spotify] conversion cancelled", { operation: "playlist-create", total: tracks.length });
      return finish({ cancelled: true, outcomes, remotePlaylist: { status: "not-created" } });
    }
    throw error;
  }
  if (lastTrack && options.shouldCancel?.(tracks.length, lastTrack)) {
    console.warn("[spotify] conversion cancelled", { operation: "playlist-insert", total: tracks.length });
    return finish({ cancelled: true, outcomes, remotePlaylist: { id: playlist.id, insertedUris: [], status: "partial", ...(playlist.url ? { url: playlist.url } : {}) } });
  }
  try {
    const added = await api.addTracks(playlist.id, uris, () => lastTrack ? options.shouldCancel?.(tracks.length, lastTrack) ?? false : false);
    const conversionCancelled = cancelled || added.cancelled;
    const status = conversionCancelled || outcomes.some((outcome) => outcome.status !== "matched") ? "partial" : "created";
    return finish({
      cancelled: conversionCancelled,
      outcomes,
      remotePlaylist: {
        id: playlist.id,
        insertedUris: added.insertedUris,
        ...(added.indeterminateUris?.length ? { indeterminateUris: added.indeterminateUris } : {}),
        status,
        ...(playlist.url ? { url: playlist.url } : {}),
      },
    });
  } catch (error) {
    const insertedUris = error instanceof Error && "insertedUris" in error && Array.isArray(error.insertedUris)
      ? error.insertedUris.filter((uri): uri is string => typeof uri === "string")
      : [];
    return finish({
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
    });
  }
}
