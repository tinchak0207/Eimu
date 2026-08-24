import { decodeBase64Url } from "./decode-base64-url.js";
import { cachedGenerateCredentials, shouldPromptForCredentials } from "./dev-credentials.js";
import { z } from "zod";
import { getVercelOidcToken } from "@vercel/oidc";

//#region src/utils/get-credentials.ts
/**
* Error thrown when OIDC context is not available in local development,
* therefore we should guide how to ensure it is set up by linking a project
*/
var LocalOidcContextError = class extends Error {
	constructor(cause) {
		const message = [
			"Could not get credentials from OIDC context.",
			"Please link your Vercel project using `npx vercel link`.",
			"Then, pull an initial OIDC token with `npx vercel env pull`",
			"and retry.",
			"╰▶ Make sure you are loading `.env.local` correctly, or passing $VERCEL_OIDC_TOKEN directly."
		].join("\n");
		super(message, { cause });
		this.name = "LocalOidcContextError";
	}
};
/**
* Error thrown when OIDC context is not available in Vercel environment,
* therefore we should guide how to set it up.
*/
var VercelOidcContextError = class extends Error {
	constructor(cause) {
		const message = [
			"Could not get credentials from OIDC context.",
			"Please make sure OIDC is set up for your project",
			"╰▶ Docs: https://vercel.com/docs/oidc"
		].join("\n");
		super(message, { cause });
		this.name = "VercelOidcContextError";
	}
};
async function getVercelToken(opts) {
	try {
		return getCredentialsFromOIDCToken(await getVercelOidcToken({
			team: opts.teamId,
			project: opts.projectId
		}));
	} catch (error) {
		if (!shouldPromptForCredentials()) if (process.env.VERCEL_URL) throw new VercelOidcContextError(error);
		else throw new LocalOidcContextError(error);
		return await cachedGenerateCredentials(opts);
	}
}
/**
* Allow to get credentials to access the Vercel API. Credentials can be
* provided in two different ways:
*
* 1. By passing an object with the `teamId`, `token`, and `projectId` properties.
* 2. By using an environment variable VERCEL_OIDC_TOKEN.
*
* If both methods are used, the object properties take precedence over the
* environment variable. If neither method is used, an error is thrown.
*/
async function getCredentials(params) {
	const credentials = getCredentialsFromParams(params ?? {});
	if (credentials) return credentials;
	return await getVercelToken({
		teamId: params && typeof params === "object" && "teamId" in params && typeof params.teamId === "string" ? params.teamId : void 0,
		projectId: params && typeof params === "object" && "projectId" in params && typeof params.projectId === "string" ? params.projectId : void 0
	});
}
/**
* Attempt to extract credentials from the provided parameters. Either all
* required fields (`token`, `teamId`, and `projectId`) must be present
* or none of them, otherwise an error is thrown.
*/
function getCredentialsFromParams(params) {
	if (!params || typeof params !== "object") return null;
	const missing = [
		"token" in params && typeof params.token === "string" ? null : "token",
		"teamId" in params && typeof params.teamId === "string" ? null : "teamId",
		"projectId" in params && typeof params.projectId === "string" ? null : "projectId"
	].filter((value) => value !== null);
	if (missing.length === 0) return {
		token: params.token,
		projectId: params.projectId,
		teamId: params.teamId
	};
	if (missing.length < 3) throw new Error(`Missing credentials parameters to access the Vercel API: ${missing.filter((value) => value !== null).join(", ")}`);
	return null;
}
/**
* Schema to validate the payload of the Vercel OIDC token where we expect
* to find the `teamId` and `projectId`.
*/
const schema = z.object({
	exp: z.number().optional().describe("Expiry timestamp (seconds since epoch)"),
	iat: z.number().optional().describe("Issued at timestamp"),
	owner_id: z.string(),
	project_id: z.string()
});
/**
* Extracts credentials from a Vercel OIDC token. The token is expected to be
* a JWT with a payload that contains `project_id` and `owner_id`.
*
* @param token - The Vercel OIDC token.
* @returns An object containing the token, projectId, and teamId.
* @throws If the token is invalid or does not contain the required fields.
*/
function getCredentialsFromOIDCToken(token) {
	try {
		const payload = schema.parse(decodeBase64Url(token.split(".")[1]));
		return {
			token,
			projectId: payload.project_id,
			teamId: payload.owner_id
		};
	} catch (error) {
		throw new Error(`Invalid Vercel OIDC token: ${error instanceof Error ? error.message : String(error)}`);
	}
}

//#endregion
export { getCredentials };
//# sourceMappingURL=get-credentials.js.map