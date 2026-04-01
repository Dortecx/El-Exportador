import { google } from "googleapis";
import * as fs from "fs";
import { ensureConfigDir, resolveTokenPath, resolveCredentialsPath } from "./config.js";
export async function loadCredentials() {
    const credPath = resolveCredentialsPath();
    if (!fs.existsSync(credPath)) {
        throw new Error(`Credentials file not found: ${credPath}\n` +
            `Please create a Google Cloud OAuth2 client:\n` +
            `1. Go to https://console.cloud.google.com/apis/credentials\n` +
            `2. Create OAuth client ID (Desktop app)\n` +
            `3. Download the JSON and save as:\n` +
            `   ${credPath}`);
    }
    try {
        const content = JSON.parse(fs.readFileSync(credPath, "utf-8"));
        return content;
    }
    catch {
        throw new Error(`Failed to parse credentials file: ${credPath}`);
    }
}
export async function getAuthClient(credentialsPath) {
    const credentials = await loadCredentials();
    const clientConfig = credentials.installed ||
        credentials.web;
    if (!clientConfig) {
        throw new Error("Invalid credentials: missing 'installed' or 'web' configuration");
    }
    const auth = new google.auth.OAuth2(clientConfig.client_id, clientConfig.client_secret, "http://localhost:8080");
    const tokenPath = resolveTokenPath(credentialsPath);
    if (fs.existsSync(tokenPath)) {
        try {
            const tokenData = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
            auth.setCredentials(tokenData);
            if (tokenData.expiry_date && Date.now() < tokenData.expiry_date - 60000) {
                return auth;
            }
            if (tokenData.refresh_token) {
                try {
                    const { credentials } = await auth.refreshAccessToken();
                    auth.setCredentials(credentials);
                    await saveToken(auth, tokenPath);
                    return auth;
                }
                catch {
                    console.warn("Token refresh failed, will try with existing token");
                }
            }
        }
        catch {
            console.warn("Failed to load existing token, will attempt full auth");
        }
    }
    await authenticate(auth, tokenPath);
    return auth;
}
const SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
];
async function authenticate(auth, tokenPath) {
    const authUrl = auth.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    });
    console.log("\n=== YouTube Music Authentication Required ===\n");
    console.log("Please visit this URL to authorize:");
    console.log(`\n${authUrl}\n`);
    console.log("After authorizing, the code will be received automatically.\n");
    const readline = await import("readline");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const code = await new Promise((resolve) => {
        rl.question("Enter the authorization code: ", (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    await saveToken(auth, tokenPath);
    console.log("\nAuthentication successful! Token saved.\n");
}
async function saveToken(auth, tokenPath) {
    ensureConfigDir();
    const token = auth.credentials;
    fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));
}
export async function validateAuth(auth) {
    try {
        const token = auth.credentials;
        if (!token.access_token) {
            return false;
        }
        if (token.expiry_date && Date.now() >= token.expiry_date) {
            if (token.refresh_token) {
                try {
                    const { credentials } = await auth.refreshAccessToken();
                    auth.setCredentials(credentials);
                    const tokenPath = resolveTokenPath();
                    await saveToken(auth, tokenPath);
                    return true;
                }
                catch {
                    return false;
                }
            }
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=auth.js.map