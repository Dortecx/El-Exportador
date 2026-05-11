"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// @ts-ignore: __dirname is available in CommonJS
const __dirname = path_1.default.resolve();
// SSE setup
const clients = new Set();
function addClient(clientId, res) {
    clients.add({ id: clientId, res });
}
function removeClient(clientId) {
    clients.forEach(client => {
        if (client.id === clientId) {
            clients.delete(client);
        }
    });
}
function broadcastToAllClients(event) {
    clients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch (err) {
            console.error('Error broadcasting to client:', err);
        }
    });
}
const app = (0, express_1.default)();
const YTMusicAuthFile = path_1.default.join(os_1.default.homedir(), '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json');
const PORT = 3000;
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
const publicDir = "/mnt/c/Users/Dom/Documents/Projects/El Exportador/m3u-to-ytmusic/public";
app.use(express_1.default.static(publicDir));
// Redirigir todas las solicitudes a index.html para manejar rutas del frontend
app.get('*', (req, res) => {
    res.sendFile(path_1.default.join(publicDir, "index.html"));
});
// Endpoint para autenticación
app.get("/auth", (req, res) => {
    const clientId = "933030841499-59bpa47rcko13nml9ndr748p62mj1sl7.apps.googleusercontent.com";
    const redirectUri = `http://localhost:3000/auth/callback`;
    const scope = "https://www.googleapis.com/auth/youtube";
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline`;
    // Servir una página intermedia que redirija a YouTube Music
    res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Autenticación con YouTube Music</title>
        <script>
          window.location.href = '${authUrl}';
          
          // Cerrar el popup después de 5 segundos si no se redirige
          setTimeout(() => {
            window.close();
          }, 5000);
        </script>
      </head>
      <body>
        <p>Redirigiendo a YouTube Music para autenticación...</p>
      </body>
    </html>
  `);
});
// Endpoint para manejar el callback de OAuth
app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send("Error: No se recibió el código de autorización");
    }
    try {
        // Cargar credenciales de Google OAuth
        const credentials = await loadCredentials();
        const clientConfig = credentials.installed ||
            credentials.web;
        if (!clientConfig) {
            throw new Error("Invalid credentials: missing 'installed' or 'web' configuration");
        }
        const auth = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret, "http://localhost:3000/auth/callback");
        // Intercambiar el código por un token
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        // Guardar el token completo
        const authFilePath = path_1.default.join(os_1.default.homedir(), '.config', 'm3u-to-ytmusic', 'ytmusic_auth.json');
        const authDir = path_1.default.dirname(authFilePath);
        if (!fs_1.default.existsSync(authDir)) {
            fs_1.default.mkdirSync(authDir, { recursive: true });
        }
        fs_1.default.writeFileSync(authFilePath, JSON.stringify(tokens));
        webLogger.success("✅ Autenticación exitosa con YouTube Music");
        // Notificar a todos los clientes que la autenticación fue exitosa
        broadcastToAllClients({ type: 'auth_success' });
        // Cerrar el popup después de guardar el token
        res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Autenticación exitosa</title>
          <script>
            window.opener?.postMessage('auth_success', '*');
            window.close();
          </script>
        </head>
        <body>
          <p>Autenticación exitosa. Cerrando...</p>
        </body>
      </html>
    `);
    }
    catch (err) {
        webLogger.error("❌ Error al procesar la autenticación:", err);
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
app.post("/api/convert", async (req, res) => {
    const { playlistName, dryRun, threshold: _threshold, tracks } = req.body;
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
        const progressCallback = (current, total, artist, title, status) => {
            console.log(`[PROGRESS-DEBUG] server.ts: progressCallback invoked with current=${current}, total=${total}, artist=${artist}, title=${title}, status=${status}`);
            webLogger.progress(current, total, `${artist} - ${title} [${status}]`);
        };
        const result = await convertWithYtMusic(tracks, playlistName, { dryRun }, progressCallback);
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
        const tempPath = path_1.default.join(os_1.default.tmpdir(), `upload_${Date.now()}.m3u`);
        const fs = await Promise.resolve().then(() => __importStar(require("fs")));
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
    const fs = await Promise.resolve().then(() => __importStar(require("fs")));
    const configDir = path_1.default.dirname(YTMusicAuthFile);
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
app.get("/api/auth-status", (req, res) => {
    res.json({ authenticated: checkYtMusicAvailable() });
});
app.post("/api/search-single", async (req, res) => {
    try {
        const { query } = req.body;
        const result = await searchSingleOnYtMusic(query);
        res.json(result);
    }
    catch (error) {
        console.error("Error in search-single:", error);
        res.status(500).json({ error: "Internal server error" });
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
        const result = await addToPlaylistOnYtMusic(playlistId, videoIds);
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
        if (fs_1.default.existsSync(YTMusicAuthFile)) {
            const content = fs_1.default.readFileSync(YTMusicAuthFile, "utf8");
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
    console.log(`🎵 ytmusicapi backend: ${checkYtMusicAvailable() ? "Available" : "Not configured (ve a http://localhost:${PORT} para configurarlo)"}`);
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
//# sourceMappingURL=server.js.map