import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const portableBuildScript = readFileSync(new URL("../scripts/build-portable-win.ps1", import.meta.url), "utf8");
const launcherTemplate = readFileSync(new URL("../scripts/start.cmd.template", import.meta.url), "utf8");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function runtimeSourceAllowlist(): string[] {
  const match = portableBuildScript.match(/\$runtimeSources = @\(\n(?<body>[\s\S]*?)\n\s*\)/);
  if (!match?.groups?.body) throw new Error("Runtime source allowlist not found");
  return Array.from(match.groups.body.matchAll(/"([^"]+)"/g), ([, source]) => source);
}

describe("Portable release configuration", () => {
  it("keeps Spotify unavailable for the public portable build without requiring a build-time OAuth client", () => {
    expect(portableBuildScript).not.toMatch(/\[string\]\$SpotifyClientId/);
    expect(portableBuildScript).not.toContain("$env:SPOTIFY_CLIENT_ID");
    expect(portableBuildScript).not.toContain("Spotify-enabled portable build requires a public Spotify Client ID");
    expect(portableBuildScript).toContain(`Spotify is intentionally unavailable in the v${packageVersion} public portable release.`);
    expect(portableBuildScript).toContain('$spotifyClientIdBase64 = ""');
    expect(portableBuildScript).toContain('Replace("@@SPOTIFY_CLIENT_ID_BASE64@@", $spotifyClientIdBase64)');
    expect(launcherTemplate).not.toContain('echo %SPOTIFY_CLIENT_ID%');
    expect(launcherTemplate).not.toContain('echo %SPOTIFY_CLIENT_ID_B64%');
  });

  it("stages the portable runtime under a single archive root with app, launcher, and artifacts", () => {
    expect(portableBuildScript).toContain('$releaseName = "El-Exportador-$($package.version)-windows"');
    expect(portableBuildScript).toContain('$releaseRoot = Join-Path $stageRoot $releaseName');
    expect(portableBuildScript).toContain('$appRoot = Join-Path $releaseRoot "app"');
    expect(portableBuildScript).toContain('New-Item -ItemType Directory -Path (Join-Path $releaseRoot "artifacts") -Force');
    expect(portableBuildScript).toContain('Join-Path $releaseRoot "artifacts\\searcher.exe"');
    expect(portableBuildScript).toContain('Join-Path $releaseRoot "start.cmd"');
    expect(portableBuildScript).toContain('Compress-Archive -Path $releaseRoot -DestinationPath $zipPath');
    expect(portableBuildScript).toContain('$to = Join-Path $appRoot $source');
  });

  it("statically packages the Python YouTube searcher beside the TypeScript client without broadening runtime sources", () => {
    expect(runtimeSourceAllowlist()).toEqual([
      "src\\web\\server.ts",
      "src\\web\\guidedBrowserAuth.ts",
      "src\\config\\env.ts",
      "src\\spotify\\config.ts",
      "src\\spotify\\tokenStore.ts",
      "src\\spotify\\types.ts",
      "src\\spotify\\oauth.ts",
      "src\\spotify\\api.ts",
      "src\\spotify\\converter.ts",
      "src\\spotify\\matcher.ts",
      "src\\ytmusic\\client.ts",
      "src\\ytmusic\\searcher.py",
      "src\\parser.ts",
      "src\\services\\session.service.ts",
    ]);
    expect(portableBuildScript).toContain('Join-Path $projectRoot "src\\ytmusic\\searcher.py"');
    expect(portableBuildScript).toContain('$to = Join-Path $appRoot $source');
  });

  it("packages every statically imported Spotify runtime module without a client-secret path", () => {
    for (const module of ["api.ts", "config.ts", "converter.ts", "matcher.ts", "oauth.ts", "tokenStore.ts", "types.ts"]) {
      expect(portableBuildScript).toContain(`src\\spotify\\${module}`);
    }
    // src/spotify/config.ts directly imports ../config/env, so the portable allowlist
    // must stage that module and create its destination parent before copying it.
    expect(portableBuildScript).toContain("src\\config\\env.ts");
    expect(portableBuildScript).toContain("New-Item -ItemType Directory -Path $toParent -Force");
    expect(portableBuildScript).not.toContain("SPOTIFY_CLIENT_SECRET");
    expect(launcherTemplate).not.toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("fails safely when the fixed Spotify loopback port is occupied without printing environment values", () => {
    expect(launcherTemplate).toContain('set "PORT=3000"');
    expect(launcherTemplate).toContain('netstat -ano -p tcp | findstr /r /c:":%PORT% .*LISTENING" >nul');
    expect(launcherTemplate).toContain('echo [ERROR] Port %PORT% is already in use. Close the other local process, then run start.cmd again.');
    expect(launcherTemplate).toContain('exit /b 1');
    expect(launcherTemplate).not.toContain('echo %SPOTIFY_CLIENT_ID%');
    expect(launcherTemplate).not.toContain('echo %SPOTIFY_CLIENT_ID_B64%');
  });

  it("documents the authorized YouTube-only temporary Spotify-unavailable policy in both public READMEs", () => {
    const english = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const spanish = readFileSync(new URL("../README.es.md", import.meta.url), "utf8");
    expect(english).toContain("converts `.m3u` playlists into YouTube Music playlists");
    expect(english).toContain("Spotify is temporarily unavailable in this release");
    expect(english).toContain("only shows YouTube Music as the destination");
    expect(english).toContain("Dry Run Mode");
    expect(english).toContain("manually");
    expect(english).not.toContain("YouTube Music or Spotify");
    expect(english).not.toContain("directly with Spotify OAuth using PKCE");
    expect(english).not.toContain("private playlists");
    expect(spanish).toContain("convierte listas de reproducción `.m3u` en listas de YouTube Music");
    expect(spanish).toContain("Spotify no está disponible temporalmente en esta versión");
    expect(spanish).toContain("solo muestra YouTube Music como destino");
    expect(spanish).toContain("Modo de prueba");
    expect(spanish).toContain("manualmente");
    expect(spanish).not.toContain("YouTube Music o Spotify");
    expect(spanish).not.toContain("directamente con OAuth de Spotify mediante PKCE");
    expect(spanish).not.toContain("listas privadas");
  });
});
