"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = void 0;
exports.resolveConfigDir = resolveConfigDir;
exports.resolveTokenPath = resolveTokenPath;
exports.resolveCredentialsPath = resolveCredentialsPath;
exports.loadConfig = loadConfig;
exports.ensureConfigDir = ensureConfigDir;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const CONFIG_DIR = ".config/m3u-to-ytmusic";
exports.DEFAULT_CONFIG = {
    matchThreshold: 0.6,
    maxResults: 5,
    musicCategoryId: "10",
};
function resolveConfigDir() {
    const home = os.homedir();
    return path.join(home, CONFIG_DIR);
}
function resolveTokenPath(customPath) {
    return customPath ?? path.join(resolveConfigDir(), "tokens.json");
}
function resolveCredentialsPath(customPath) {
    return customPath ?? path.join(resolveConfigDir(), "credentials.json");
}
function loadConfig(credentialsPath) {
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
        ...exports.DEFAULT_CONFIG,
        tokenPath,
        credentialsPath: credPath,
    };
}
function ensureConfigDir() {
    const dir = resolveConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
//# sourceMappingURL=config.js.map