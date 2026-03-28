import { describe, it, expect } from "vitest";

describe("Config", () => {
  describe("DEFAULT_CONFIG", () => {
    it("should have correct default values", async () => {
      const { DEFAULT_CONFIG } = await import("../src/config.js");

      expect(DEFAULT_CONFIG.matchThreshold).toBe(0.6);
      expect(DEFAULT_CONFIG.maxResults).toBe(5);
      expect(DEFAULT_CONFIG.musicCategoryId).toBe("10");
    });
  });

  describe("resolveConfigDir", () => {
    it("should resolve to homedir/.config/m3u-to-ytmusic", async () => {
      const { resolveConfigDir } = await import("../src/config.js");
      const configDir = resolveConfigDir();
      expect(configDir).toContain(".config");
      expect(configDir).toContain("m3u-to-ytmusic");
    });
  });

  describe("resolveTokenPath", () => {
    it("should include tokens.json in path", async () => {
      const { resolveTokenPath } = await import("../src/config.js");
      const tokenPath = resolveTokenPath();
      expect(tokenPath).toContain("tokens.json");
    });

    it("should use custom path when provided", async () => {
      const { resolveTokenPath } = await import("../src/config.js");
      const customPath = "/custom/path/tokens.json";
      const tokenPath = resolveTokenPath(customPath);
      expect(tokenPath).toBe(customPath);
    });
  });

  describe("resolveCredentialsPath", () => {
    it("should include credentials.json in path", async () => {
      const { resolveCredentialsPath } = await import("../src/config.js");
      const credPath = resolveCredentialsPath();
      expect(credPath).toContain("credentials.json");
    });

    it("should use custom path when provided", async () => {
      const { resolveCredentialsPath } = await import("../src/config.js");
      const customPath = "/custom/path/creds.json";
      const credPath = resolveCredentialsPath(customPath);
      expect(credPath).toBe(customPath);
    });
  });
});
