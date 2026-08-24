import pico from "picocolors";

//#region src/utils/log.ts
const colors = {
	warn: pico.yellow,
	error: pico.red,
	success: pico.green,
	info: pico.blue
};
const logPrefix = pico.dim("[vercel/sandbox]");
function write(level, text) {
	text = Array.isArray(text) ? text.join("\n") : text;
	const prefixed = text.replace(/^/gm, `${logPrefix} `);
	console.error(colors[level](prefixed));
}
function code(text) {
	return pico.italic(pico.dim("`") + text + pico.dim("`"));
}

//#endregion
export { code, write };
//# sourceMappingURL=log.js.map