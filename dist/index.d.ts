export { parseFile, parseM3U, detectFormat, isValidM3UFile, validateFilePath, } from "./parser";
export { cleanTitle } from "./parser";
export { buildQuery, matchTrack, matchTracks, calculateConfidence, classifyMatch, levenshteinRatio, normalizeTitle, parseDuration, } from "./matcher";
export type { AuthClient } from "./matcher";
export { createPlaylist, createPlaylistWithTracks, addTracksToPlaylist, calculateQuotaUsage, } from "./playlist";
export { getAuthClient, loadCredentials, validateAuth, } from "./auth";
export { loadConfig, DEFAULT_CONFIG, resolveConfigDir, ensureConfigDir } from "./config";
export type { Track, YouTubeItem, MatchResult, PlaylistResult, MatchReport, AppConfig, CliOptions, ParsedM3UResult, } from "./types";
//# sourceMappingURL=index.d.ts.map