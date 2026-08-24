const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
const require_log = require('./log.cjs');
let picocolors = require("picocolors");
picocolors = require_rolldown_runtime.__toESM(picocolors);
let ms = require("ms");
ms = require_rolldown_runtime.__toESM(ms);

//#region src/utils/dev-credentials.ts
async function importAuth() {
	return await Promise.resolve().then(() => require("../auth/index.cjs"));
}
function shouldPromptForCredentials() {
	return process.env.NODE_ENV !== "production" && !["1", "true"].includes(process.env.CI || "") && process.stdout.isTTY && process.stdin.isTTY;
}
/**
* Returns cached credentials for the given team/project combination.
*
* @remarks
* The cache is keyed by `teamId` and `projectId`. A new credential generation
* is triggered only when these values change or when a previous attempt failed.
*
* **Important:** Successfully resolved credentials are cached indefinitely and
* will not be refreshed even if the token expires. Cache invalidation only occurs
* on rejection (error). This is intentional for development use cases where
* short-lived sessions don't require proactive token refresh.
*/
const cachedGenerateCredentials = (() => {
	let cache = null;
	return async (opts) => {
		if (!cache || cache[0].teamId !== opts.teamId || cache[0].projectId !== opts.projectId) cache = [opts, generateCredentials(opts).catch((err) => {
			cache = null;
			throw err;
		})];
		const v = await cache[1];
		require_log.write("warn", `using inferred credentials team=${v.teamId} project=${v.projectId}`);
		return v;
	};
})();
/**
* Generates credentials by authenticating and inferring scope.
*
* @internal This is exported for testing purposes. Consider using
* {@link cachedGenerateCredentials} instead, which caches the result
* to avoid redundant authentication flows.
*/
async function generateCredentials(opts) {
	const { OAuth, pollForToken, getAuth, updateAuthConfig, inferScope } = await importAuth();
	let auth = getAuth();
	if (!auth?.token) {
		const timeout = process.env.VERCEL_URL ? "1 minute" : "5 minutes";
		auth = await signInAndGetToken({
			OAuth,
			pollForToken,
			getAuth
		}, timeout);
	}
	if (auth?.refreshToken && auth.expiresAt && auth.expiresAt.getTime() <= Date.now()) {
		const newToken = await (await OAuth()).refreshToken(auth.refreshToken);
		auth = {
			expiresAt: new Date(Date.now() + newToken.expires_in * 1e3),
			token: newToken.access_token,
			refreshToken: newToken.refresh_token || auth.refreshToken
		};
		updateAuthConfig(auth);
	}
	if (!auth?.token) throw new Error([
		`Failed to retrieve authentication token.`,
		`${picocolors.default.bold("hint:")} Set VERCEL_OIDC_TOKEN or provide a Vercel API token.`,
		"├▶ Sandbox docs: https://vercel.com/docs/vercel-sandbox",
		"╰▶ Access tokens: https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token"
	].join("\n"));
	if (opts.teamId && opts.projectId) return {
		token: auth.token,
		teamId: opts.teamId,
		projectId: opts.projectId
	};
	const scope = await inferScope({
		teamId: opts.teamId,
		token: auth.token
	});
	if (scope.created) require_log.write("info", `Created default project "${scope.projectId}" in team "${scope.teamId}".`);
	return {
		token: auth.token,
		teamId: opts.teamId || scope.teamId,
		projectId: opts.projectId || scope.projectId
	};
}
async function signInAndGetToken(auth, timeout) {
	require_log.write("warn", [
		`No VERCEL_OIDC_TOKEN environment variable found, initiating device authorization flow...`,
		`│  ${picocolors.default.bold("help:")} this flow only happens on development environment.`,
		`│  In production, make sure to set up a proper token, or set up Vercel OIDC [https://vercel.com/docs/oidc].`
	]);
	const oauth = await auth.OAuth();
	const request = await oauth.deviceAuthorizationRequest();
	require_log.write("info", [
		`╰▶ To authenticate, visit: ${request.verification_uri_complete}`,
		`   or visit ${picocolors.default.italic(request.verification_uri)} and type ${picocolors.default.bold(request.user_code)}`,
		`   Press ${picocolors.default.bold("<return>")} to open in your browser`
	]);
	let error;
	const generator = auth.pollForToken({
		request,
		oauth
	});
	let done = false;
	let spawnedTimeout = setTimeout(() => {
		if (done) return;
		const message = [
			`Authentication flow timed out after ${timeout}.`,
			`│  Make sure to provide a token to avoid prompting an interactive flow.`,
			`╰▶ ${picocolors.default.bold("help:")} Link your project with ${require_log.code("npx vercel link")} to refresh OIDC token automatically.`
		].join("\n");
		error = new Error(message);
		generator.return();
	}, (0, ms.default)(timeout));
	try {
		for await (const event of generator) switch (event._tag) {
			case "SlowDown":
			case "Timeout":
			case "Response": break;
			case "Error":
				error = event.error;
				break;
			default: throw new Error(`Unknown event type: ${JSON.stringify(event)}`);
		}
	} finally {
		done = true;
		clearTimeout(spawnedTimeout);
	}
	if (error) {
		require_log.write("error", `${picocolors.default.bold("error:")} Authentication failed: ${error.message}`);
		throw error;
	}
	require_log.write("success", `${picocolors.default.bold("done!")} Authenticated successfully!`);
	return auth.getAuth();
}

//#endregion
exports.cachedGenerateCredentials = cachedGenerateCredentials;
exports.shouldPromptForCredentials = shouldPromptForCredentials;
//# sourceMappingURL=dev-credentials.cjs.map