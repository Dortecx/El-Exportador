import { AppConfig } from "./types.js";
export declare const DEFAULT_CONFIG: Omit<AppConfig, "tokenPath" | "credentialsPath">;
export declare function resolveConfigDir(): string;
export declare function resolveTokenPath(customPath?: string): string;
export declare function resolveCredentialsPath(customPath?: string): string;
export declare function loadConfig(credentialsPath?: string): AppConfig;
export declare function ensureConfigDir(): void;
//# sourceMappingURL=config.d.ts.map