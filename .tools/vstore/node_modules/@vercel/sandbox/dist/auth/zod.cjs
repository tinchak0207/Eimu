const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
let zod = require("zod");

//#region src/auth/zod.ts
/**
* A Zod codec that serializes and deserializes JSON strings.
*/
const json = zod.z.string().transform((jsonString, ctx) => {
	try {
		return JSON.parse(jsonString);
	} catch (err) {
		ctx.addIssue({
			code: zod.z.ZodIssueCode.custom,
			message: `Invalid JSON: ${err.message}`
		});
		return zod.z.NEVER;
	}
});

//#endregion
exports.json = json;
//# sourceMappingURL=zod.cjs.map