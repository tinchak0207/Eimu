//#region src/auth/project.d.ts
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
declare function inferScope(opts: {
  token: string;
  teamId?: string;
  cwd?: string;
}): Promise<{
  projectId: string;
  teamId: string;
  created: boolean;
  teamSlug?: string;
  projectSlug?: string;
}>;
//#endregion
export { inferScope };
//# sourceMappingURL=project.d.cts.map