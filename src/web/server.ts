import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
// @ts-ignore: __dirname is available in CommonJS
const __dirname = path.resolve();

// SSE setup
const clients = new Set();

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

function broadcastToAllClients(event: { type: string; data?: any }) {
  clients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error('Error broadcasting to client:', err);
    }
  });
}

const app = express();
const YTMusicAuthFile = path.join(os.homedir(), '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json');
const PORT = 3000;

// Configurar CORS para permitir comunicación entre popup y página principal
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
const publicDir = "/mnt/c/Users/Dom/Documents/Projects/El Exportador/m3u-to-ytmusic/public";
app.use(express.static(publicDir));

// Importar módulos
import { handleAuthRequest } from "./authHandler";
import { validateAuth } from "../../src/auth";
import jwt from 'jsonwebtoken';
import { getAuthClient, saveToken } from "../../src/auth";

// Endpoint para verificar el estado de autenticación
app.get("/api/auth-status", async (req, res) => {
  console.log("=== SOLICITUD A /api/auth-status ==="); // Depuración
  try {
    console.log("=== VERIFICANDO ESTADO DE AUTENTICACIÓN ==="); // Depuración
    const auth = await getAuthClient(undefined, true); // isBrowser = true
    const isAuthenticated = await validateAuth(auth);
    console.log("=== ESTADO DE AUTENTICACIÓN ===", isAuthenticated); // Depuración
    res.json({ authenticated: isAuthenticated });
  } catch (err) {
    console.error("Error al verificar estado de autenticación:", err);
    res.status(500).json({ authenticated: false });
  }
});

// Endpoint para validar tokens JWT
app.post("/auth/validate", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-secret");
    res.cookie("authToken", token, { httpOnly: true, secure: true });
    res.json({ valid: true, decoded });
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
});
  console.log("=== SOLICITUD A /api/auth-status ==="); // Depuración
  try {
    console.log("=== VERIFICANDO ESTADO DE AUTENTICACIÓN ==="); // Depuración
    const auth = await getAuthClient(undefined, true); // isBrowser = true
    const isAuthenticated = await validateAuth(auth);
    console.log("=== ESTADO DE AUTENTICACIÓN ===", isAuthenticated); // Depuración
    res.json({ authenticated: isAuthenticated });
  } catch (err) {
    console.error("Error al verificar estado de autenticación:", err);
    res.status(500).json({ authenticated: false });
  }
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

// Endpoint para autenticación
app.get("/auth", (req, res) => {
  console.log("=== ACCEDIENDO A /auth ==="); // Depuración
  handleAuthRequest(req, res);
});

// Redirigir todas las solicitudes a index.html para manejar rutas del frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Endpoint para manejar el callback de OAuth
app.get("/auth/callback", async (req, res) => {
  console.log("=== SOLICITUD A /auth/callback ===", req.query); // Depuración
  const { code } = req.query;
  if (!code) {
    console.error("=== CÓDIGO DE AUTORIZACIÓN NO PROPORCIONADO ==="); // Depuración
    return res.status(400).send("Authorization code not provided");
  }
  console.log("=== CÓDIGO DE AUTORIZACIÓN ===", code); // Depuración

  try {
    const auth = await getAuthClient();
    const { tokens } = await auth.getToken(code as string);
    console.log("=== TOKENS OBTENIDOS ===", tokens); // Depuración
    auth.setCredentials(tokens);
    await saveToken(auth, YTMusicAuthFile);
    console.log("=== TOKEN GUARDADO EN ===", YTMusicAuthFile); // Depuración
    
    // Verificar que el token se guardó correctamente
    if (fs.existsSync(YTMusicAuthFile)) {
      const tokenData = JSON.parse(fs.readFileSync(YTMusicAuthFile, "utf-8"));
      console.log("=== TOKEN GUARDADO ===", tokenData); // Depuración
    } else {
      console.error("=== ERROR: EL TOKEN NO SE GUARDÓ ==="); // Depuración
    }

    // Notificar a todos los clientes que la autenticación fue exitosa
    broadcastToAllClients({ type: 'auth_success' });

    // Cerrar el popup y notificar a la página principal
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Autenticación exitosa</title>
          <script>
            if (window.opener) {
              window.opener.postMessage('auth_success', '*');
              window.close();
            } else {
              window.location.href = 'http://localhost:3000';
            }
          </script>
        </head>
        <body>
          <p>Autenticación exitosa. Redirigiendo...</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error al procesar la autenticación:", err);
    res.status(500).send("Error al procesar la autenticación");
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = addClient(res);
  webLogger.info("==== M3U to YouTube Music ====");
  webLogger.info(`Playlist: "${playlistName}"`);
  webLogger.info(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  webLogger.info(`Tracks: ${tracks.length}`);

  // Verificar si hay autenticación
  if (!checkYtMusicAvailable()) {
    webLogger.error("❌ YouTube Music no está configurado. Ve a http://localhost:3000/auth para autenticarte.");
  }

  req.on("close", () => {
    removeClient(clientId);
    res.end();
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

// Endpoint para verificar estado de autenticación
app.get("/api/auth-status", (req, res): void => {
  res.json({ authenticated: checkYtMusicAvailable() });
});

app.post("/api/search-single", async (req, res): Promise<void> => {
  try {
    const { query } = req.body;
    const result = await searchSingleOnYtMusic(query);
    res.json(result);
  } catch (error) {
    console.error("Error in search-single:", error);
    res.status(500).json({ error: "Internal server error" });
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
  console.log(`🌐 También accesible desde: http://<TU_IP_LOCAL>:${PORT}`);
  console.log(`Auth file path: ${YTMusicAuthFile}`);
  console.log(`🎵 ytmusicapi backend: Estado no verificado (ve a http://localhost:${PORT} para configurarlo)`);
}).on('error', (err) => {
  console.error('❌ Error al iniciar el servidor:', err);
});

// Evitar que el servidor se cierre automáticamente
process.on('SIGINT', () => {
  console.log('\n🛑 Servidor detenido manualmente');
  server.close();
  process.exit(0);
});

// Mantener el servidor corriendo
setInterval(() => {
  console.log('⏳ Servidor en ejecución...');
}, 60000);
