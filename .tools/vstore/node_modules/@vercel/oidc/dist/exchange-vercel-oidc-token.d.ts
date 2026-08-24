/**
 * The options for the `exchangeVercelOidcToken` function.
 *
 * @typedef {Object} ExchangeVercelOidcTokenOptions
 * @property {string} token - The token to exchange.
 * @property {string} audience - Optional audience to set on the exchanged token.
 * @property {string} jti - Optional JTI to set on the exchanged token.
 * @property {boolean} skipCache - Optional flag to bypass the in-memory cache.
 */
export interface ExchangeVercelOidcTokenOptions {
    /**
     * The token to exchange.
     */
    token: string;
    /**
     * Optional audience to set on the exchanged token.
     * @default undefined
     */
    audience?: string;
    /**
     * Optional JTI to set on the exchanged token.
     * @default undefined
     */
    jti?: string;
    /**
     * When `true`, bypasses the in-memory exchange cache and performs a fresh
     * token exchange. The freshly exchanged token still replaces any cached entry.
     * @default false
     */
    skipCache?: boolean;
}
/**
 * Exchanges a Vercel OIDC token for a Vercel token with a custom audience.
 *
 * @param {ExchangeVercelOidcTokenOptions} options - The options for the exchange.
 * @param {string} options.token - The token to exchange.
 * @param {string} options.audience - Optional audience to set on the exchanged token.
 * @param {string} options.jti - Optional JTI to set on the exchanged token.
 * @param {boolean} options.skipCache - Optional flag to bypass the in-memory cache and force a fresh exchange.
 * @throws {Error} If the token exchange fails.
 * @returns {Promise<string>} A promise that resolves to the exchanged token.
 */
export declare function exchangeVercelOidcToken(options: ExchangeVercelOidcTokenOptions): Promise<string>;
