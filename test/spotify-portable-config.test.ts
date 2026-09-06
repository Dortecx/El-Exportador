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

  it("does not add a client-secret configuration path to the portable package", () => {
    expect(portableBuildScript).not.toContain("SPOTIFY_CLIENT_SECRET");
    expect(launcherTemplate).not.toContain("SPOTIFY_CLIENT_SECRET");
  });
});
