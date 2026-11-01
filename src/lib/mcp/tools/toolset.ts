/**
 * MCP 工具集分流：默认只露导演面，原子工具收进 toolset=expert。
 *
 * 解析优先级（先命中先生效）：
 * 1. URL query `?toolset=expert`
 * 2. 请求头 `X-Eimu-Toolset` / `Mcp-Toolset`
 * 3. JSON-RPC params.toolset（initialize / tools/list 都认）
 * 未指定 → director。
 */

export type McpToolset = "director" | "expert";

export const DEFAULT_MCP_TOOLSET: McpToolset = "director";

/** 默认 tools/list 只返回这些名字（顺序即暴露顺序）。 */
export const DIRECTOR_TOOL_NAMES = [
  "eimu_direct",
  "eimu_job",
  "list_agent_sessions",
  "get_agent_session",
  "abort_agent_session",
] as const;

export type DirectorToolName = (typeof DIRECTOR_TOOL_NAMES)[number];

const DIRECTOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(DIRECTOR_TOOL_NAMES);

export function isDirectorToolName(name: string): boolean {
  return DIRECTOR_TOOL_NAME_SET.has(name);
}

function normalizeToolsetToken(raw: unknown): McpToolset | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "expert" || value === "all" || value === "full" || value === "atoms") return "expert";
  if (value === "director" || value === "default" || value === "directing") return "director";
  return null;
}

export function parseMcpToolset(input: {
  searchParams?: URLSearchParams | null;
  header?: string | null;
  altHeader?: string | null;
  params?: unknown;
}): McpToolset {
  const fromQuery = input.searchParams ? normalizeToolsetToken(input.searchParams.get("toolset")) : null;
  if (fromQuery) return fromQuery;

  const fromHeader =
    normalizeToolsetToken(input.header) ?? normalizeToolsetToken(input.altHeader);
  if (fromHeader) return fromHeader;

  if (typeof input.params === "object" && input.params !== null && !Array.isArray(input.params)) {
    const fromParams = normalizeToolsetToken((input.params as Record<string, unknown>).toolset);
    if (fromParams) return fromParams;
  }

  return DEFAULT_MCP_TOOLSET;
}

export function filterToolsByToolset<T extends { name: string }>(
  tools: readonly T[],
  toolset: McpToolset,
): readonly T[] {
  if (toolset === "expert") return tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const ordered: T[] = [];
  for (const name of DIRECTOR_TOOL_NAMES) {
    const tool = byName.get(name);
    if (tool) ordered.push(tool);
  }
  return ordered;
}
