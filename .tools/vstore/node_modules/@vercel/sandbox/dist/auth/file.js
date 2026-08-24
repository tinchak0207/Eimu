import { json } from "./zod.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";
import XDGAppPaths from "xdg-app-paths";

//#region src/auth/file.ts
const ZodDate = z.number().transform((seconds) => /* @__PURE__ */ new Date(seconds * 1e3));
const AuthFile = z.object({
	token: z.string().min(1).optional(),
	refreshToken: z.string().min(1).optional(),
	expiresAt: ZodDate.optional()
});
const StoredAuthFile = json.pipe(AuthFile);
const isDirectory = (path$1) => {
	try {
		return fs.lstatSync(path$1).isDirectory();
	} catch (_) {
		return false;
	}
};
/**
* Returns in which directory the config should be present.
*
* @internal The `VERCEL_AUTH_CONFIG_DIR` env var is for testing purposes only
* and is not part of the public API.
*/
const getGlobalPathConfig = () => {
	if (process.env.VERCEL_AUTH_CONFIG_DIR) return process.env.VERCEL_AUTH_CONFIG_DIR;
	const vercelDirectories = XDGAppPaths("com.vercel.cli").dataDirs();
	return [
		...vercelDirectories,
		path.join(homedir(), ".now"),
		...XDGAppPaths("now").dataDirs()
	].find((configPath) => isDirectory(configPath)) || vercelDirectories[0];
};
const getAuth = () => {
	try {
		const pathname = path.join(getGlobalPathConfig(), "auth.json");
		return StoredAuthFile.parse(fs.readFileSync(pathname, "utf8"));
	} catch {
		return null;
	}
};
function updateAuthConfig(config) {
	const pathname = path.join(getGlobalPathConfig(), "auth.json");
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
	const content = {
		token: config.token,
		expiresAt: config.expiresAt && Math.round(config.expiresAt.getTime() / 1e3),
		refreshToken: config.refreshToken
	};
	fs.writeFileSync(pathname, JSON.stringify(content) + "\n");
}

//#endregion
export { getAuth, updateAuthConfig };
//# sourceMappingURL=file.js.map