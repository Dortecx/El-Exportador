import { buildSpotifySearchQuery, matchSpotifyTrack } from "./matcher";
import type { SpotifyAddTracksResult, SpotifyConversionOutcome, SpotifyConversionResult, SpotifyPlaylist, SpotifyProfile, SpotifyProgressCallback, SpotifySourceTrack, SpotifyTrackCandidate } from "./types";

const MAX_CONCURRENT_SPOTIFY_SEARCHES = 15;

export type SpotifyConversionApi = {
  addTracks(playlistId: string, uris: string[], shouldCancel?: () => boolean): Promise<SpotifyAddTracksResult>;
  createPrivatePlaylist(userId: string, name: string): Promise<SpotifyPlaylist>;
  getProfile(): Promise<SpotifyProfile>;
  searchTracks(query: string): Promise<SpotifyTrackCandidate[]>;
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
      const candidates = await api.searchTracks(buildSpotifySearchQuery(track));
      outcomesByIndex[index] = matchSpotifyTrack(track, candidates);
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

  const profile = await api.getProfile();
  if (lastTrack && options.shouldCancel?.(tracks.length, lastTrack)) {
    return { cancelled: true, outcomes, remotePlaylist: { status: "not-created" } };
  }
  const playlist = await api.createPrivatePlaylist(profile.id, options.playlistName);
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
      remotePlaylist: { id: playlist.id, insertedUris, insertionError: "SPOTIFY_INSERT_FAILED", status: "partial", ...(playlist.url ? { url: playlist.url } : {}) },
    };
  }
}
