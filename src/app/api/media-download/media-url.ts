import { AGENT_GATEWAY_DEFAULT_ORIGIN } from "@/lib/agent-gateway";

/** 白名单主机：agent 媒体真源（store.eimu.dev）由 gateway origin 推导，不硬编第二份。 */
const ALLOWED_MEDIA_HOST = new URL(AGENT_GATEWAY_DEFAULT_ORIGIN).hostname;

/**
 * 白名单判定（纯函式，可直测）：只收 agent 媒体真源主机的 https URL。
 *  - 相对路径／畸形字串／非 http(s) → 拒（`new URL` 无 base 会抛）；
 *  - `http://` → 拒（明文）；
 *  - 带 userinfo（`u:p@host`）→ 拒（会把真实主机藏在 @ 前，是 SSRF/混淆常见手法）；
 *  - 非预设埠 → 拒（hostname 相同但连到别的服务）；
 *  - 主机不在白名单 → 拒。
 * 值域独立于本路由的 fetch 实作——测试对每一类输入独立断言。
 */
export function isAllowedMediaUrl(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const clean = raw.trim();
  if (!clean) return false;
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port !== "") return false;
  return parsed.hostname === ALLOWED_MEDIA_HOST;
}
