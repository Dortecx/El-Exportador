import { google } from "googleapis";
function extractArtistFromPath(folders) {
    if (folders.length === 0)
        return undefined;
    const lastFolder = folders[folders.length - 1];
    if (/^\d+[\s\-\.]/.test(lastFolder))
        return undefined;
    return lastFolder;
}
const PENALTY_TERMS_MUSIC_VIDEO = ["official mv", "music video", "m/v", "official video", "#shorts", "short film", "live performance", "live at", "concert"];
const BONUS_TERMS_OFFICIAL = ["official audio", "provided to youtube"];
export function buildQuery(track) {
    if (track.artist) {
        return `${track.artist} - ${track.title}`;
    }
    if (track.pathContext?.folders.length) {
        const pathArtist = extractArtistFromPath(track.pathContext.folders);
        if (pathArtist) {
            return `${pathArtist} - ${track.title}`;
        }
    }
    return track.title;
}
export function levenshteinRatio(a, b) {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower === bLower)
        return 1.0;
    if (aLower.length === 0 || bLower.length === 0)
        return 0.0;
    const matrix = [];
    for (let i = 0; i <= bLower.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= aLower.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= bLower.length; i++) {
        for (let j = 1; j <= aLower.length; j++) {
            if (bLower.charAt(i - 1) === aLower.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            }
            else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
            }
        }
    }
    const distance = matrix[bLower.length][aLower.length];
    const maxLen = Math.max(aLower.length, bLower.length);
    return 1 - distance / maxLen;
}
export function parseDuration(durationStr) {
    if (!durationStr)
        return undefined;
    const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match)
        return undefined;
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const seconds = parseInt(match[3] || "0", 10);
    return hours * 3600 + minutes * 60 + seconds;
}
export function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/\(official.*?\)/gi, "")
        .replace(/\(lyric.*?\)/gi, "")
        .replace(/\(audio.*?\)/gi, "")
        .replace(/\(video.*?\)/gi, "")
        .replace(/\[official.*?\]/gi, "")
        .replace(/\[lyric.*?\]/gi, "")
        .replace(/\[audio.*?\]/gi, "")
        .replace(/\[video.*?\]/gi, "")
        .replace(/[^a-z0-9\s]/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}
export function calculateConfidence(track, item, _searchTitle) {
    let score = 0;
    const normalizedTrackTitle = normalizeTitle(track.title);
    const normalizedItemTitle = normalizeTitle(item.title);
    if (normalizedTrackTitle === normalizedItemTitle) {
        score += 0.40;
    }
    else if (normalizedTrackTitle.includes(normalizedItemTitle) ||
        normalizedItemTitle.includes(normalizedTrackTitle)) {
        score += 0.30;
    }
    const fuzzyScore = levenshteinRatio(normalizedTrackTitle, normalizedItemTitle);
    if (fuzzyScore > 0.8) {
        score += 0.20;
    }
    else if (fuzzyScore > 0.6) {
        score += 0.10;
    }
    const artistName = track.artist || (track.pathContext?.folders.length
        ? extractArtistFromPath(track.pathContext.folders)
        : undefined);
    if (artistName) {
        const artistLower = artistName.toLowerCase();
        if (item.title.toLowerCase().includes(artistLower) ||
            item.channelTitle.toLowerCase().includes(artistLower)) {
            score += 0.30;
        }
    }
    if (track.pathContext?.folders.length && !artistName) {
        for (const folder of track.pathContext.folders) {
            const folderLower = folder.toLowerCase();
            if (item.title.toLowerCase().includes(folderLower) ||
                item.channelTitle.toLowerCase().includes(folderLower)) {
                score += 0.10;
                break;
            }
        }
    }
    if (track.duration && item.duration) {
        const expectedDuration = track.duration;
        const actualDuration = parseDuration(item.duration);
        if (actualDuration !== undefined) {
            const diff = Math.abs(expectedDuration - actualDuration);
            if (diff <= 15) {
                score += 0.10;
            }
            else if (diff <= 30) {
                score += 0.05;
            }
        }
    }
    const itemTitleLower = item.title.toLowerCase();
    for (const term of PENALTY_TERMS_MUSIC_VIDEO) {
        if (itemTitleLower.includes(term)) {
            score -= 0.20;
            break;
        }
    }
    for (const term of BONUS_TERMS_OFFICIAL) {
        if (itemTitleLower.includes(term)) {
            score += 0.15;
            break;
        }
    }
    if (item.channelTitle.toLowerCase().includes(" - topic")) {
        score += 0.15;
    }
    return Math.max(Math.min(score, 1.0), 0.0);
}
export function classifyMatch(score, threshold = 0.6) {
    if (score >= threshold)
        return "matched";
    if (score >= 0.40)
        return "ambiguous";
    return "unmatched";
}
export async function searchYouTube(query, apiKey, config) {
    const youtube = google.youtube({ version: "v3", auth: apiKey });
    const searchResponse = await youtube.search.list({
        q: query,
        type: ["video"],
        videoCategoryId: config.musicCategoryId,
        maxResults: config.maxResults,
        part: ["snippet"],
    });
    const items = searchResponse.data.items || [];
    if (items.length === 0)
        return [];
    const videoIds = items.map((item) => item.id?.videoId).filter((id) => !!id);
    const detailsResponse = await youtube.videos.list({
        id: videoIds,
        part: ["contentDetails", "snippet"],
    });
    const musicCategoryMap = new Map();
    for (const video of detailsResponse.data.items || []) {
        if (typeof video.id === "string") {
            const isMusicCategory = video.snippet?.categoryId === "10";
            musicCategoryMap.set(video.id, isMusicCategory);
        }
    }
    const detailsMap = new Map();
    for (const video of detailsResponse.data.items || []) {
        if (typeof video.id === "string") {
            const duration = video.contentDetails?.duration ?? undefined;
            detailsMap.set(video.id, duration ?? undefined);
        }
    }
    return items
        .filter((item) => {
        if (!item.id?.videoId || typeof item.id.videoId !== "string")
            return false;
        return musicCategoryMap.get(item.id.videoId) === true;
    })
        .map((item) => {
        const videoId = item.id.videoId;
        const snippet = item.snippet;
        const thumbnails = snippet?.thumbnails;
        const firstThumbnail = thumbnails ? Object.values(thumbnails)[0] : undefined;
        return {
            videoId,
            title: snippet?.title ?? "",
            channelTitle: snippet?.channelTitle ?? "",
            duration: detailsMap.get(videoId),
            thumbnailUrl: firstThumbnail?.url ?? "",
        };
    });
}
export async function matchTrack(track, apiKey, config, threshold, _auth) {
    const query = buildQuery(track);
    try {
        const results = await searchYouTube(query, apiKey, config);
        if (results.length === 0) {
            return {
                track,
                bestMatch: null,
                alternatives: [],
                confidence: 0,
                status: "unmatched",
            };
        }
        const scored = results.map((item) => ({
            item,
            score: calculateConfidence(track, item, track.title),
        }));
        scored.sort((a, b) => b.score - a.score);
        const bestMatch = scored[0].item;
        const confidence = scored[0].score;
        const status = classifyMatch(confidence, threshold);
        return {
            track,
            bestMatch,
            alternatives: scored.slice(0, 5).map((s) => s.item),
            confidence,
            status,
        };
    }
    catch (error) {
        console.error(`ERROR buscando "${track.artist} - ${track.title}":`, error.message);
        return {
            track,
            bestMatch: null,
            alternatives: [],
            confidence: 0,
            status: "unmatched",
        };
    }
}
export async function matchTracks(tracks, apiKey, config, threshold, _auth) {
    const results = [];
    for (const track of tracks) {
        const result = await matchTrack(track, apiKey, config, threshold, _auth);
        results.push(result);
    }
    return results;
}
export function simulateOfflineMatch(track) {
    const fakeVideoId = `offline_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const fakeMatch = {
        videoId: fakeVideoId,
        title: `${track.artist ? `${track.artist} - ` : ""}${track.title}`,
        channelTitle: "Simulated Channel",
        duration: undefined,
        thumbnailUrl: "",
    };
    return {
        track,
        bestMatch: fakeMatch,
        alternatives: [fakeMatch],
        confidence: 0.8,
        status: "matched",
    };
}
//# sourceMappingURL=matcher.js.map