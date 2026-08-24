import { z } from "zod";

//#region src/auth/oauth.d.ts
declare const IntrospectionResponse: z.ZodUnion<[z.ZodObject<{
  active: z.ZodLiteral<true>;
  client_id: z.ZodString;
  session_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
  active: z.ZodLiteral<false>;
}, z.core.$strip>]>;
declare function OAuth(): Promise<{
  /**
   * Perform the Device Authorization Request
   *
   * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.1
   * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.2
   */
  deviceAuthorizationRequest(): Promise<DeviceAuthorizationRequest>;
  /**
   * Perform the Device Access Token Request
   *
   * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.4
   */
  deviceAccessTokenRequest(device_code: string): Promise<[Error] | [null, Response]>;
  /**
   * Process the Token request Response
   *
   * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
   */
  processTokenResponse(response: Response): Promise<[OAuthError] | [null, TokenSet]>;
  /**
   * Perform a Token Revocation Request.
   *
   * @see https://datatracker.ietf.org/doc/html/rfc7009#section-2.1
   * @see https://datatracker.ietf.org/doc/html/rfc7009#section-2.2
   */
  revokeToken(token: string): Promise<OAuthError | void>;
  /**
   * Perform Refresh Token Request.
   *
   * @see https://datatracker.ietf.org/doc/html/rfc6749#section-6
   */
  refreshToken(token: string): Promise<TokenSet>;
  /**
   * Perform Token Introspection Request.
   *
   * @see https://datatracker.ietf.org/doc/html/rfc7662#section-2.1
   */
  introspectToken(token: string): Promise<z.infer<typeof IntrospectionResponse>>;
}>;
type OAuth = Awaited<ReturnType<typeof OAuth>>;
declare const TokenSet: z.ZodObject<{
  access_token: z.ZodString;
  token_type: z.ZodLiteral<"Bearer">;
  expires_in: z.ZodNumber;
  refresh_token: z.ZodOptional<z.ZodString>;
  scope: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type TokenSet = z.infer<typeof TokenSet>;
declare const OAuthErrorResponse: z.ZodObject<{
  error: z.ZodEnum<{
    invalid_request: "invalid_request";
    invalid_client: "invalid_client";
    invalid_grant: "invalid_grant";
    unauthorized_client: "unauthorized_client";
    unsupported_grant_type: "unsupported_grant_type";
    invalid_scope: "invalid_scope";
    server_error: "server_error";
    authorization_pending: "authorization_pending";
    slow_down: "slow_down";
    access_denied: "access_denied";
    expired_token: "expired_token";
    unsupported_token_type: "unsupported_token_type";
  }>;
  error_description: z.ZodOptional<z.ZodString>;
  error_uri: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type OAuthErrorResponse = z.infer<typeof OAuthErrorResponse>;
declare class OAuthError extends Error {
  name: string;
  code: OAuthErrorResponse["error"];
  cause: Error;
  constructor(message: string, response: unknown);
}
declare function isOAuthError(error: unknown): error is OAuthError;
interface DeviceAuthorizationRequest {
  /** The device verification code. */
  device_code: string;
  /** The end-user verification code. */
  user_code: string;
  /**
   * The minimum amount of time in seconds that the client
   * SHOULD wait between polling requests to the token endpoint.
   */
  interval: number;
  /** The end-user verification URI on the authorization server. */
  verification_uri: string;
  /**
   * The end-user verification URI on the authorization server,
   * including the `user_code`, without redirection.
   */
  verification_uri_complete: string;
  /**
   * The absolute lifetime of the `device_code` and `user_code`.
   * Calculated from `expires_in`.
   */
  expiresAt: number;
}
//#endregion
export { DeviceAuthorizationRequest, OAuth, isOAuthError };
//# sourceMappingURL=oauth.d.cts.map