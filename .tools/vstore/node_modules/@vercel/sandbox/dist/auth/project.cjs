const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
const require_error = require('./error.cjs');
const require_api = require('./api.cjs');
const require_linked_project = require('./linked-project.cjs');
let zod = require("zod");

//#region src/auth/project.ts
const UserSchema = zod.z.object({ user: zod.z.object({
	defaultTeamId: zod.z.string().nullable(),
	username: zod.z.string()
}) });
const TeamSchema = zod.z.object({
	id: zod.z.string(),
	slug: zod.z.string(),
	updatedAt: zod.z.number().optional(),
	membership: zod.z.object({ role: zod.z.string() }),
	billing: zod.z.object({ plan: zod.z.string() })
});
const TeamsSchema = zod.z.object({
	teams: zod.z.array(zod.z.unknown()).transform((entries) => entries.flatMap((entry) => {
		const parsed = TeamSchema.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	})),
	pagination: zod.z.object({
		count: zod.z.number(),
		next: zod.z.number().nullable()
	})
});
const DEFAULT_PROJECT_NAME = "vercel-sandbox-default-project";
/** Status codes that mean "this team can't be used, try the next one". */
function isSkippableTeamError(e) {
	return e instanceof require_error.NotOk && (e.response.statusCode === 402 || e.response.statusCode === 403);
}
/**
* Resolves the team and project scope for sandbox operations.
*
* First checks for a locally linked project in `.vercel/project.json`.
* If found, uses the `projectId` and `orgId` from there.
*
* Otherwise, if `teamId` is not provided, builds an ordered list of candidate
* teams to try: the user's `defaultTeamId` first (if set), then hobby-plan
* teams where the user has an OWNER role (preferring the personal team matching
* the username, then the most recently updated). Tries each candidate until one
* succeeds.
*
* @param opts.token - Vercel API authentication token.
* @param opts.teamId - Optional team slug. If omitted, candidate teams are resolved automatically.
* @param opts.cwd - Optional directory to search for `.vercel/project.json`. Defaults to `process.cwd()`.
* @returns The resolved scope with `projectId`, `teamId`, and whether the project was `created`.
*
* @throws {NotOk} If the API returns an error other than 404 when checking the project.
*
* @example
* ```ts
* const scope = await inferScope({ token: "vercel_..." });
* // => { projectId: "vercel-sandbox-default-project", teamId: "my-team", created: false }
* ```
*/
async function inferScope(opts) {
	const linkedProject = await require_linked_project.readLinkedProject(opts.cwd ?? process.cwd());
	if (linkedProject) {
		const slugs = await resolveLinkedProjectSlugs(opts.token, linkedProject.teamId, linkedProject.projectId);
		return {
			...linkedProject,
			created: false,
			...slugs
		};
	}
	if (opts.teamId) return tryTeam(opts.token, opts.teamId);
	const { defaultTeamId, username } = (await require_api.fetchApi({
		token: opts.token,
		endpoint: "/v2/user"
	}).then(UserSchema.parse)).user;
	if (defaultTeamId) try {
		const result = await tryTeam(opts.token, defaultTeamId);
		try {
			const team = await require_api.fetchApi({
				token: opts.token,
				endpoint: `/v2/teams/${encodeURIComponent(defaultTeamId)}`
			}).then(zod.z.object({ slug: zod.z.string() }).parse);
			return {
				...result,
				teamSlug: team.slug
			};
		} catch {
			return result;
		}
	} catch (e) {
		if (!isSkippableTeamError(e)) throw e;
	}
	let next = null;
	do {
		const endpoint = next === null ? "/v2/teams?limit=20" : `/v2/teams?limit=20&until=${next}`;
		const page = await require_api.fetchApi({
			token: opts.token,
			endpoint
		}).then(TeamsSchema.parse);
		next = page.pagination.next;
		const hobbyOwnerTeams = page.teams.filter((t) => t.membership.role === "OWNER" && t.billing.plan === "hobby");
		if (hobbyOwnerTeams.length === 0) continue;
		const bestHobbyTeam = hobbyOwnerTeams.find((t) => t.slug === username) ?? hobbyOwnerTeams.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
		if (bestHobbyTeam && bestHobbyTeam.id !== defaultTeamId) try {
			return {
				...await tryTeam(opts.token, bestHobbyTeam.id),
				teamSlug: bestHobbyTeam.slug
			};
		} catch (e) {
			if (!isSkippableTeamError(e)) throw e;
		}
	} while (next !== null);
	try {
		return {
			...await tryTeam(opts.token, username),
			teamSlug: username
		};
	} catch (e) {
		if (!isSkippableTeamError(e)) throw e;
	}
	throw new require_error.NotOk({
		statusCode: 403,
		responseText: `Authenticated as "${username}" but none of the available teams allow sandbox creation.`
	});
}
/**
* Attempts to use a specific team for sandbox operations by checking for
* (or creating) the default project within that team.
*
* @returns The resolved scope if the team is usable.
* @throws {NotOk} On authorization or other API errors.
*/
async function tryTeam(token, teamId) {
	const teamParam = teamId.startsWith("team_") ? `teamId=${encodeURIComponent(teamId)}` : `slug=${encodeURIComponent(teamId)}`;
	let created = false;
	try {
		await require_api.fetchApi({
			token,
			endpoint: `/v2/projects/${encodeURIComponent(DEFAULT_PROJECT_NAME)}?${teamParam}`
		});
	} catch (e) {
		if (!(e instanceof require_error.NotOk) || e.response.statusCode !== 404) throw e;
		await require_api.fetchApi({
			token,
			endpoint: `/v11/projects?${teamParam}`,
			method: "POST",
			body: JSON.stringify({ name: DEFAULT_PROJECT_NAME })
		});
		created = true;
	}
	return {
		projectId: DEFAULT_PROJECT_NAME,
		teamId,
		created
	};
}
/**
* Best-effort resolution of team slug and project name for a linked project.
* Both IDs may be opaque (e.g. `team_xxx`, `prj_xxx`), so we fetch the
* human-readable names from the API in parallel.
*/
async function resolveLinkedProjectSlugs(token, teamId, projectId) {
	try {
		const teamParam = teamId.startsWith("team_") ? `teamId=${encodeURIComponent(teamId)}` : `slug=${encodeURIComponent(teamId)}`;
		const [teamData, projectData] = await Promise.all([require_api.fetchApi({
			token,
			endpoint: `/v2/teams/${encodeURIComponent(teamId)}`
		}).then(zod.z.object({ slug: zod.z.string() }).parse), require_api.fetchApi({
			token,
			endpoint: `/v2/projects/${encodeURIComponent(projectId)}?${teamParam}`
		}).then(zod.z.object({ name: zod.z.string() }).parse)]);
		return {
			teamSlug: teamData.slug,
			projectSlug: projectData.name
		};
	} catch {
		return {};
	}
}

//#endregion
exports.inferScope = inferScope;
//# sourceMappingURL=project.cjs.map