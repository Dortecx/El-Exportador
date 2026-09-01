import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");

describe("auth status", () => {
  it("checks persisted YouTube Music authentication asynchronously", () => {
    expect(server).toContain("checkYtMusicAvailable");
    expect(server).toContain('app.get("/api/auth-status", async (req, res) => {');
    expect(server).toContain("const authenticated = await checkYtMusicAvailable();");
    expect(server).toContain("res.json({ authenticated });");
  });

  it("clears a stale YouTube Music session cookie when authentication is unavailable", () => {
    expect(server).toContain('!authenticated && req.cookies?.ytmusic_session === "authenticated"');
    expect(server).toContain('res.clearCookie("ytmusic_session");');
  });
});
