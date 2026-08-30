import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { parseFile } from "../parser";
import { SessionService } from "../services/session.service";
import { configureYtMusicBrowserAuth, searchSingleOnYtMusic } from "../ytmusic/client";
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

app.post("/api/search-single", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const artist = typeof req.body?.artist === "string" ? req.body.artist.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!query) {
    return res.status(400).json({ error: "A search query is required" });
  }

  try {
    const result = await searchSingleOnYtMusic(query, artist, title);
    if (result.error) {
      return res.status(502).json({ error: "YouTube Music search failed" });
    }
    return res.json({ results: result.results || [] });
  } catch (error) {
    console.error("Manual YouTube Music search failed:", error);
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