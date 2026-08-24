import { json } from "./zod.js";
import { z } from "zod";
import * as path$1 from "node:path";
import * as fs from "node:fs/promises";

//#region src/auth/linked-project.ts
const LinkedProjectSchema = json.pipe(z.object({
	projectId: z.string(),
	orgId: z.string()
}));
/**
* Reads the linked project configuration from `.vercel/project.json`.
*
* @param cwd - The directory to search for `.vercel/project.json`.
* @returns The linked project's `projectId` and `teamId`, or `null` if not found.
*/
async function readLinkedProject(cwd) {
	const projectJsonPath = path$1.join(cwd, ".vercel", "project.json");
	let content;
	try {
		content = await fs.readFile(projectJsonPath, "utf-8");
	} catch {
		return null;
	}
	const parsed = LinkedProjectSchema.safeParse(content);
	if (!parsed.success) return null;
	return {
		projectId: parsed.data.projectId,
		teamId: parsed.data.orgId
	};
}

//#endregion
export { readLinkedProject };
//# sourceMappingURL=linked-project.js.map