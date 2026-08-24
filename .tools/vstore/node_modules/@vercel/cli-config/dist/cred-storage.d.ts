import type { AuthConfig, CredStorage } from './types';
export declare function authConfigHasUsableTokenData(value: unknown): value is Pick<AuthConfig, 'token' | 'refreshToken'>;
export declare function getLikelyEffectiveCredStorage(configDir: string): CredStorage;
