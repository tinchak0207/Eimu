/**
 * 跨边界路径规则（2026-10-02）。
 *
 * 同一个字串 `/tmp/...` 在三个地方指向三个不同目录，两两互不可见：
 *   (1) 沙箱（bash / run_py）：`/tmp` 被 bind 成 `<workspace>/.run/<slug>/tmp`，每个会话私有；
 *   (2) 受信工具（opencode-server，systemd `PrivateTmp=true`）：`/tmp` 是服务私有的 tmpfs；
 *   (3) 宿主：又是第三个。
 * 于是两边互丢 /tmp 路径必有一端找不到档（2026-10-02 审计：实测沙箱写 `/tmp/x` 后，
 * 服务侧读同路径为 No such file）。
 *
 * 唯一两侧同一个绝对路径的交换区是 workspace（`.run/<slug>/run` 亦然，两侧以同一路径 bind）。
 * 本档提供：(a) 给工具说明用的规则句；(b) 缺档时把裸 ENOENT 换成可行动说明的 helper。
 */

export const CROSS_BOUNDARY_RULE =
  "跨边界交接档案一律放 workspace 内的绝对路径（例如 <workspace>/out/final.mp4），" +
  "/tmp 只当单侧暂存，不要把 /tmp 路径传过边界。";

/**
 * 执行面只有两个，由路径判定，模型不得自选：
 *   cloud — workspace、/tmp、http(s)、/opt/agent-harness。云端工具在这里跑。
 *   local — 使用者电脑（/home、/Users、盘符，以及任何不在云端运行时里的绝对路径）。
 *           只走 local_files 的 probe_media / render_media，写回已授权目录。
 */
export type AgentLocus = "local" | "cloud";

export const LOCAL_AGENT_HANDOFF =
  "locus=local。这个路径在使用者电脑上，云端工具读不到字节，也写不回那台电脑。" +
  "改用 local_files：op=probe_media 看时长和流，op=render_media 在本机剪完并写进已授权目录。" +
  "不要派云端 editor，不要把读失败说成已经剪完。";

const CLOUD_RUNTIME_PREFIX = "/opt/agent-harness";

function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function under(path: string, root: string): boolean {
  const base = stripTrailingSlash(root);
  return path === base || path.startsWith(`${base}/`);
}

/** 判定一个路径该由哪一个 agent 执行。workspaceRoot 省略时，云端只认 /tmp 与 /opt/agent-harness。 */
export function decideAgentLocus(path: string, workspaceRoot?: string): { locus: AgentLocus; reason: string } {
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) return { locus: "cloud", reason: "empty" };
  if (/^https?:\/\//i.test(p) || p.startsWith("data:")) return { locus: "cloud", reason: "url" };
  if (p === "/tmp" || p.startsWith("/tmp/")) return { locus: "cloud", reason: "sandbox_tmp" };
  if (p.startsWith(CLOUD_RUNTIME_PREFIX)) return { locus: "cloud", reason: "cloud_runtime" };
  if (/^[A-Za-z]:[\\/]/.test(p)) return { locus: "local", reason: "device_drive" };
  if (p.startsWith("/")) {
    if (workspaceRoot && under(p, workspaceRoot)) return { locus: "cloud", reason: "workspace" };
    return { locus: "local", reason: "device_path" };
  }
  return { locus: "cloud", reason: "relative" };
}

/** 云端工具碰到使用者电脑上的路径时，回这句并停止。不是本机路径则回 null。 */
export function cloudPathRefusal(resolvedPath: string, workspaceRoot?: string): string | null {
  if (decideAgentLocus(resolvedPath, workspaceRoot).locus !== "local") return null;
  return `${LOCAL_AGENT_HANDOFF} path=${resolvedPath}`;
}

/**
 * 缺档说明：路径是 `/tmp/...` 时回可行动提示，其余回 null（交给呼叫端原本的错误讯息）。
 * 挂在「读 agent 给的来源档」失败分支上，把静默陷阱变成教学错误。
 */
export function explainMissingPath(p: string): string | null {
  if (!p.startsWith("/tmp/")) return null;
  return `（${p} 是沙箱会话私有的 /tmp，受信工具端看不到；宿主 /tmp 又是第三个目录）${CROSS_BOUNDARY_RULE}`;
}

/** 工具说明用的短句（放进 describe，让 agent 在呼叫当下就看到正确用法）。 */
export const LOCAL_PATH_HINT =
  "云端工具只接受 workspace 内的绝对路径（如 <workspace>/out/final.mp4）。" +
  "/tmp 是会话私有目录，不要传过边界。" +
  "使用者电脑上的路径（/home、/Users、盘符）属于本机 agent：不要传给云端工具，改用 local_files 的 probe_media / render_media。";
