import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { parseFile } from "../parser.js";
import { webLogger, LogEvent } from "./logger.js";
import type { Track } from "../types.js";
import {
  addToPlaylistOnYtMusic,
  checkYtMusicAvailable,
  convertWithYtMusic,
  searchSingleOnYtMusic,
  YTMusicAuthFile,
  ProgressCallback,
} from "../ytmusic/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "../../public")));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send initial connection confirmation
  res.write(`event: log\ndata: ${JSON.stringify({ type: "info", message: "__SSE_CONNECTED__" })}\n\n`);

  const sendEvent = (event: LogEvent) => {
    res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const removeListener = webLogger.addClient(sendEvent);

  req.on("close", () => {
    removeListener();
  });
});

interface ConversionRequest {
  playlistName: string;
  dryRun: boolean;
  threshold: number;
  tracks: Array<{ title: string; artist: string; duration?: number; file: string }>;
}

app.post("/api/convert", async (req, res): Promise<void> => {
  const { playlistName, dryRun, threshold: _threshold, tracks } = req.body as ConversionRequest;

  try {
    webLogger.info(`=== M3U to YouTube Music ===`);
    webLogger.info(`Playlist: "${playlistName}"`);
    webLogger.info(`Mode: ${dryRun ? "DRY RUN" : "FULL"}`);
    webLogger.info(`Tracks: ${tracks.length}`);

    if (!checkYtMusicAvailable()) {
      webLogger.error("ytmusicapi backend not configured");
      res.status(400).json({ error: "ytmusicapi backend not configured" });
      return;
    }

    webLogger.info("Using ytmusicapi backend (no quota limits)");
    // Show initial progress immediately  
    webLogger.progress(0, tracks.length, 'Searching tracks on YouTube Music...');

    // Progress callback to update UI in real-time
    const progressCallback: ProgressCallback = (current, total, artist, title, status) => {
      console.log(`[PROGRESS-DEBUG] server.ts: progressCallback invoked with current=${current}, total=${total}, artist=${artist}, title=${title}, status=${status}`);
      webLogger.progress(current, total, `${artist} - ${title} [${status}]`);
    };

    const result = await convertWithYtMusic(tracks as Track[], playlistName, { dryRun }, progressCallback);

    // Show completed progress after results
    const results = result?.results ?? [];
    const matchedCount = results.filter((r) => r.status === "matched").length;
    webLogger.progress(tracks.length, tracks.length, `Completed ${matchedCount}/${tracks.length} matched`);

    const matched = results.filter((r) => r.status === "matched");
    const ambiguous = results.filter((r) => r.status === "ambiguous");
    const unmatched = results.filter((r) => r.status === "unmatched");

    if (dryRun) {
      webLogger.success(`Matched: ${matched.length}, Ambiguous: ${ambiguous.length}, Unmatched: ${unmatched.length}`);
      webLogger.summary(matched.length, ambiguous.length, unmatched.length);
      res.json({ success: true, dryRun: true, results, usingYtMusic: true });
      return;
    }

    webLogger.success("Playlist created!");
    if (result?.playlistUrl) {
      webLogger.info(`URL: ${result.playlistUrl}`);
    }
    webLogger.info(`Added: ${matched.length} tracks`);
    webLogger.summary(matched.length, ambiguous.length, unmatched.length, {
      playlistUrl: result?.playlistUrl,
      playlistId: result?.playlistId,
    });

    res.json({
      success: true,
      dryRun: false,
      results,
      playlistUrl: result?.playlistUrl,
      playlistId: result?.playlistId,
      matched: matched.length,
      usingYtMusic: true,
    });
    return;
  } catch (err) {
    const error = err as Error;
    webLogger.error(`Error: ${error.message}`);
    res.status(500).json({ error: error.message });
    return;
  }
});

app.post("/api/parse-m3u", async (req, res): Promise<void> => {
  try {
    const { content } = req.body as { content: string };
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
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
});

app.get("/api/setup-ytmusic", async (_req, res): Promise<void> => {
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

app.post("/api/search-single", async (req, res): Promise<void> => {
  const { query, originalTrack } = req.body as { query: string; originalTrack: { artist: string; title: string } };

  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  try {
    const result = await searchSingleOnYtMusic(query);
    if (result.error) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ results: result.results, originalTrack });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/add-to-playlist", async (req, res): Promise<void> => {
  const { playlistId, tracks } = req.body as {
    playlistId: string;
    tracks: Array<{ videoId: string; artist: string; title: string }>
  };

  if (!playlistId || !tracks?.length) {
    res.status(400).json({ error: "playlistId and tracks are required" });
    return;
  }

  try {
    const videoIds = tracks.map((t) => t.videoId).filter(Boolean);
    const result = await addToPlaylistOnYtMusic(playlistId, videoIds);

    if (result.error) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.json({ success: true, added: result.added });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/ytmusic-status", (_req, res): void => {
  let available = false;
  try {
    if (fs.existsSync(YTMusicAuthFile)) {
      const content = fs.readFileSync(YTMusicAuthFile, "utf8");
      const parsed = JSON.parse(content);
      const keys = Object.keys(parsed).map(k => k.toLowerCase());
      available = keys.includes("cookie") || keys.includes("authorization");
      console.log('DEBUG: keys found:', keys, 'available:', available);
    }
  } catch (e) {
    console.log('DEBUG ERROR:', e);
  }
  res.json({ available, authFile: YTMusicAuthFile });
});

// SSE endpoint for real-time progress
app.get("/api/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const removeClient = webLogger.addClient((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    removeClient();
    res.end();
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
  console.log(`Auth file path: ${YTMusicAuthFile}`);
  console.log(`🎵 ytmusicapi backend: ${checkYtMusicAvailable() ? "Available" : "Not configured"}`);
});
