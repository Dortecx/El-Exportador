import fs from "node:fs";
import path from "node:path";
import { resolveSpotifyTokenPath } from "./config";
import { SpotifyProfile, SpotifyTokenState } from "./types";

function isProfile(value: unknown): value is SpotifyProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && (!("displayName" in candidate) || typeof candidate.displayName === "string");
}

function isSpotifyTokenState(value: unknown): value is SpotifyTokenState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.accessToken === "string"
    && typeof candidate.refreshToken === "string"
    && typeof candidate.scope === "string"
    && typeof candidate.tokenType === "string"
    && Number.isFinite(candidate.expiresAtEpochMs)
    && (!("profile" in candidate) || isProfile(candidate.profile));
}

export function resolveSpotifyTokenStatePath(stateRoot?: string): string {
  return resolveSpotifyTokenPath(stateRoot);
}

export function readSpotifyTokenState(tokenPath = resolveSpotifyTokenStatePath()): SpotifyTokenState | null {
  if (!fs.existsSync(tokenPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as unknown;
    return isSpotifyTokenState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSpotifyTokenState(tokenState: SpotifyTokenState, tokenPath = resolveSpotifyTokenStatePath()): void {
  const directory = path.dirname(tokenPath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(directory, `${path.basename(tokenPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(tokenState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, tokenPath);
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch {
      // Ignore chmod failures on unsupported filesystems.
    }
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function deleteSpotifyTokenState(tokenPath = resolveSpotifyTokenStatePath()): void {
  if (fs.existsSync(tokenPath)) fs.rmSync(tokenPath, { force: true });
}
