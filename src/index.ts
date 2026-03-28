export {
  parseFile,
  parseM3U,
  detectFormat,
  isValidM3UFile,
  validateFilePath,
} from "./parser.js";

export { cleanTitle } from "./parser.js";

export {
  buildQuery,
  matchTrack,
  matchTracks,
  calculateConfidence,
  classifyMatch,
  levenshteinRatio,
  normalizeTitle,
  parseDuration,
} from "./matcher.js";

export type { AuthClient } from "./matcher.js";

export {
  createPlaylist,
  createPlaylistWithTracks,
  addTracksToPlaylist,
  calculateQuotaUsage,
} from "./playlist.js";

export {
  getAuthClient,
  loadCredentials,
  validateAuth,
} from "./auth.js";

export { loadConfig, DEFAULT_CONFIG, resolveConfigDir, ensureConfigDir } from "./config.js";

export type {
  Track,
  YouTubeItem,
  MatchResult,
  PlaylistResult,
  MatchReport,
  AppConfig,
  CliOptions,
  ParsedM3UResult,
} from "./types.js";
