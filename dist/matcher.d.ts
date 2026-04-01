import { OAuth2Client } from "google-auth-library";
import { Track, YouTubeItem, MatchResult, AppConfig } from "./types.js";
export type AuthClient = OAuth2Client | {
    apiKey: string;
};
export declare function buildQuery(track: Track): string;
export declare function levenshteinRatio(a: string, b: string): number;
export declare function parseDuration(durationStr: string | undefined): number | undefined;
export declare function normalizeTitle(title: string): string;
export declare function calculateConfidence(track: Track, item: YouTubeItem, _searchTitle: string): number;
export declare function classifyMatch(score: number, threshold?: number): "matched" | "ambiguous" | "unmatched";
export declare function searchYouTube(query: string, apiKey: string, config: Pick<AppConfig, "maxResults" | "musicCategoryId">): Promise<YouTubeItem[]>;
export declare function matchTrack(track: Track, apiKey: string, config: Pick<AppConfig, "maxResults" | "musicCategoryId" | "matchThreshold">, threshold: number, _auth?: AuthClient): Promise<MatchResult>;
export declare function matchTracks(tracks: Track[], apiKey: string, config: Pick<AppConfig, "maxResults" | "musicCategoryId" | "matchThreshold">, threshold: number, _auth?: AuthClient): Promise<MatchResult[]>;
export declare function simulateOfflineMatch(track: Track): MatchResult;
//# sourceMappingURL=matcher.d.ts.map