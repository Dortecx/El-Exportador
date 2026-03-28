import * as fs from "fs";
import * as path from "path";
import * as os from "os";
const CONFIG_DIR = ".config/m3u-to-ytmusic";
export const DEFAULT_CONFIG = {
    matchThreshold: 0.6,
    maxResults: 5,
    musicCategoryId: "10",
};
export function resolveConfigDir() {
    const home = os.homedir();
    return path.join(home, CONFIG_DIR);
}
export function resolveTokenPath(customPath) {
    return customPath ?? path.join(resolveConfigDir(), "tokens.json");
}
export function resolveCredentialsPath(customPath) {
    return customPath ?? path.join(resolveConfigDir(), "credentials.json");
}
export function loadConfig(credentialsPath) {
    const tokenPath = resolveTokenPath();
    const credPath = resolveCredentialsPath(credentialsPath);
    if (!fs.existsSync(credPath)) {
        throw new Error(`Credentials file not found: ${credPath}\n` +
            `Please set up Google Cloud OAuth2 credentials and place them at:\n` +
            `  ${credPath}\n\n` +
            `See https://developers.google.com/youtube/registering_an_application for instructions.`);
    }
    const credentials = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    if (!credentials.installed && !credentials.web) {
        throw new Error(`Invalid credentials file: ${credPath}\n` +
            `Expected 'installed' or 'web' OAuth2 client configuration.`);
    }
    return {
        ...DEFAULT_CONFIG,
        tokenPath,
        credentialsPath: credPath,
    };
}
export function ensureConfigDir() {
    const dir = resolveConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
//# sourceMappingURL=config.js.map