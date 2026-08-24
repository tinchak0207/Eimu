const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
let path = require("path");
path = require_rolldown_runtime.__toESM(path);

//#region src/utils/normalizePath.ts
/**
* Normalize a path and make it relative to `params.extractDir` for inclusion
* in our tar archives.
*
* Relative paths are first resolved to `params.cwd`.
* Absolute paths are normalized and resolved relative to `params.extractDir`.
*
* In addition, paths are normalized so consecutive slashes are removed and
* stuff like `../..` is resolved appropriately.
*
* This function always returns a path relative to `params.extractDir`.
*/
function normalizePath(params) {
	if (!path.default.posix.isAbsolute(params.cwd)) throw new Error("cwd dir must be absolute");
	if (!path.default.posix.isAbsolute(params.extractDir)) throw new Error("extractDir must be absolute");
	const basePath = path.default.posix.isAbsolute(params.filePath) ? path.default.posix.normalize(params.filePath) : path.default.posix.join(params.cwd, params.filePath);
	return path.default.posix.relative(params.extractDir, basePath);
}

//#endregion
exports.normalizePath = normalizePath;
//# sourceMappingURL=normalizePath.cjs.map