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
 * 缺档说明：路径是 `/tmp/...` 时回可行动提示，其余回 null（交给呼叫端原本的错误讯息）。
 * 挂在「读 agent 给的来源档」失败分支上，把静默陷阱变成教学错误。
 */
export function explainMissingPath(p: string): string | null {
  if (!p.startsWith("/tmp/")) return null;
  return `（${p} 是沙箱会话私有的 /tmp，受信工具端看不到；宿主 /tmp 又是第三个目录）${CROSS_BOUNDARY_RULE}`;
}

/** 工具说明用的短句（放进 describe，让 agent 在呼叫当下就看到正确用法）。 */
export const LOCAL_PATH_HINT =
  "本机档案请给 workspace 内的绝对路径（如 <workspace>/out/final.mp4）；沙箱的 /tmp 是会话私有目录，工具端读不到。";
