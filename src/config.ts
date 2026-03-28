import { AppConfig } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = ".config/m3u-to-ytmusic";

export const DEFAULT_CONFIG: Omit<AppConfig, "tokenPath" | "credentialsPath"> = {
  matchThreshold: 0.6,
  maxResults: 5,
  musicCategoryId: "10",
};

export function resolveConfigDir(): string {
  const home = os.homedir();
  return path.join(home, CONFIG_DIR);
}

export function resolveTokenPath(customPath?: string): string {
  return customPath ?? path.join(resolveConfigDir(), "tokens.json");
}

export function resolveCredentialsPath(customPath?: string): string {
  return customPath ?? path.join(resolveConfigDir(), "credentials.json");
}

export function loadConfig(credentialsPath?: string): AppConfig {
  const tokenPath = resolveTokenPath();
  const credPath = resolveCredentialsPath(credentialsPath);

  if (!fs.existsSync(credPath)) {
    throw new Error(
      `Credentials file not found: ${credPath}\n` +
        `Please set up Google Cloud OAuth2 credentials and place them at:\n` +
        `  ${credPath}\n\n` +
        `See https://developers.google.com/youtube/registering_an_application for instructions.`
    );
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, "utf-8"));

  if (!credentials.installed && !credentials.web) {
    throw new Error(
      `Invalid credentials file: ${credPath}\n` +
        `Expected 'installed' or 'web' OAuth2 client configuration.`
    );
  }

  return {
    ...DEFAULT_CONFIG,
    tokenPath,
    credentialsPath: credPath,
  };
}

export function ensureConfigDir(): void {
  const dir = resolveConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
