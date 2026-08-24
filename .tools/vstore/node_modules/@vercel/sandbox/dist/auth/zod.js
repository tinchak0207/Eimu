import { z } from "zod";

//#region src/auth/zod.ts
/**
* A Zod codec that serializes and deserializes JSON strings.
*/
const json = z.string().transform((jsonString, ctx) => {
	try {
		return JSON.parse(jsonString);
	} catch (err) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `Invalid JSON: ${err.message}`
		});
		return z.NEVER;
	}
});

//#endregion
export { json };
//# sourceMappingURL=zod.js.map