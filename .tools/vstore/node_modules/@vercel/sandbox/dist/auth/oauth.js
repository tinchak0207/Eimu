import { VERSION } from "../version.js";
import { z } from "zod";
import os from "os";

//#region src/auth/oauth.ts
const USER_AGENT = `${os.hostname()} @ vercel/sandbox/${VERSION} node-${process.version} ${os.platform()} (${os.arch()})`;
const ISSUER = new URL("https://vercel.com");
const CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
const AuthorizationServerMetadata = z.object({
	issuer: z.string().url(),
	device_authorization_endpoint: z.string().url(),
	token_endpoint: z.string().url(),
	revocation_endpoint: z.string().url(),
	jwks_uri: z.string().url(),
	introspection_endpoint: z.string().url()
});
let _as;
const DeviceAuthorization = z.object({
	device_code: z.string(),
	user_code: z.string(),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url(),
	expires_in: z.number(),
	interval: z.number()
});
const IntrospectionResponse = z.object({
	active: z.literal(true),
	client_id: z.string(),
	session_id: z.string()
}).or(z.object({ active: z.literal(false) }));
/**
* Returns the Authorization Server Metadata
*
* @see https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationRequest
* @see https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationResponse
*/
async function authorizationServerMetadata() {
	if (_as) return _as;
	const response = await fetch(new URL(".well-known/openid-configuration", ISSUER), { headers: {
		"Content-Type": "application/json",
		"user-agent": USER_AGENT
	} });
	_as = AuthorizationServerMetadata.parse(await response.json());
	return _as;
}
async function OAuth() {
	const as = await authorizationServerMetadata();
	return {
		async deviceAuthorizationRequest() {
			const json = await (await fetch(as.device_authorization_endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"user-agent": USER_AGENT
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					scope: "openid offline_access"
				})
			})).json();
			const parsed = DeviceAuthorization.safeParse(json);
			if (!parsed.success) throw new OAuthError("Failed to parse device authorization response from the Vercel authorization server.", json);
			return {
				device_code: parsed.data.device_code,
				user_code: parsed.data.user_code,
				verification_uri: parsed.data.verification_uri,
				verification_uri_complete: parsed.data.verification_uri_complete,
				expiresAt: Date.now() + parsed.data.expires_in * 1e3,
				interval: parsed.data.interval
			};
		},
		async deviceAccessTokenRequest(device_code) {
			try {
				return [null, await fetch(as.token_endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						"user-agent": USER_AGENT
					},
					body: new URLSearchParams({
						client_id: CLIENT_ID,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code
					}),
					signal: AbortSignal.timeout(10 * 1e3)
				})];
			} catch (error) {
				if (error instanceof Error) return [error];
				return [new Error("An unknown error occurred. See the logs for details.", { cause: error })];
			}
		},
		async processTokenResponse(response) {
			const json = await response.json();
			const processed = TokenSet.safeParse(json);
			if (!processed.success) return [new OAuthError("Failed to parse token response from the Vercel authorization server.", json)];
			return [null, processed.data];
		},
		async revokeToken(token) {
			const response = await fetch(as.revocation_endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"user-agent": USER_AGENT
				},
				body: new URLSearchParams({
					token,
					client_id: CLIENT_ID
				})
			});
			if (response.ok) return;
			return new OAuthError("Revocation request failed", await response.json());
		},
		async refreshToken(token) {
			const response = await fetch(as.token_endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"user-agent": USER_AGENT
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: token
				})
			});
			const [tokensError, tokenSet] = await this.processTokenResponse(response);
			if (tokensError) throw tokensError;
			return tokenSet;
		},
		async introspectToken(token) {
			const json = await (await fetch(as.introspection_endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"user-agent": USER_AGENT
				},
				body: new URLSearchParams({ token })
			})).json();
			const processed = IntrospectionResponse.safeParse(json);
			if (!processed.success) throw new OAuthError("Failed to parse introspection response from the Vercel authorization server.", json);
			return processed.data;
		}
	};
}
const TokenSet = z.object({
	access_token: z.string(),
	token_type: z.literal("Bearer"),
	expires_in: z.number(),
	refresh_token: z.string().optional(),
	scope: z.string().optional()
});
const OAuthErrorResponse = z.object({
	error: z.enum([
		"invalid_request",
		"invalid_client",
		"invalid_grant",
		"unauthorized_client",
		"unsupported_grant_type",
		"invalid_scope",
		"server_error",
		"authorization_pending",
		"slow_down",
		"access_denied",
		"expired_token",
		"unsupported_token_type"
	]),
	error_description: z.string().optional(),
	error_uri: z.string().optional()
});
function processOAuthErrorResponse(json) {
	try {
		return OAuthErrorResponse.parse(json);
	} catch (error) {
		if (error instanceof z.ZodError) return /* @__PURE__ */ new TypeError(`Invalid OAuth error response: ${error.message}`);
		return /* @__PURE__ */ new TypeError("Failed to parse OAuth error response");
	}
}
var OAuthError = class extends Error {
	constructor(message, response) {
		super(message);
		this.name = "OAuthError";
		const error = processOAuthErrorResponse(response);
		if (error instanceof TypeError) {
			this.cause = /* @__PURE__ */ new Error("Unexpected response from the Vercel authorization server.");
			this.code = "server_error";
			return;
		}
		let cause = error.error;
		if (error.error_description) cause += `: ${error.error_description}`;
		if (error.error_uri) cause += ` (${error.error_uri})`;
		this.cause = new Error(cause);
		this.code = error.error;
	}
};
function isOAuthError(error) {
	return error instanceof OAuthError;
}

//#endregion
export { OAuth, isOAuthError };
//# sourceMappingURL=oauth.js.map