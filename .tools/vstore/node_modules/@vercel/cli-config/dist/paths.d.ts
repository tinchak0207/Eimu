/** Canonical platform application-data directory for the Vercel CLI. */
export declare function getDataPath(): string;
export declare function getGlobalPathConfig(): string;
export declare function getConfigFilePath(configDir: string): string;
export declare function getAuthConfigFilePath(configDir: string): string;
export declare function readGlobalConfigFlag(configPath: string, key: string): unknown;
