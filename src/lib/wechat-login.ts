import { createHash, randomUUID } from "node:crypto";
import { del, get, put } from "@/lib/blob-backend";
import { buildWechatUsername, buildWechatPassword } from "./wechat-identity";
import { loginViaNewApi } from "./new-api-auth-server";
import { getGatewayBaseUrl } from "./new-api-auth-server";
import { ensureGatewayUserForOAuth } from "./gateway-admin";
import { WECHAT_WORDPOOL } from "./wechat-wordpool";

export interface WechatLoginState {
  code: string;
  state: string;
  status: "pending" | "completed" | "expired";
  peerId?: string;
  token?: string;
  user?: unknown;
  createdAt: number;
  expiresAt: number;
}

const PREFIX = "wechat-login-v1";
const TTL_SEC = 600;

function key(code: string): string {
  return `${PREFIX}/${encodeURIComponent(code)}.json`;
}

/**
 * 登入碼狀態：模組級記憶體 Map 為主，blob 為 best-effort 跨 instance 同步。
 * - 本地 dev / 無 blob token：記憶體零依賴可用，blob 失敗靜默忽略。
 * - 生產多 instance：單個 state 由任一 instance 寫入記憶體並同步 blob，
 *   callback/poll 落在同 instance 時讀記憶體，跨 instance 時讀 blob fallback。
 * - TTL 僅 10 分鐘且一次性，記憶體不會長存洩漏。
 */
const memoryStore = new Map<string, WechatLoginState>();
const stateIndex = new Map<string, string>();

function memoryKey(code: string): string {
  return code.replace(/[\s，。、]/g, "");
}

/** state → code 的 blob 索引 key（subscribe/SCAN 事件反查用）。 */
function stateKey(state: string): string {
  return `${PREFIX}/by-state/${state}.json`;
}

async function blobPut(state: WechatLoginState): Promise<void> {
  try {
    await put(key(state.code), JSON.stringify(state), {
      cacheControlMaxAge: TTL_SEC,
      allowOverwrite: true,
      addRandomSuffix: false,
      access: "public",
    });
    // state 索引：掃碼事件（EventKey=state）跨 instance 也能反查登入碼
    await put(stateKey(state.state), JSON.stringify({ code: state.code }), {
      cacheControlMaxAge: TTL_SEC,
      allowOverwrite: true,
      addRandomSuffix: false,
      access: "public",
    });
  } catch (error) {
    console.warn("[wechat-login] blob put skipped:", error instanceof Error ? error.message : error);
  }
}

async function blobGet(code: string): Promise<WechatLoginState | null> {
  try {
    const blob = await get(key(code), { access: "public" });
    if (!blob) return null;
    const text = await new Response(blob.stream).text();
    return JSON.parse(text) as WechatLoginState;
  } catch {
    return null;
  }
}

/** 從真實常用詞庫（現代漢語常用詞表 → 簡體）隨機抽兩個雙字詞組合。 */
export function generateLoginCode(): string {
  const pool = WECHAT_WORDPOOL;
  const a = pool[Math.floor(Math.random() * pool.length)];
  const b = pool[Math.floor(Math.random() * pool.length)];
  return `${a}${b}`;
}

/** 全新的一次性登入 state。 */
export async function createWechatLoginState(): Promise<WechatLoginState> {
  const now = Date.now();
  const state: WechatLoginState = {
    code: generateLoginCode(),
    state: randomUUID(),
    status: "pending",
    createdAt: now,
    expiresAt: now + TTL_SEC * 1000,
  };
  memoryStore.set(memoryKey(state.code), state);
  stateIndex.set(state.state, state.code);
  // 必須 await（2026-09-30）：掃碼事件 /msg 與這裡多半落在不同 instance，只能靠
  // blob 的 state 索引反查。fire-and-forget 時 serverless 回完響應就可能凍結，
  // 索引沒寫上 → 掃碼事件查無此碼 → 使用者掃了卻永遠等不到登入。
  await blobPut(state);
  return state;
}

export async function getWechatLoginState(code: string): Promise<WechatLoginState | null> {
  const clean = code.replace(/[\s，。、]/g, "");
  if (!clean) return null;
  const mem = memoryStore.get(memoryKey(clean));
  if (mem) return mem;
  const blobState = await blobGet(clean);
  if (blobState) memoryStore.set(memoryKey(clean), blobState);
  return blobState;
}

/**
 * 由 state（掃碼二維碼 scene 值）反查登入記錄。
 * 事件推送只帶 EventKey=scene=state，不帶驗證碼，需經 state 索引找 code。
 */
export async function getWechatLoginStateByState(state: string): Promise<WechatLoginState | null> {
  if (!state) return null;
  const memCode = stateIndex.get(state);
  if (memCode) {
    const mem = memoryStore.get(memoryKey(memCode));
    if (mem) return mem;
  }
  try {
    const blob = await get(stateKey(state), { access: "public" });
    if (!blob) return null;
    const { code } = JSON.parse(await new Response(blob.stream).text()) as { code?: string };
    if (!code) return null;
    const record = await getWechatLoginState(code);
    if (record?.state === state) return record;
  } catch {
    // ignore
  }
  return null;
}

/** 兌換（一次性）：把登入碼標記為已綁定，並寫入頒發的 session。 */
export async function completeWechatLogin(code: string, peerId: string, token: string, user: unknown): Promise<boolean> {
  const clean = code.replace(/[\s，。、]/g, "");
  const existing = await getWechatLoginState(clean);
  if (!existing || existing.status !== "pending") return false;
  existing.status = "completed";
  existing.peerId = peerId;
  existing.token = token;
  existing.user = user;
  memoryStore.set(memoryKey(clean), existing);
  // 必須 await：Vercel serverless 多 instance，poll 可能打到不同 instance，
  // 只能靠 blob 共享 completed 狀態。fire-and-forget 會讓 poll 讀不到而一直 pending。
  await blobPut(existing);
  return true;
}

export async function expireWechatLogin(code: string): Promise<void> {
  const clean = code.replace(/[\s，。、]/g, "");
  const record = memoryStore.get(memoryKey(clean));
  if (record) stateIndex.delete(record.state);
  memoryStore.delete(memoryKey(clean));
  try {
    await del([key(clean)]);
  } catch {
    // best-effort
  }
}

export interface WechatPeerLoginResult {
  ok: boolean;
  token: string;
  user: unknown;
  isNewUser: boolean;
  message?: string;
}

/**
 * 由 peerId 建立/登入 new-api 帳號。
 * username 由 peerId 穩定推導（wx_<hash>），同一個微信號永遠對應同一個帳號，
 * 天然 1:1，滿足「一 peerId 一生只能綁一號」。
 *
 * 分流：
 * - 上游账号不存在（管理员 API 建号成功）→ 新用戶（isNewUser=true）→ login 拿 session
 * - 上游账号已存在（复用它）→ 老用戶（isNewUser=false）→ login
 * - 建号其他失败 → throw
 * - login 失敗 → throw（帳戶狀態異常、停用、密碼失配等）
 *
 * 建号走管理员 API（ensureGatewayUserForOAuth），不再打公开注册端点
 * `/api/user/register` —— 关闭自助注册后那个端点会被上游拒绝。
 */
export async function loginWechatPeer(peerId: string, passwordSeed: string): Promise<WechatPeerLoginResult> {
  const gatewayBase = getGatewayBaseUrl();
  const username = buildWechatUsername(peerId);
  const password = buildWechatPassword(peerId, passwordSeed);

  let isNewUser: boolean;
  try {
    ({ created: isNewUser } = await ensureGatewayUserForOAuth({ username, password }));
  } catch (error) {
    throw new Error(`微信用户注册失败：${error instanceof Error ? error.message : "unknown"}`);
  }

  const result = await loginViaNewApi(gatewayBase, username, password);
  if (!result.ok) {
    throw new Error(`微信用户登录失败（${isNewUser ? "新用户" : "已注册用户"}）：${result.message}`);
  }
  return { ok: true, token: result.token, user: result.user, isNewUser };
}

/** bot 端回呼的 shared secret 校驗（常數時間比較，防 timing attack）。 */
export function verifyWechatCallbackSecret(secret: string | null): boolean {
  const expected = process.env.WECHAT_CALLBACK_SECRET?.trim();
  if (!expected || !secret) return false;
  const a = createHash("sha256").update(secret).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && createHash("sha256").update(Buffer.concat([a, b])).digest("hex") ===
    createHash("sha256").update(Buffer.concat([b, a])).digest("hex");
}

export const WECHAT_LOGIN_TTL_SEC = TTL_SEC;
