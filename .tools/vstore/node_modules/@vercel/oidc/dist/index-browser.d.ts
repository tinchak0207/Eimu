export { getContext } from './get-context';
export { verifyVercelOidcToken, type VercelOidcPayload, } from './verify-vercel-oidc-token';
export { AccessTokenMissingError, RefreshAccessTokenFailedError, } from './auth-errors';
export declare function getVercelOidcToken(): Promise<string>;
export declare function getVercelOidcTokenSync(): string;
export declare function getVercelToken(): Promise<string>;
