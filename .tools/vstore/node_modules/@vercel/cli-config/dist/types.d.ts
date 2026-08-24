/**
 * Pure TypeScript interface definitions for Vercel global config types.
 *
 * These interfaces serve as the source of truth for types.
 * Zod schemas are generated from these using ts-to-zod.
 */
export interface TelemetryConfig {
    enabled?: boolean;
}
export interface GuidanceConfig {
    enabled?: boolean;
}
export interface UpdatesConfig {
    auto?: boolean;
}
export type CredStorage = 'auto' | 'file' | 'keyring';
export type CredentialsStorageLocation = Exclude<CredStorage, 'auto'>;
export declare const CRED_STORAGE_CONFIG_VALUES: readonly ["auto", "file", "keyring"];
export declare const CRED_STORAGE_VALUES: ("file" | "keyring")[];
export declare const DEFAULT_CRED_STORAGE: CredentialsStorageLocation;
export interface AuthConfig {
    '// Note'?: string;
    '// Docs'?: string;
    skipWrite?: boolean;
    token?: string;
    userId?: string;
    refreshToken?: string;
    expiresAt?: number;
    tokenSource?: 'flag' | 'env';
}
export type AuthFileConfig = Omit<AuthConfig, 'tokenSource'>;
export interface GlobalConfig {
    '// Note'?: string;
    '// Docs'?: string;
    credStorage?: CredStorage;
    currentTeam?: string;
    api?: string;
    telemetry?: TelemetryConfig;
    guidance?: GuidanceConfig;
    updates?: UpdatesConfig;
    /** Opt-in to running the native Vercel CLI binary when one is installed. */
    useNativeBinary?: boolean;
}
