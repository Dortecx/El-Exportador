import os from "node:os";
import path from "node:path";
import { ENV, resolveSpotifyRedirectUri } from "../config/env";
import { SpotifyClientConfig } from "./types";

const SPOTIFY_CONFIG_DIR = path.join(".config", "m3u-to-ytmusic");
const SPOTIFY_TOKEN_FILE = "spotify_tokens.json";

export function isSpotifyRuntimeSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function resolveSpotifyStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.M3U_YTMUSIC_STATE_DIR?.trim() || os.homedir();
}

export function resolveSpotifyConfigDir(stateRoot = resolveSpotifyStateRoot()): string {
  return path.join(stateRoot, SPOTIFY_CONFIG_DIR);
}

export function resolveSpotifyTokenPath(stateRoot = resolveSpotifyStateRoot()): string {
  return path.join(resolveSpotifyConfigDir(stateRoot), SPOTIFY_TOKEN_FILE);
}

export function getSpotifyClientConfig(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  port?: number | string;
} = {}): SpotifyClientConfig {
  const env = options.env ?? process.env;
  const supported = isSpotifyRuntimeSupported(options.platform);
  const clientId = env.SPOTIFY_CLIENT_ID?.trim() || (options.env === undefined ? ENV.SPOTIFY_CLIENT_ID.trim() : "");
  const redirectUri = resolveSpotifyRedirectUri(options.port ?? env.PORT ?? ENV.PORT);

  if (!supported) {
    return { enabled: false, supported, reason: "SPOTIFY_WINDOWS_ONLY", redirectUri };
  }

  if (!clientId) {
    return { enabled: false, supported, reason: "SPOTIFY_CONFIGURATION_REQUIRED", redirectUri };
  }

  return { enabled: true, supported, reason: null, redirectUri, clientId };
}
