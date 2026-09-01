import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { parseFile } from "../parser";
import { SessionService } from "../services/session.service";
import { addToPlaylistOnYtMusic, configureYtMusicBrowserAuth, searchSingleOnYtMusic } from "../ytmusic/client";
import { GuidedBrowserAuth } from "./guidedBrowserAuth";

// Obtener la ruta del directorio actual usando import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SSE setup
type SseClient = { id: string; res: express.Response };
const clients = new Set<SseClient>();

function addClient(clientId: string, res: express.Response) {
  clients.add({ id: clientId, res });
}

function removeClient(clientId: string) {
  clients.forEach(client => {
    if (client.id === clientId) {
      clients.delete(client);
    }
  });
}

function broadcastToAllClients(event: { type: string; [key: string]: unknown }) {
  clients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error('Error broadcasting to client:', err);
    }
  });
}

const app = express();
const guidedBrowserAuth = new GuidedBrowserAuth(configureYtMusicBrowserAuth);
const PORT = parseInt(process.env.PORT || "3000", 10);

const MANUAL_SEARCH_QUEUE_LIMIT = 20;

type ManualSearchJob = {
  key: string;
  query: string;
  artist: string;
  title: string;
  threshold: number;
  offset: number;
  callers: Set<symbol>;
  promise: Promise<any>;
  resolve: (result: any) => void;
  reject: (error: unknown) => void;
  queued: boolean;
};

const manualSearchQueue: ManualSearchJob[] = [];
const manualSearchJobs = new Map<string, ManualSearchJob>();
let manualSearchRunning = false;

function normalizeManualSearchPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function manualSearchKey(query: string, artist: string, title: string, threshold: number, offset: number): string {
  return [...[query, artist, title].map(normalizeManualSearchPart), threshold.toFixed(2), String(offset)].join("\u0000");
}

function isTransientEmptyJsonParseError(error: unknown): boolean {
  return error instanceof Error && /Expecting value/i.test(error.message);
}

function waitForManualSearchRetry(retry: number): Promise<void> {
  const exponentialDelay = 1_000 * 2 ** retry;
  const jitter = Math.floor(Math.random() * 501);
  return new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
}

async function searchManualTrackWithRetry(query: string, artist: string, title: string, threshold: number, offset: number): Promise<any> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await searchSingleOnYtMusic(query, artist, title, threshold, offset);
    } catch (error) {
      if (!isTransientEmptyJsonParseError(error) || retry >= 2) throw error;
      await waitForManualSearchRetry(retry);
    }
  }
}

function drainManualSearchQueue(): void {
  if (manualSearchRunning) return;
  const job = manualSearchQueue.shift();
  if (!job) return;
  job.queued = false;

  if (job.callers.size === 0) {
    manualSearchJobs.delete(job.key);
    drainManualSearchQueue();
    return;
  }

  manualSearchRunning = true;
  void searchManualTrackWithRetry(job.query, job.artist, job.title, job.threshold, job.offset)
    .then(job.resolve, job.reject)
    .finally(() => {
      manualSearchRunning = false;
      if (manualSearchJobs.get(job.key) === job) manualSearchJobs.delete(job.key);
      drainManualSearchQueue();
    });
}

function enqueueManualSearch(query: string, artist: string, title: string, threshold: number, offset: number): {
  promise: Promise<any>;
  abandon: () => void;
} | null {
  const key = manualSearchKey(query, artist, title, threshold, offset);
  const caller = Symbol("manual-search-caller");
  let job = manualSearchJobs.get(key);

  let queued = false;
  if (!job) {
    if (manualSearchQueue.length >= MANUAL_SEARCH_QUEUE_LIMIT) return null;
    let resolve!: (result: any) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<any>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    job = { key, query, artist, title, threshold, offset, callers: new Set(), promise, resolve, reject, queued: true };
    manualSearchJobs.set(key, job);
    manualSearchQueue.push(job);
    queued = true;
  }

  job.callers.add(caller);
  if (queued) drainManualSearchQueue();
  return {
    promise: job.promise,
    abandon: () => {
      job!.callers.delete(caller);
      if (job!.queued && job!.callers.size === 0) {
        const queueIndex = manualSearchQueue.indexOf(job!);
        if (queueIndex !== -1) manualSearchQueue.splice(queueIndex, 1);
        if (manualSearchJobs.get(key) === job) manualSearchJobs.delete(key);
      }
    },
  };
}

// Middleware
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Ruta absoluta a la carpeta 'public'
const publicDir = path.resolve(__dirname, '../../public');

// Verificar que la carpeta 'public' exista
if (!fs.existsSync(publicDir)) {
  console.error(`❌ Error: La carpeta 'public' no existe en: ${publicDir}`);
  process.exit(1);
}
app.use(express.static(publicDir));

// Configurar CORS para permitir comunicación entre popup y página principal
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.post("/api/ytmusic-auth/browser/start", async (_req, res) => {
  const result = await guidedBrowserAuth.start();
  res.status(result.status === "error" ? 400 : 200).json(result);
});

app.get("/api/ytmusic-auth/browser/status", (_req, res) => {
  res.json(guidedBrowserAuth.status());
});

app.post("/api/ytmusic-auth/browser/cancel", async (_req, res) => {
  res.json(await guidedBrowserAuth.cancel());
});

app.post("/api/ytmusic-auth/browser/disconnect", async (_req, res) => {
  await guidedBrowserAuth.disconnect();
  SessionService.logout(res);
  res.json({ status: "idle" });
});

app.get("/api/auth-status", (req, res) => {
  const connected = guidedBrowserAuth.status().status === "connected";
  if (connected && req.cookies?.ytmusic_session !== "authenticated") SessionService.setAuthenticated(res);
  res.json({ authenticated: connected || req.cookies?.ytmusic_session === "authenticated" });
});

app.post("/api/add-to-playlist", async (req, res) => {
  const playlistId = typeof req.body?.playlistId === "string" ? req.body.playlistId.trim() : "";
  const tracks = req.body?.tracks;

  if (!playlistId || !Array.isArray(tracks)) {
    return res.status(400).json({ error: "A playlist and selected tracks are required" });
  }

  const videoIds = [...new Set(
    tracks
      .map((track) => typeof track?.videoId === "string" ? track.videoId.trim() : "")
      .filter(Boolean)
  )];

  if (videoIds.length === 0) {
    return res.status(400).json({ error: "At least one selected track is required" });
  }

  try {
    const result = await addToPlaylistOnYtMusic(playlistId, videoIds);
    const addedCount = result?.added;
    if (result?.success !== true || !Number.isInteger(addedCount) || addedCount !== videoIds.length) {
      return res.status(502).json({ error: "Could not confirm all selected tracks were added" });
    }
    return res.json({ success: true, count: addedCount });
  } catch {
    return res.status(502).json({ error: "Could not add selected tracks" });
  }
});

app.post("/api/search-single", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const artist = typeof req.body?.artist === "string" ? req.body.artist.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const threshold = req.body?.threshold;
      const offset = req.body?.offset;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 0.60) {
      return res.status(400).json({ error: "Manual search threshold must be a finite number from 0 to 0.60" });
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10 || offset % 5 !== 0) {
        return res.status(400).json({ error: "Manual search offset must be 0, 5, or 10" });
      }
      if (!query) {
    return res.status(400).json({ error: "A search query is required" });
  }

  const queuedSearch = enqueueManualSearch(query, artist, title, threshold, offset);
  if (!queuedSearch) {
    return res.status(429).json({ error: "Manual search queue is full. Please try again shortly." });
  }

  let abandoned = false;
  let responseComplete = false;
  const abandon = () => {
    if (abandoned || responseComplete) return;
    abandoned = true;
    queuedSearch.abandon();
  };
  req.once("aborted", abandon);
  res.once("close", abandon);

  try {
    const result = await queuedSearch.promise;
    if (abandoned) return;
    responseComplete = true;
    if (result.error) {
      return res.status(502).json({ error: "YouTube Music search failed" });
    }
    return res.json({
          results: result.results || [],
          hasMore: result.hasMore === true,
          pageCount: Number.isInteger(result.pageCount) && result.pageCount >= 0 ? result.pageCount : 0,
          resultCount: Number.isInteger(result.resultCount) && result.resultCount >= 0 ? result.resultCount : 0,
        });
  } catch {
    if (abandoned) return;
    responseComplete = true;
    return res.status(502).json({ error: "YouTube Music search failed" });
  }
});

// Endpoint para parsear contenido M3U
app.post("/api/parse-m3u", async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    
    // Crear un archivo temporal para parsear
    const tempFilePath = path.join(os.tmpdir(), `temp_playlist_${Date.now()}.m3u`);
    fs.writeFileSync(tempFilePath, content);
    
    // Parsear el archivo
    const result = parseFile(tempFilePath);
    
    // Eliminar el archivo temporal
    fs.unlinkSync(tempFilePath);
    
    return res.json({
      tracks: result.tracks,
      playlistName: result.playlistName || path.basename(tempFilePath, path.extname(tempFilePath))
    });
  } catch (err) {
    console.error("Error al parsear M3U:", err);
    return res.status(500).json({ error: "Failed to parse M3U content" });
  }
});

// Endpoint para convertir la playlist
app.post("/api/convert", async (req, res) => {
  try {
    const { tracks, playlistName, dryRun, threshold } = req.body;
    if (!tracks || !playlistName) {
      return res.status(400).json({ error: "Tracks and playlistName are required" });
    }
    
    // Importar la función de conversión
    const { convertWithYtMusic } = await import("../../src/ytmusic/client");
    
    // Configurar callback de progreso
    const progressCallback = (current: number, total: number, artist: string, title: string, status: string) => {
      // Enviar progreso al cliente (usando SSE)
      broadcastToAllClients({
        type: "progress",
        added: current,
        total,
        artist,
        title,
        status
      });
    };
    
    // Convertir la playlist
    const result = await convertWithYtMusic(tracks, playlistName, { dryRun, threshold }, progressCallback);

    const unmatchedTracks = result.unmatchedTracks || [];
    const ambiguousTracks = result.ambiguousTracks || [];
    const manualReviewTracks = result.manualReviewTracks || [...unmatchedTracks, ...ambiguousTracks];

    // Enviar resultado al cliente
    broadcastToAllClients({
      type: "result",
      total: tracks.length,
      matched: result.matched,
      unmatched: unmatchedTracks.length,
      ambiguous: ambiguousTracks.length,
      playlistId: result.playlistId,
      playlistUrl: result.playlistUrl,
      unmatchedTracks,
      ambiguousTracks,
      manualReviewTracks
    });
    
    return res.json({ success: true });
  } catch (err) {
    console.error("Error al convertir la playlist:", err);
    return res.status(500).json({ error: "Failed to convert playlist" });
  }
});

// Endpoint para recibir actualizaciones de progreso (SSE)
app.get("/api/convert-progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  
  const clientId = Date.now().toString();
  addClient(clientId, res);
  
  req.on("close", () => {
    removeClient(clientId);
  });
});

// Endpoint para limpiar localStorage
app.get("/clear-localstorage", (req, res) => {
  res.send(
    `<script>
      localStorage.removeItem('m3uState');
      alert('localStorage limpiado. Refresca la página.');
      window.close();
    </script>`
  );
});

// Servir index.html en la ruta raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Redirigir todas las demás solicitudes a index.html para manejar rutas del frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

console.log(`Iniciando servidor en el puerto ${PORT}...`);
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
}).on('error', (err) => {
  console.error('Error al iniciar el servidor:', err);
});