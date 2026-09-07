import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const portableBuildScript = readFileSync(new URL("../scripts/build-portable-win.ps1", import.meta.url), "utf8");
const launcherTemplate = readFileSync(new URL("../scripts/start.cmd.template", import.meta.url), "utf8");

describe("Spotify portable configuration", () => {
  it("accepts a public client ID from an explicit build parameter or environment and rejects a missing value", () => {
    expect(portableBuildScript).toMatch(/\[string\]\$SpotifyClientId/);
    expect(portableBuildScript).toContain("$env:SPOTIFY_CLIENT_ID");
    expect(portableBuildScript).toContain("Spotify-enabled portable build requires a public Spotify Client ID");
  });

  it("encodes the build-time public ID before inserting it into the launcher and exposes it to Node at runtime", () => {
    expect(portableBuildScript).toContain("[Convert]::ToBase64String");
    expect(portableBuildScript).toContain('Replace("@@SPOTIFY_CLIENT_ID_BASE64@@", $spotifyClientIdBase64)');
    expect(launcherTemplate).toContain('set "SPOTIFY_CLIENT_ID_B64=@@SPOTIFY_CLIENT_ID_BASE64@@"');
    expect(launcherTemplate).toContain('set "SPOTIFY_CLIENT_ID=%%I"');
    expect(launcherTemplate).toContain('set "SPOTIFY_CLIENT_ID_B64="');
  });

  it("packages every statically imported Spotify runtime module without a client-secret path", () => {
    for (const module of ["api.ts", "config.ts", "converter.ts", "matcher.ts", "oauth.ts", "tokenStore.ts", "types.ts"]) {
      expect(portableBuildScript).toContain(`src\\spotify\\${module}`);
    }
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

  it("documents direct Spotify OAuth, private playlists, and dry-run manual review in both public READMEs", () => {
    const english = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const spanish = readFileSync(new URL("../README.es.md", import.meta.url), "utf8");
    expect(english).toContain("YouTube Music or Spotify");
    expect(english).toContain("directly with Spotify OAuth using PKCE");
    expect(english).toContain("private playlists");
    expect(english).toContain("Dry Run Mode");
    expect(english).toContain("manually");
    expect(spanish).toContain("YouTube Music o Spotify");
    expect(spanish).toContain("directamente con OAuth de Spotify mediante PKCE");
    expect(spanish).toContain("listas privadas");
    expect(spanish).toContain("Modo de prueba");
    expect(spanish).toContain("manualmente");
  });
});
