import { type JWTVerifyOptions, type JWTVerifyResult, type JWTPayload } from 'jose';
export type VercelOidcPayload = JWTPayload & {
    owner_id: string;
    project_id: string;
    environment: string;
    external_sub?: string;
    sub: string;
    aud: string;
    iss: string;
};
/**
 * Verifies a Vercel OIDC token against Vercel's remote JWKS.
 *
 * The issuer must be `https://oidc.vercel.com` or start with
 * `https://oidc.vercel.com/`. The JWKS is always
 * `https://oidc.vercel.com/.well-known/jwks`.
 *
 * Options:
 *
 * - `issuer`: Expected `iss` claim verified by Jose. The verified issuer must
 *   still be `https://oidc.vercel.com` or start with
 *   `https://oidc.vercel.com/`.
 * - `projectId`: Expected `project_id` claim or claims. Defaults to
 *   `process.env.VERCEL_PROJECT_ID`. Pass an array to allow any matching
 *   project ID. Pass `'*'` to allow any project ID. When `projectId` is `'*'`,
 *   either `ownerId` or `audience` is required.
 * - `environment`: Expected `environment` claim or claims. Defaults to
 *   `process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV`. Pass an array
 *   to allow any matching environment. Pass `'*'` to allow any environment.
 * - `ownerId`: Expected `owner_id` claim. When omitted, the claim is not
 *   checked.
 * - Any other Jose JWT verification option.
 *
 * @param token The Vercel OIDC token to verify.
 * @param options Optional Jose JWT verification options.
 * @returns Jose's verified JWT result.
 */
export declare function verifyVercelOidcToken<PayloadType = VercelOidcPayload>(token: string, options?: {
    projectId?: string | string[] | '*';
    environment?: string | string[] | '*';
    ownerId?: string;
} & JWTVerifyOptions): Promise<JWTVerifyResult<PayloadType>>;
