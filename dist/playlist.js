import { google } from "googleapis";
const YOUTUBE_BASE_URL = "https://www.youtube.com/playlist?list=";
export async function createPlaylist(auth, name) {
    const youtube = google.youtube({ version: "v3", auth });
    const response = await youtube.playlists.insert({
        part: ["snippet", "status"],
        requestBody: {
            snippet: {
                title: name,
                description: `Created from M3U playlist by m3u-to-ytmusic`,
            },
            status: {
                privacyStatus: "private",
            },
        },
    });
    const playlistId = response.data.id;
    if (!playlistId) {
        throw new Error("Failed to create playlist: no ID returned");
    }
    return {
        playlistId,
        playlistUrl: `${YOUTUBE_BASE_URL}${playlistId}`,
    };
}
export async function addTracksToPlaylist(auth, playlistId, matchedResults, onProgress) {
    const youtube = google.youtube({ version: "v3", auth });
    let quotaUsed = 0;
    let added = 0;
    let failed = 0;
    for (let i = 0; i < matchedResults.length; i++) {
        const result = matchedResults[i];
        if (!result.bestMatch) {
            failed++;
            continue;
        }
        try {
            await youtube.playlistItems.insert({
                part: ["snippet"],
                requestBody: {
                    snippet: {
                        playlistId,
                        position: added,
                        resourceId: {
                            kind: "youtube#video",
                            videoId: result.bestMatch.videoId,
                        },
                    },
                },
            });
            added++;
            quotaUsed += 50;
            if (onProgress) {
                onProgress(added, matchedResults.length);
            }
        }
        catch (error) {
            const err = error;
            if (err.code === 403 || err.errors?.[0]?.reason === "quotaExceeded") {
                console.error("\n\nYouTube API quota exceeded!");
                console.error(`${added} tracks were added before quota ran out.`);
                console.error("\nPlease try again tomorrow or request a quota increase:");
                console.error("https://developers.google.com/youtube/v3/getting-started#quota\n");
                return { added, failed: matchedResults.length - added, quotaUsed };
            }
            if (err.code === 429) {
                console.warn(`Rate limited at track ${added + 1}, waiting...`);
                await sleep(2000);
                i--;
                continue;
            }
            failed++;
            console.warn(`Failed to add track: ${result.track.title}`);
        }
        await sleep(100);
    }
    return { added, failed, quotaUsed };
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function createPlaylistWithTracks(auth, name, matchedResults, onProgress) {
    const { playlistId, playlistUrl } = await createPlaylist(auth, name);
    const { added, quotaUsed } = await addTracksToPlaylist(auth, playlistId, matchedResults, onProgress);
    const unmatched = matchedResults.filter((r) => !r.bestMatch).length;
    const ambiguous = matchedResults.filter((r) => r.status === "ambiguous").length;
    return {
        playlistId,
        playlistUrl,
        totalTracks: matchedResults.length,
        matched: added,
        unmatched,
        ambiguous,
        unmatchedTracks: matchedResults.filter((r) => !r.bestMatch).map((r) => r.track),
        quotaUsed,
    };
}
export function calculateQuotaUsage(numTracks, matched) {
    const searchCost = numTracks * 1;
    const insertCost = matched * 50;
    return searchCost + insertCost;
}
//# sourceMappingURL=playlist.js.map