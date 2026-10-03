import { AGENT_GATEWAY_DEFAULT_ORIGIN } from "@/lib/agent-gateway";

/** 白名單主機：agent 媒體真源（store.tinchak0207.xyz）由 gateway origin 推導，不硬編第二份。 */
const ALLOWED_MEDIA_HOST = new URL(AGENT_GATEWAY_DEFAULT_ORIGIN).hostname;

/**
 * 白名單判定（純函式，可直測）：只收 agent 媒體真源主機的 https URL。
 *  - 相對路徑／畸形字串／非 http(s) → 拒（`new URL` 無 base 會拋）；
 *  - `http://` → 拒（明文）；
 *  - 帶 userinfo（`u:p@host`）→ 拒（會把真實主機藏在 @ 前，是 SSRF/混淆常見手法）；
 *  - 非預設埠 → 拒（hostname 相同但連到別的服務）；
 *  - 主機不在白名單 → 拒。
 * 值域獨立於本路由的 fetch 實作——測試對每一類輸入獨立斷言。
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
