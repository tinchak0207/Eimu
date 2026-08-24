const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
const require_zod = require('./zod.cjs');
let zod = require("zod");
let node_path = require("node:path");
node_path = require_rolldown_runtime.__toESM(node_path);
let node_fs_promises = require("node:fs/promises");
node_fs_promises = require_rolldown_runtime.__toESM(node_fs_promises);

//#region src/auth/linked-project.ts
const LinkedProjectSchema = require_zod.json.pipe(zod.z.object({
	projectId: zod.z.string(),
	orgId: zod.z.string()
}));
/**
* Reads the linked project configuration from `.vercel/project.json`.
*
* @param cwd - The directory to search for `.vercel/project.json`.
* @returns The linked project's `projectId` and `teamId`, or `null` if not found.
*/
async function readLinkedProject(cwd) {
	const projectJsonPath = node_path.join(cwd, ".vercel", "project.json");
	let content;
	try {
		content = await node_fs_promises.readFile(projectJsonPath, "utf-8");
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
exports.readLinkedProject = readLinkedProject;
//# sourceMappingURL=linked-project.cjs.map