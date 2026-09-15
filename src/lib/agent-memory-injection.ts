// 記憶庫注入組裝（PRD P0-4 repo 側）：把私有記憶與共享索引塞進 gateway
// 建號 / memory-patch 的既有 payload。
//
// 契約：`.gateway-work/prod-20260915/MEMORY-INTERFACES.md`
//   §1 ownerKey 算法：SHA-256(key) 前 12 bytes hex（24 字元小寫），
//      與 gateway `index.ts:938` `hashKey`（WebCrypto subtle 版）逐字元等價；
//   §4 注入契約：兩新欄 `memory_docs`（private active docs，≤8，含 body，
//      駝峰欄位原樣）＋ `memory_index_md`（共享索引行；**不截斷**，
//      字符預算由 gateway 執行）。
//
// 正典化對帳（2026-09-15 跨片裂縫修復）：gateway 注入/批次用的 ownerKey =
// hashKey(await resolveCanonicalKey(Bearer key))（index.ts:911 →8503），
// resolveCanonicalKey 打 /api/agent/biz/resolve-owner 把 B key 換成屬主的
// 派生 sk-biz key；非 B key / 任何失敗 fallback 回 rawKey。repo 側若只
// hash(rawKey)，B key 經正典化後兩側分叉 → 私有庫讀不到＝機制殘廢。
// 故本檔 `deriveMemoryOwnerKey` 與 gateway 同語義：authenticateBizApiKey
// 認領成功 → hash12(getOrCreateAgentKeyForUser(ownerUserId))；認領失敗 /
// 非 sk-biz 形狀 / 派生異常 → hash12(rawKey)（＝gateway fallback）。
// 派生 key 本身也是同 userId 登記的 sk-biz key（agent-user-key.ts
// createAndStore → issueBizApiKey），再走一次正典化得同一把 → 不動點，
// 故 B 視角與 C 視角（持派生 key）收斂同一 ownerKey。
//
// 失敗紀律：blob 不可達等任何讀取異常 → 兩欄給空值、不拋（注入是錦上花，
// 不該變成開會話的阻塞點）。存儲讀取一律走 agent-memory-store 現成 API，
// 本檔不碰 blob/Map 細節。

import { createHash } from "node:crypto";
import { BIZ_KEY_PREFIX } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getOrCreateAgentKeyForUser } from "@/lib/agent-user-key";
import {
  listMemoryDocs,
  readMemoryIndexMd,
  type AgentMemoryDoc,
} from "@/lib/agent-memory-store";

/** 契約 §4：private active docs 注入上限。 */
export const MEMORY_INJECTION_MAX_PRIVATE_DOCS = 8;

export interface MemoryInjectionPayload {
  memory_docs: AgentMemoryDoc[];
  memory_index_md: string;
}

/**
 * 正典化解析器：raw Bearer key → 該 key 所屬身份的「正典 key」。
 * 抽出成可注入函式，讓純函式測試不需 mock 整個 biz key store
 * （交付一要求：把正典解析拆成可注入函式，測雙視角收斂同一 hash）。
 */
export type CanonicalKeyResolver = (rawKey: string) => Promise<string>;

/**
 * 預設解析器：在 repo 進程內直接實作 gateway `resolveCanonicalKey`
 * （deploy-staging/gateway/index.ts:911）背後的語義——gateway 打的是本站
 * `POST /api/agent/biz/resolve-owner`，該端點的邏輯正是
 * `authenticateBizApiKey` → owner userId → `getOrCreateAgentKeyForUser`。
 * 這裡復用同一組純函式，結果與 gateway 呼叫端點完全一致，省掉一次 HTTP 往返。
 *
 * 收斂規則（逐條對齊 gateway fallback 語義）：
 * - 認領成功（sk-biz B key 或派生 C key）→ 回傳 owner 派生 key（正典 sk-biz key）。
 * - 認領失敗／非 sk-biz 形狀（C 端 raw key、未知 key）→ 回傳原 key。
 * - 派生 key 取得失敗（env 漏配／臨時故障）→ 回傳原 key（對應端點 503 →
 *   gateway 把非 ok 響應 fallback 回 rawKey）。
 * 任何情況都不拋，保證注入是錦上花、不阻塞開會話。
 */
export const defaultCanonicalKeyResolver: CanonicalKeyResolver = async (rawKey) => {
  const key = rawKey.trim();
  if (!key) return rawKey;
  try {
    // consumeRateLimit:false：與 resolve-owner 端點同一口徑——正典化是每請求
    // 都可能觸發的內部解析，不該吃掉 B 端 key 的限流配額。
    const auth = await authenticateBizApiKey(key, { consumeRateLimit: false });
    if (!auth.ok) return rawKey;
    const canonical = await getOrCreateAgentKeyForUser(auth.key.userId);
    // 防禦：只接受 sk-biz 形狀的正典 key（與 gateway `data.canonical_key.startsWith("sk-biz-")`
    // 同校驗），否則 fallback 原 key，確保兩側不會因异常派生而分叉。
    return canonical.startsWith(BIZ_KEY_PREFIX) ? canonical : rawKey;
  } catch {
    return rawKey;
  }
};

/**
 * 鏡像 gateway `hashKey`（deploy-staging/gateway/index.ts:938）：
 * UTF-8(key) → SHA-256 → 前 12 bytes → 小寫 hex（24 字元，無分隔符）。
 * 純雜湊，不負責正典化——由 `deriveMemoryOwnerKey` 在正典化後調用。
 */
export function hashMemoryOwnerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest().subarray(0, 12).toString("hex");
}

/**
 * 由原始 Bearer key 推導私有庫 ownerKey（契約 §1 演算法）。
 *
 * async 正典化感知：先經 `resolveCanonical`（預設復用 gateway 同一套
 * authenticate→派生邏輯）把 B key 收斂到 owner 派生 key，再 hash。
 * 這修正了「B key 注入走 hash(rawKey)、批次讀走 hash(canonicalKey)」的跨片
 * 分叉——C 端兩側恆等（正典化對非 B key 是恆等），B 端經正典化後私有庫讀得通。
 *
 * 對外僅回 24 位 hex ownerKey（或 undefined 表無 key），不暴露明文 key。
 */
export async function deriveMemoryOwnerKey(
  rawKey: string | undefined,
  resolveCanonical: CanonicalKeyResolver = defaultCanonicalKeyResolver,
): Promise<string | undefined> {
  const key = String(rawKey ?? "").trim();
  if (!key) return undefined;
  let canonical: string;
  try {
    canonical = await resolveCanonical(key);
  } catch {
    canonical = key; // resolver 意外拋錯也收斂 raw（gateway 對端點異常同樣 fallback rawKey）
  }
  const normalized = String(canonical ?? "").trim() || key;
  return hashMemoryOwnerKey(normalized);
}

/**
 * 組裝注入 payload（契約 §4 兩欄）。
 *
 * - `memory_docs`：store 現成 `listMemoryDocs({ scope: "private", ownerKey })`
 *   的 active docs（已含 body、駝峰欄位不動），按 store 排序截 ≤8；
 *   缺 ownerKey（無此鍵 → 無此賬戶的私有記憶可注入）時回 `[]`。
 * - `memory_index_md`：`await readMemoryIndexMd("shared")`，不截斷。
 * - 任何失敗（blob 不可達等）→ 對應欄空值，不拋。
 */
export async function buildMemoryInjectionPayload(
  ownerKey: string | undefined,
): Promise<MemoryInjectionPayload> {
  const owner = typeof ownerKey === "string" ? ownerKey.trim() : "";

  let memoryDocs: AgentMemoryDoc[] = [];
  if (owner) {
    try {
      const docs = await listMemoryDocs({ scope: "private", ownerKey: owner });
      memoryDocs = docs.slice(0, MEMORY_INJECTION_MAX_PRIVATE_DOCS);
    } catch {
      memoryDocs = []; // 私有庫不可達：不注入，不阻塞
    }
  }

  let indexMd = "";
  try {
    indexMd = await readMemoryIndexMd("shared");
  } catch {
    indexMd = ""; // 共享索引不可達：同上
  }

  return { memory_docs: memoryDocs, memory_index_md: indexMd };
}
