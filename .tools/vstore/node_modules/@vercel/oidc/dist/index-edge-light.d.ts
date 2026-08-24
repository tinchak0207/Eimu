import { ExchangeVercelOidcTokenOptions } from './exchange-vercel-oidc-token';
export { getContext } from './get-context';
export { verifyVercelOidcToken, type VercelOidcPayload, } from './verify-vercel-oidc-token';
export { AccessTokenMissingError, RefreshAccessTokenFailedError, } from './auth-errors';
export { getVercelOidcTokenSync } from './get-vercel-oidc-token-sync';
export { exchangeVercelOidcToken, type ExchangeVercelOidcTokenOptions, } from './exchange-vercel-oidc-token';
/**
 * Gets the current OIDC token in Edge Runtime.
 *
 * Edge Runtime does not support automatic token refresh, so this returns the
 * request-scoped token without checking expiration.
 */
export declare function getVercelOidcToken(options?: ExchangeVercelOidcTokenOptions): Promise<string>;
export declare function getVercelToken(): Promise<string>;
