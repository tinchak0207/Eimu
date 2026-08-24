const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
let picocolors = require("picocolors");
picocolors = require_rolldown_runtime.__toESM(picocolors);

//#region src/utils/log.ts
const colors = {
	warn: picocolors.default.yellow,
	error: picocolors.default.red,
	success: picocolors.default.green,
	info: picocolors.default.blue
};
const logPrefix = picocolors.default.dim("[vercel/sandbox]");
function write(level, text) {
	text = Array.isArray(text) ? text.join("\n") : text;
	const prefixed = text.replace(/^/gm, `${logPrefix} `);
	console.error(colors[level](prefixed));
}
function code(text) {
	return picocolors.default.italic(picocolors.default.dim("`") + text + picocolors.default.dim("`"));
}

//#endregion
exports.code = code;
exports.write = write;
//# sourceMappingURL=log.cjs.map