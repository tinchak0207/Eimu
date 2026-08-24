import { updateAuthConfig } from "./file.js";
import { isOAuthError } from "./oauth.js";
import { setTimeout } from "node:timers/promises";

//#region src/auth/poll-for-token.ts
async function* pollForToken({ request, oauth }) {
	const controller = new AbortController();
	try {
		let intervalMs = request.interval * 1e3;
		while (Date.now() < request.expiresAt) {
			const [tokenResponseError, tokenResponse] = await oauth.deviceAccessTokenRequest(request.device_code);
			if (tokenResponseError) {
				if (tokenResponseError.message.includes("timeout")) {
					intervalMs *= 2;
					yield {
						_tag: "Timeout",
						newInterval: intervalMs
					};
					await setTimeout(intervalMs, { signal: controller.signal });
					continue;
				}
				yield {
					_tag: "Error",
					error: tokenResponseError
				};
				return;
			}
			yield {
				_tag: "Response",
				response: tokenResponse.clone()
			};
			const [tokensError, tokens] = await oauth.processTokenResponse(tokenResponse);
			if (isOAuthError(tokensError)) {
				const { code } = tokensError;
				switch (code) {
					case "authorization_pending":
						await setTimeout(intervalMs, { signal: controller.signal });
						continue;
					case "slow_down":
						intervalMs += 5 * 1e3;
						yield {
							_tag: "SlowDown",
							newInterval: intervalMs
						};
						await setTimeout(intervalMs, { signal: controller.signal });
						continue;
					default:
						yield {
							_tag: "Error",
							error: tokensError.cause
						};
						return;
				}
			}
			if (tokensError) {
				yield {
					_tag: "Error",
					error: tokensError
				};
				return;
			}
			updateAuthConfig({
				token: tokens.access_token,
				expiresAt: new Date(Date.now() + tokens.expires_in * 1e3),
				refreshToken: tokens.refresh_token
			});
			return;
		}
		yield {
			_tag: "Error",
			error: /* @__PURE__ */ new Error("Timed out waiting for authentication. Please try again.")
		};
		return;
	} finally {
		controller.abort();
	}
}

//#endregion
export { pollForToken };
//# sourceMappingURL=poll-for-token.js.map