// 记忆库注入组装（PRD P0-4 repo 侧）：把私有记忆与共享索引塞进 gateway
// 建号 / memory-patch 的既有 payload。
//
// 契约：`.gateway-work/prod-20260915/MEMORY-INTERFACES.md`
//   §1 ownerKey 算法：SHA-256(key) 前 12 bytes hex（24 字元小写），
//      与 gateway `index.ts:938` `hashKey`（WebCrypto subtle 版）逐字元等价；
//   §4 注入契约：两新栏 `memory_docs`（private active docs，≤8，含 body，
//      驼峰栏位原样）＋ `memory_index_md`（共享索引行；**不截断**，
//      字符预算由 gateway 执行）。
//
// 正典化对帐（2026-09-15 跨片裂缝修复）：gateway 注入/批次用的 ownerKey =
// hashKey(await resolveCanonicalKey(Bearer key))（index.ts:911 →8503），
// resolveCanonicalKey 打 /api/agent/biz/resolve-owner 把 B key 换成属主的
// 派生 sk-biz key；非 B key / 任何失败 fallback 回 rawKey。repo 侧若只
// hash(rawKey)，B key 经正典化后两侧分叉 → 私有库读不到＝机制残废。
// 故本档 `deriveMemoryOwnerKey` 与 gateway 同语义：authenticateBizApiKey
// 认领成功 → hash12(getOrCreateAgentKeyForUser(ownerUserId))；认领失败 /
// 非 sk-biz 形状 / 派生异常 → hash12(rawKey)（＝gateway fallback）。
// 派生 key 本身也是同 userId 登记的 sk-biz key（agent-user-key.ts
// createAndStore → issueBizApiKey），再走一次正典化得同一把 → 不动点，
// 故 B 视角与 C 视角（持派生 key）收敛同一 ownerKey。
//
// 失败纪律：blob 不可达等任何读取异常 → 两栏给空值、不抛（注入是锦上花，
// 不该变成开会话的阻塞点）。存储读取一律走 agent-memory-store 现成 API，
// 本档不碰 blob/Map 细节。

import { createHash } from "node:crypto";
import { BIZ_KEY_PREFIX } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getOrCreateAgentKeyForUser } from "@/lib/agent-user-key";
import {
  listMemoryDocs,
  readMemoryIndexMd,
  type AgentMemoryDoc,
} from "@/lib/agent-memory-store";

/** 契约 §4：private active docs 注入上限。 */
export const MEMORY_INJECTION_MAX_PRIVATE_DOCS = 8;

export interface MemoryInjectionPayload {
  memory_docs: AgentMemoryDoc[];
  memory_index_md: string;
}

/**
 * 正典化解析器：raw Bearer key → 该 key 所属身份的「正典 key」。
 * 抽出成可注入函式，让纯函式测试不需 mock 整个 biz key store
 * （交付一要求：把正典解析拆成可注入函式，测双视角收敛同一 hash）。
 */
export type CanonicalKeyResolver = (rawKey: string) => Promise<string>;

/**
 * 预设解析器：在 repo 进程内直接实作 gateway `resolveCanonicalKey`
 * （deploy-staging/gateway/index.ts:911）背后的语义——gateway 打的是本站
 * `POST /api/agent/biz/resolve-owner`，该端点的逻辑正是
 * `authenticateBizApiKey` → owner userId → `getOrCreateAgentKeyForUser`。
 * 这里复用同一组纯函式，结果与 gateway 呼叫端点完全一致，省掉一次 HTTP 往返。
 *
 * 收敛规则（逐条对齐 gateway fallback 语义）：
 * - 认领成功（sk-biz B key 或派生 C key）→ 回传 owner 派生 key（正典 sk-biz key）。
 * - 认领失败／非 sk-biz 形状（C 端 raw key、未知 key）→ 回传原 key。
 * - 派生 key 取得失败（env 漏配／临时故障）→ 回传原 key（对应端点 503 →
 *   gateway 把非 ok 响应 fallback 回 rawKey）。
 * 任何情况都不抛，保证注入是锦上花、不阻塞开会话。
 */
export const defaultCanonicalKeyResolver: CanonicalKeyResolver = async (rawKey) => {
  const key = rawKey.trim();
  if (!key) return rawKey;
  try {
    // consumeRateLimit:false：与 resolve-owner 端点同一口径——正典化是每请求
    // 都可能触发的内部解析，不该吃掉 B 端 key 的限流配额。
    const auth = await authenticateBizApiKey(key, { consumeRateLimit: false });
    if (!auth.ok) return rawKey;
    const canonical = await getOrCreateAgentKeyForUser(auth.key.userId);
    // 防御：只接受 sk-biz 形状的正典 key（与 gateway `data.canonical_key.startsWith("sk-biz-")`
    // 同校验），否则 fallback 原 key，确保两侧不会因异常派生而分叉。
    return canonical.startsWith(BIZ_KEY_PREFIX) ? canonical : rawKey;
  } catch {
    return rawKey;
  }
};

/**
 * 镜像 gateway `hashKey`（deploy-staging/gateway/index.ts:938）：
 * UTF-8(key) → SHA-256 → 前 12 bytes → 小写 hex（24 字元，无分隔符）。
 * 纯杂凑，不负责正典化——由 `deriveMemoryOwnerKey` 在正典化后调用。
 */
export function hashMemoryOwnerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest().subarray(0, 12).toString("hex");
}

/**
 * 由原始 Bearer key 推导私有库 ownerKey（契约 §1 演算法）。
 *
 * async 正典化感知：先经 `resolveCanonical`（预设复用 gateway 同一套
 * authenticate→派生逻辑）把 B key 收敛到 owner 派生 key，再 hash。
 * 这修正了「B key 注入走 hash(rawKey)、批次读走 hash(canonicalKey)」的跨片
 * 分叉——C 端两侧恒等（正典化对非 B key 是恒等），B 端经正典化后私有库读得通。
 *
 * 对外仅回 24 位 hex ownerKey（或 undefined 表无 key），不暴露明文 key。
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
    canonical = key; // resolver 意外抛错也收敛 raw（gateway 对端点异常同样 fallback rawKey）
  }
  const normalized = String(canonical ?? "").trim() || key;
  return hashMemoryOwnerKey(normalized);
}

/**
 * 组装注入 payload（契约 §4 两栏）。
 *
 * - `memory_docs`：store 现成 `listMemoryDocs({ scope: "private", ownerKey })`
 *   的 active docs（已含 body、驼峰栏位不动），按 store 排序截 ≤8；
 *   缺 ownerKey（无此键 → 无此账户的私有记忆可注入）时回 `[]`。
 * - `memory_index_md`：`await readMemoryIndexMd("shared")`，不截断。
 * - 任何失败（blob 不可达等）→ 对应栏空值，不抛。
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
      memoryDocs = []; // 私有库不可达：不注入，不阻塞
    }
  }

  let indexMd = "";
  try {
    indexMd = await readMemoryIndexMd("shared");
  } catch {
    indexMd = ""; // 共享索引不可达：同上
  }

  return { memory_docs: memoryDocs, memory_index_md: indexMd };
}
