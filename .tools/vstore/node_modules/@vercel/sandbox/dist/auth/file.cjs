const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
const require_zod = require('./zod.cjs');
let zod = require("zod");
let node_path = require("node:path");
node_path = require_rolldown_runtime.__toESM(node_path);
let node_fs = require("node:fs");
node_fs = require_rolldown_runtime.__toESM(node_fs);
let node_os = require("node:os");
let xdg_app_paths = require("xdg-app-paths");
xdg_app_paths = require_rolldown_runtime.__toESM(xdg_app_paths);

//#region src/auth/file.ts
const ZodDate = zod.z.number().transform((seconds) => /* @__PURE__ */ new Date(seconds * 1e3));
const AuthFile = zod.z.object({
	token: zod.z.string().min(1).optional(),
	refreshToken: zod.z.string().min(1).optional(),
	expiresAt: ZodDate.optional()
});
const StoredAuthFile = require_zod.json.pipe(AuthFile);
const isDirectory = (path$1) => {
	try {
		return node_fs.default.lstatSync(path$1).isDirectory();
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
	const vercelDirectories = (0, xdg_app_paths.default)("com.vercel.cli").dataDirs();
	return [
		...vercelDirectories,
		node_path.default.join((0, node_os.homedir)(), ".now"),
		...(0, xdg_app_paths.default)("now").dataDirs()
	].find((configPath) => isDirectory(configPath)) || vercelDirectories[0];
};
const getAuth = () => {
	try {
		const pathname = node_path.default.join(getGlobalPathConfig(), "auth.json");
		return StoredAuthFile.parse(node_fs.default.readFileSync(pathname, "utf8"));
	} catch {
		return null;
	}
};
function updateAuthConfig(config) {
	const pathname = node_path.default.join(getGlobalPathConfig(), "auth.json");
	node_fs.default.mkdirSync(node_path.default.dirname(pathname), { recursive: true });
	const content = {
		token: config.token,
		expiresAt: config.expiresAt && Math.round(config.expiresAt.getTime() / 1e3),
		refreshToken: config.refreshToken
	};
	node_fs.default.writeFileSync(pathname, JSON.stringify(content) + "\n");
}

//#endregion
exports.getAuth = getAuth;
exports.updateAuthConfig = updateAuthConfig;
//# sourceMappingURL=file.cjs.map