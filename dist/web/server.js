import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { parseFile } from "../parser.js";
import { matchTrack } from "../matcher.js";
import { createPlaylistWithTracks } from "../playlist.js";
import { getAuthClient, validateAuth } from "../auth.js";
import { webLogger } from "./logger.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;
const YTMusicAuthFile = path.join(os.homedir(), ".config", "m3u-to-ytmusic", "ytmusic_auth.json");
const SEARCHER_SCRIPT = path.join(__dirname, "../ytmusic/searcher.py");
function checkYtMusicAvailable() {
    try {
        if (!fs.existsSync(YTMusicAuthFile))
            return false;
        const content = fs.readFileSync(YTMusicAuthFile, "utf8");
        const parsed = JSON.parse(content);
        const keys = Object.keys(parsed).map(k => k.toLowerCase());
        return keys.includes("cookie") || keys.includes("authorization");
    }
    catch {
        return false;
    }
}
function runYtMusicScript(input) {
    return new Promise((resolve, reject) => {
        const proc = spawn("py", ["-3.11", SEARCHER_SCRIPT]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (data) => { stdout += data.toString(); });
        proc.stderr.on("data", (data) => { stderr += data.toString(); });
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Script exited with code ${code}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            }
            catch {
                reject(new Error("Invalid JSON from script"));
            }
        });
        proc.stdin.write(JSON.stringify(input));
        proc.stdin.end();
    });
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "../../public")));
app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const sendEvent = (event) => {
        res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const removeListener = webLogger.addClient(sendEvent);
    req.on("close", () => {
        removeListener();
    });
});
app.post("/api/convert", async (req, res) => {
    const { playlistName, dryRun, threshold, tracks } = req.body;
    try {
        webLogger.info(`=== M3U to YouTube Music ===`);
        webLogger.info(`Playlist: "${playlistName}"`);
        webLogger.info(`Mode: ${dryRun ? "DRY RUN" : "FULL"}`);
        webLogger.info(`Tracks: ${tracks.length}`);
        if (checkYtMusicAvailable()) {
            webLogger.info("Using ytmusicapi backend (no quota limits)");
            const scriptInput = {
                action: "search",
                tracks: tracks.map((t) => ({ artist: t.artist, title: t.title })),
                playlistName
            };
            const result = await runYtMusicScript(scriptInput);
            const matchResults = result.results.map((r) => ({
                status: r.status,
                artist: r.artist,
                title: r.title,
                videoId: r.videoId,
                bestMatch: r.bestMatch
            }));
            const matched = matchResults.filter((r) => r.status === "matched");
            const ambiguous = matchResults.filter((r) => r.status === "ambiguous");
            const unmatched = matchResults.filter((r) => r.status === "unmatched");
            if (dryRun) {
                webLogger.success(`Matched: ${matched.length}, Ambiguous: ${ambiguous.length}, Unmatched: ${unmatched.length}`);
                webLogger.summary(matched.length, ambiguous.length, unmatched.length);
                res.json({ success: true, dryRun: true, results: matchResults, usingYtMusic: true });
                return;
            }
            webLogger.success("Playlist created!");
            if (result.playlistUrl) {
                webLogger.info(`URL: ${result.playlistUrl}`);
            }
            webLogger.summary(matched.length, ambiguous.length, unmatched.length, {
                playlistUrl: result.playlistUrl,
                playlistId: result.playlistId
            });
            res.json({
                success: true,
                dryRun: false,
                results: matchResults,
                playlistUrl: result.playlistUrl,
                playlistId: result.playlistId,
                matched: result.matched,
                usingYtMusic: true
            });
            return;
        }
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey) {
            webLogger.error("YOUTUBE_API_KEY environment variable not set");
            res.status(400).json({ error: "YOUTUBE_API_KEY not configured" });
            return;
        }
        const config = { maxResults: 5, musicCategoryId: "10", matchThreshold: threshold };
        webLogger.info("Matching tracks with YouTube Data API...");
        const matchResults = [];
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            webLogger.progress(i + 1, tracks.length, `${track.artist ? `${track.artist} - ` : ""}${track.title}`);
            const result = await matchTrack(track, apiKey, config, threshold);
            matchResults.push(result);
        }
        const matched = matchResults.filter((r) => r.status === "matched");
        const ambiguous = matchResults.filter((r) => r.status === "ambiguous");
        const unmatched = matchResults.filter((r) => r.status === "unmatched");
        if (dryRun) {
            webLogger.success(`Matched: ${matched.length}, Ambiguous: ${ambiguous.length}, Unmatched: ${unmatched.length}`);
            webLogger.summary(matched.length, ambiguous.length, unmatched.length);
            res.json({ success: true, dryRun: true, results: matchResults });
            return;
        }
        let oauth2Auth;
        webLogger.info("Authenticating with YouTube...");
        try {
            const auth = await getAuthClient();
            const isValid = await validateAuth(auth);
            if (isValid) {
                oauth2Auth = auth;
                webLogger.success("OAuth2 authenticated!");
            }
            else {
                webLogger.error("OAuth2 authentication failed");
                res.status(401).json({ error: "OAuth2 authentication required for playlist creation" });
                return;
            }
        }
        catch (err) {
            webLogger.error(`OAuth2 error: ${err.message}`);
            res.status(401).json({ error: "OAuth2 authentication required" });
            return;
        }
        webLogger.info("Creating playlist on YouTube Music...");
        const result = await createPlaylistWithTracks(oauth2Auth, playlistName, matchResults, (added, total) => {
            webLogger.progress(added, total, `Adding tracks: ${added}/${total}`);
        });
        webLogger.success("Playlist created!");
        webLogger.info(`URL: ${result.playlistUrl}`);
        webLogger.info(`Added: ${result.matched} tracks`);
        webLogger.summary(matched.length, ambiguous.length, unmatched.length, {
            playlistUrl: result.playlistUrl,
            quotaUsed: result.quotaUsed,
        });
        res.json({
            success: true,
            dryRun: false,
            results: matchResults,
            playlistUrl: result.playlistUrl,
            matched: result.matched,
            quotaUsed: result.quotaUsed,
        });
        return;
    }
    catch (err) {
        const error = err;
        webLogger.error(`Error: ${error.message}`);
        res.status(500).json({ error: error.message });
        return;
    }
});
app.post("/api/parse-m3u", async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) {
            res.status(400).json({ error: "No content provided" });
            return;
        }
        const tempPath = path.join(os.tmpdir(), `upload_${Date.now()}.m3u`);
        const fs = await import("fs");
        fs.writeFileSync(tempPath, content);
        const { tracks, format } = await parseFile(tempPath);
        fs.unlinkSync(tempPath);
        res.json({ tracks, format });
        return;
    }
    catch (err) {
        res.status(400).json({ error: err.message });
        return;
    }
});
app.get("/api/setup-ytmusic", async (_req, res) => {
    const fs = await import("fs");
    const configDir = path.dirname(YTMusicAuthFile);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    if (fs.existsSync(YTMusicAuthFile)) {
        res.json({
            configured: true,
            message: "ytmusicapi is configured",
            instructions: null
        });
        return;
    }
    res.json({
        configured: false,
        message: "ytmusicapi needs authentication",
        instructions: {
            step1: "Install ytmusicapi: pip install ytmusicapi",
            step2: `Create auth file at: ${YTMusicAuthFile}`,
            step3: "Run: ytmusicapi oauth",
            step4: "Copy the generated auth file to the path above"
        }
    });
});
app.post("/api/search-single", async (req, res) => {
    const { query, originalTrack } = req.body;
    if (!query) {
        res.status(400).json({ error: "Query is required" });
        return;
    }
    try {
        const result = await runYtMusicScript({ action: "search-single", query });
        if (result.error) {
            res.status(500).json({ error: result.error });
            return;
        }
        res.json({ results: result.results, originalTrack });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post("/api/add-to-playlist", async (req, res) => {
    const { playlistId, tracks } = req.body;
    if (!playlistId || !tracks?.length) {
        res.status(400).json({ error: "playlistId and tracks are required" });
        return;
    }
    try {
        const videoIds = tracks.map((t) => t.videoId).filter(Boolean);
        const result = await runYtMusicScript({
            action: "add-to-playlist",
            playlistId,
            videoIds
        });
        if (result.error) {
            res.status(500).json({ error: result.error });
            return;
        }
        res.json({ success: true, added: result.added });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/ytmusic-status", (_req, res) => {
    let available = false;
    try {
        if (fs.existsSync(YTMusicAuthFile)) {
            const content = fs.readFileSync(YTMusicAuthFile, "utf8");
            const parsed = JSON.parse(content);
            const keys = Object.keys(parsed).map(k => k.toLowerCase());
            available = keys.includes("cookie") || keys.includes("authorization");
            console.log('DEBUG: keys found:', keys, 'available:', available);
        }
    }
    catch (e) {
        console.log('DEBUG ERROR:', e);
    }
    res.json({ available, authFile: YTMusicAuthFile });
});
app.listen(PORT, () => {
    console.log(`🌐 Web interface: http://localhost:${PORT}`);
    console.log(`Auth file path: ${YTMusicAuthFile}`);
    console.log(`🎵 ytmusicapi backend: ${checkYtMusicAvailable() ? "Available" : "Not configured"}`);
});
//# sourceMappingURL=server.js.map