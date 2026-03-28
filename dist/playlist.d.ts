import { OAuth2Client } from "google-auth-library";
import { PlaylistResult, MatchResult } from "./types.js";
export declare function createPlaylist(auth: OAuth2Client, name: string): Promise<{
    playlistId: string;
    playlistUrl: string;
}>;
export declare function addTracksToPlaylist(auth: OAuth2Client, playlistId: string, matchedResults: MatchResult[], onProgress?: (added: number, total: number) => void): Promise<{
    added: number;
    failed: number;
    quotaUsed: number;
}>;
export declare function createPlaylistWithTracks(auth: OAuth2Client, name: string, matchedResults: MatchResult[], onProgress?: (added: number, total: number) => void): Promise<PlaylistResult>;
export declare function calculateQuotaUsage(numTracks: number, matched: number): number;
//# sourceMappingURL=playlist.d.ts.map