// 桌面 Blender → 站內畫布的一次性連接碼（stateless signed code）。
//
// 為什麼要有這一層：瀏覽器外的 Blender 進程沒有 cookie，但上傳必須以某個登入用戶
// 的身份落地（`/api/canvas/scene-3d` 的物件鍵含 userId）。做法＝站內（已登入）鑄一段
// 短命憑證，用戶手動搬進 Blender，上傳路由驗簽換回 userId。
//
// 輪子來源（禁造輪子）：本檔逐行照抄 `src/lib/emu-oauth.ts` 的同類實現——同樣是
// 「瀏覽器外客戶端拿一次性 HMAC 憑證」那條路。白名單差異只有五處，其餘
// （base64url + "." + HMAC-SHA256 hex、按最後一個 "." 切分、timingSafeEqual、
// 數字嚴格校驗、任何失敗都不拋）逐字同源：
//   ① TTL 60 秒 → 15 分鐘（本碼要肉眼複製再粘進 Blender，60 秒不夠）；
//   ② 密鑰 env：`EMU_OAUTH_SECRET`(+`GITHUB_CLIENT_SECRET` 回退) → `SCENE_3D_LINK_SECRET`
//      （**故意不回退**：域隔離，見下）；
//   ③ payload 加域前綴 `scene-3d-link.`；
//   ④ 驗簽回報失敗原因（invalid / expired / not_configured），讓路由能給人話，
//      而不是把「過期」和「偽造」混成同一個 null；
//   ⑤ 驗簽前先擋長度（>512 一律 invalid，不讓超長字串進 base64 解碼）。
//
// **為什麼 payload 必須帶域前綴**：`emu-oauth.ts` 的碼可以到
// `/api/auth/emu-oauth/exchange` 換一把 B 端密鑰。若兩者同密鑰同格式，畫布上顯示給
// 用戶複製的那串連碼就等於一把「可鑄 key」的憑證——把「能上傳一個模型」的爆炸半徑
// 升級成「能鑄 B 端密鑰」。域前綴（＋各自獨立的 env）讓兩種碼互不通用，任一方的
// 密鑰洩露或輪換都不會波及另一方。
//
// **為什麼不新增存儲**：簽章自證——碼改一個位元組簽章就對不上，驗證只需重算一次
// HMAC，不必查表、不必寫庫。於是沒有可被重放的長期 token，也沒有過期記錄要清理；
// 站內不需要為此加一張表或一個 KV。代價＝鑄出的碼在 TTL 內**無法單獨吊銷**（只能等
// 它自己過期，或輪換 `SCENE_3D_LINK_SECRET` 一次作廢全部未過期的碼）。這是本方案的
// 誠實上限，寫在這裡而不是假裝有吊銷能力。

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 連接碼有效期：15 分鐘。
 *
 * 下限＝用戶複製碼、切到 Blender、粘上、點「导出」的現實時間（跨應用手動操作）。
 * 上限＝這串碼一旦被撿走，在過期前就是該用戶的上傳權；15 分鐘是「來得及用」與
 * 「洩露窗口夠短」的折中。
 */
export const SCENE_3D_LINK_TTL_MS = 15 * 60_000;

/** 域前綴：讓本碼與 emu-oauth 的碼在密碼學上互不通用（見檔頭第 ③ 條）。 */
export const SCENE_3D_LINK_PURPOSE = "scene-3d-link";

/** 驗簽長度上限：正常碼 ≈ 90 字元，512 已留足餘裕；更長的直接判無效。 */
const MAX_LINK_CODE_LENGTH = 512;

/**
 * 簽名密鑰：`SCENE_3D_LINK_SECRET`，**沒有回退、沒有預設值**。
 *
 * 照抄 `emu-oauth.ts` 的 `emuOauthSecret()` / `admin-session.ts` 的 `sessionSecret()`
 * 讀法（`process.env.X?.trim()` → 缺值即拋），差別只在「不許回退到別的 env」：
 * 回退會讓兩個互不相干的安全域共用一把密鑰，輪換其中一方的密鑰會意外作廢另一方，
 * 洩露一方的密鑰也等於洩露另一方。缺值時**誠實失敗**（鑄碼端點回 503），
 * 不降級成「用某個內建常數簽」——那等同完全沒有簽章。
 */
export function scene3dLinkSecret(): string {
  const secret = process.env.SCENE_3D_LINK_SECRET?.trim();
  if (!secret) throw new Error("SCENE_3D_LINK_SECRET 未配置");
  return secret;
}

/** 密鑰是否已配置（給路由決定 503 用，不拋）。 */
export function scene3dLinkConfigured(): boolean {
  return Boolean(process.env.SCENE_3D_LINK_SECRET?.trim());
}

/**
 * 可被連接碼代表的 userId 判據（**簽發與驗證共用同一份**，不寫兩次）。
 *
 * 為什麼要擋 `<= 0`：本地測試模式（`NEXT_PUBLIC_LOCAL_TEST_MODE`）下
 * `authenticateImageUser` 會放行一個 `id: 0` 的假身分。若不擋，站點會鑄出一串
 * 驗簽端必然拒絕的碼——用戶拿著一串看起來正常、上傳必失敗的憑證，比一開始就
 * 被誠實拒絕更糟。
 */
export function isLinkableUserId(userId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0;
}

export type Scene3dLinkVerify =
  | { ok: true; userId: number; expiresAt: number }
  | { ok: false; reason: "invalid" | "expired" | "not_configured" };

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signHmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * 簽發：payload = `scene-3d-link.{userId}.{expiry}`，code = base64url(payload) + "." + hmacHex。
 * base64url 不含 "."，所以按最後一個 "." 拆分即可還原兩段（與 emu-oauth 同規則）。
 *
 * `ttlMs` 可注入：測試用負值鑄一張「已過期」的碼，不必改時鐘。
 */
export function signScene3dLinkCode(
  userId: number,
  ttlMs: number = SCENE_3D_LINK_TTL_MS,
): string {
  if (!isLinkableUserId(userId)) throw new Error("连接码只能代表一个真实登录用户");
  const secret = scene3dLinkSecret();
  const payload = `${SCENE_3D_LINK_PURPOSE}.${userId}.${Date.now() + ttlMs}`;
  return `${base64url(payload)}.${signHmac(secret, payload)}`;
}

/**
 * 驗簽：切兩段 → 驗 HMAC（timingSafeEqual）→ 驗域前綴 → 驗過期 → 回 userId。
 *
 * 順序是本檔的關鍵：**先驗簽，再看域與時效**。簽章對不上的碼不回報「已過期」，
 * 避免給攻擊者一個「格式對了、只是舊了」的假訊號；也只有簽章有效時，
 * 「過期」這個判定才是可信的。
 *
 * 任何一步失敗都不拋，回 `{ ok: false, reason }`，由呼叫端決定狀態碼與文案。
 */
export function verifyScene3dLinkCode(code: string): Scene3dLinkVerify {
  if (!scene3dLinkConfigured()) return { ok: false, reason: "not_configured" };
  if (typeof code !== "string") return { ok: false, reason: "invalid" };

  const raw = code.trim();
  if (!raw || raw.length > MAX_LINK_CODE_LENGTH) return { ok: false, reason: "invalid" };

  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: "invalid" };

  const payloadEncoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  // base64url 解碼對非法字元寬容，解碼結果交給下面的嚴格數字校驗兜底（同 emu-oauth）。
  const payload = Buffer.from(payloadEncoded, "base64url").toString("utf8");
  const parts = payload.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };

  const [purpose, userIdRaw, expiryRaw] = parts;
  if (!/^\d+$/.test(userIdRaw) || !/^\d+$/.test(expiryRaw)) return { ok: false, reason: "invalid" };

  const userId = Number(userIdRaw);
  const expiresAt = Number(expiryRaw);
  if (!isLinkableUserId(userId) || !Number.isSafeInteger(expiresAt)) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const expected = signHmac(scene3dLinkSecret(), payload);
    const received = Buffer.from(signature, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) {
      return { ok: false, reason: "invalid" };
    }
  } catch {
    return { ok: false, reason: "not_configured" };
  }

  // 簽章有效 ⇒ 這確實是本服務簽出的碼，域前綴不符才是異常（別的用途的碼）。
  if (purpose !== SCENE_3D_LINK_PURPOSE) return { ok: false, reason: "invalid" };
  if (expiresAt <= Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, userId, expiresAt };
}

/**
 * 從 `Authorization` 標頭取出 `Bearer <x>` 的 `<x>`；不是 Bearer 形態回 null。
 *
 * 與上傳路由共用同一份解析（不在路由裡重寫一份 regex）。
 */
export function scene3dLinkBearer(headers: { get(name: string): string | null }): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
