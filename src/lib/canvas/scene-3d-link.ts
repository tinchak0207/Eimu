// 桌面 Blender → 站内画布的一次性连接码（stateless signed code）。
//
// 为什么要有这一层：浏览器外的 Blender 进程没有 cookie，但上传必须以某个登入用户
// 的身份落地（`/api/canvas/scene-3d` 的物件键含 userId）。做法＝站内（已登入）铸一段
// 短命凭证，用户手动搬进 Blender，上传路由验签换回 userId。
//
// 轮子来源（禁造轮子）：本档逐行照抄 `src/lib/emu-oauth.ts` 的同类实现——同样是
// 「浏览器外客户端拿一次性 HMAC 凭证」那条路。白名单差异只有五处，其余
// （base64url + "." + HMAC-SHA256 hex、按最后一个 "." 切分、timingSafeEqual、
// 数字严格校验、任何失败都不抛）逐字同源：
//   ① TTL 60 秒 → 15 分钟（本码要肉眼复制再粘进 Blender，60 秒不够）；
//   ② 密钥 env：`EMU_OAUTH_SECRET`(+`GITHUB_CLIENT_SECRET` 回退) → `SCENE_3D_LINK_SECRET`
//      （**故意不回退**：域隔离，见下）；
//   ③ payload 加域前缀 `scene-3d-link.`；
//   ④ 验签回报失败原因（invalid / expired / not_configured），让路由能给人话，
//      而不是把「过期」和「伪造」混成同一个 null；
//   ⑤ 验签前先挡长度（>512 一律 invalid，不让超长字串进 base64 解码）。
//
// **为什么 payload 必须带域前缀**：`emu-oauth.ts` 的码可以到
// `/api/auth/emu-oauth/exchange` 换一把 B 端密钥。若两者同密钥同格式，画布上显示给
// 用户复制的那串连码就等于一把「可铸 key」的凭证——把「能上传一个模型」的爆炸半径
// 升级成「能铸 B 端密钥」。域前缀（＋各自独立的 env）让两种码互不通用，任一方的
// 密钥泄露或轮换都不会波及另一方。
//
// **为什么不新增存储**：签章自证——码改一个位元组签章就对不上，验证只需重算一次
// HMAC，不必查表、不必写库。于是没有可被重放的长期 token，也没有过期记录要清理；
// 站内不需要为此加一张表或一个 KV。代价＝铸出的码在 TTL 内**无法单独吊销**（只能等
// 它自己过期，或轮换 `SCENE_3D_LINK_SECRET` 一次作废全部未过期的码）。这是本方案的
// 诚实上限，写在这里而不是假装有吊销能力。

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 连接码有效期：15 分钟。
 *
 * 下限＝用户复制码、切到 Blender、粘上、点「导出」的现实时间（跨应用手动操作）。
 * 上限＝这串码一旦被捡走，在过期前就是该用户的上传权；15 分钟是「来得及用」与
 * 「泄露窗口够短」的折中。
 */
export const SCENE_3D_LINK_TTL_MS = 15 * 60_000;

/** 域前缀：让本码与 emu-oauth 的码在密码学上互不通用（见档头第 ③ 条）。 */
export const SCENE_3D_LINK_PURPOSE = "scene-3d-link";

/** 验签长度上限：正常码 ≈ 90 字元，512 已留足余裕；更长的直接判无效。 */
const MAX_LINK_CODE_LENGTH = 512;

/**
 * 签名密钥：`SCENE_3D_LINK_SECRET`，**没有回退、没有预设值**。
 *
 * 照抄 `emu-oauth.ts` 的 `emuOauthSecret()` / `admin-session.ts` 的 `sessionSecret()`
 * 读法（`process.env.X?.trim()` → 缺值即抛），差别只在「不许回退到别的 env」：
 * 回退会让两个互不相干的安全域共用一把密钥，轮换其中一方的密钥会意外作废另一方，
 * 泄露一方的密钥也等于泄露另一方。缺值时**诚实失败**（铸码端点回 503），
 * 不降级成「用某个内建常数签」——那等同完全没有签章。
 */
export function scene3dLinkSecret(): string {
  const secret = process.env.SCENE_3D_LINK_SECRET?.trim();
  if (!secret) throw new Error("SCENE_3D_LINK_SECRET 未配置");
  return secret;
}

/** 密钥是否已配置（给路由决定 503 用，不抛）。 */
export function scene3dLinkConfigured(): boolean {
  return Boolean(process.env.SCENE_3D_LINK_SECRET?.trim());
}

/**
 * 可被连接码代表的 userId 判据（**签发与验证共用同一份**，不写两次）。
 *
 * 为什么要挡 `<= 0`：本地测试模式（`NEXT_PUBLIC_LOCAL_TEST_MODE`）下
 * `authenticateImageUser` 会放行一个 `id: 0` 的假身分。若不挡，站点会铸出一串
 * 验签端必然拒绝的码——用户拿著一串看起来正常、上传必失败的凭证，比一开始就
 * 被诚实拒绝更糟。
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
 * 签发：payload = `scene-3d-link.{userId}.{expiry}`，code = base64url(payload) + "." + hmacHex。
 * base64url 不含 "."，所以按最后一个 "." 拆分即可还原两段（与 emu-oauth 同规则）。
 *
 * `ttlMs` 可注入：测试用负值铸一张「已过期」的码，不必改时钟。
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
 * 验签：切两段 → 验 HMAC（timingSafeEqual）→ 验域前缀 → 验过期 → 回 userId。
 *
 * 顺序是本档的关键：**先验签，再看域与时效**。签章对不上的码不回报「已过期」，
 * 避免给攻击者一个「格式对了、只是旧了」的假讯号；也只有签章有效时，
 * 「过期」这个判定才是可信的。
 *
 * 任何一步失败都不抛，回 `{ ok: false, reason }`，由呼叫端决定状态码与文案。
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

  // base64url 解码对非法字元宽容，解码结果交给下面的严格数字校验兜底（同 emu-oauth）。
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

  // 签章有效 ⇒ 这确实是本服务签出的码，域前缀不符才是异常（别的用途的码）。
  if (purpose !== SCENE_3D_LINK_PURPOSE) return { ok: false, reason: "invalid" };
  if (expiresAt <= Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, userId, expiresAt };
}

/**
 * 从 `Authorization` 标头取出 `Bearer <x>` 的 `<x>`；不是 Bearer 形态回 null。
 *
 * 与上传路由共用同一份解析（不在路由里重写一份 regex）。
 */
export function scene3dLinkBearer(headers: { get(name: string): string | null }): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
