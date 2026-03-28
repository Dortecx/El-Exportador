export interface Track {
    title: string;
    artist: string;
    duration?: number;
    file: string;
    pathContext?: {
        folders: string[];
        filename: string;
    };
}
export interface YouTubeItem {
    videoId: string;
    title: string;
    channelTitle: string;
    duration?: string;
    thumbnailUrl: string;
}
export interface MatchResult {
    track: Track;
    bestMatch: YouTubeItem | null;
    alternatives: YouTubeItem[];
    confidence: number;
    status: "matched" | "unmatched" | "ambiguous";
}
export interface PlaylistResult {
    playlistId: string;
    playlistUrl: string;
    totalTracks: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
    unmatchedTracks: Track[];
    quotaUsed: number;
}
export interface MatchReport {
    playlistName: string;
    playlistUrl?: string;
    matched: MatchResult[];
    ambiguous: MatchResult[];
    unmatched: MatchResult[];
    summary: {
        total: number;
        matchedCount: number;
        ambiguousCount: number;
        unmatchedCount: number;
    };
}
export interface AppConfig {
    matchThreshold: number;
    maxResults: number;
    musicCategoryId: string;
    tokenPath: string;
    credentialsPath: string;
}
export interface CliOptions {
    file: string;
    name?: string;
    interactive: boolean;
    dryRun: boolean;
    offline: boolean;
    threshold: number;
    output?: string;
    verbose: boolean;
    credentials?: string;
}
export interface ParsedM3UResult {
    tracks: Track[];
    format: "extended" | "standard";
}
//# sourceMappingURL=types.d.ts.map