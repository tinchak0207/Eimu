// agent-memory-injection 行为测试（PRD P0-4 repo 侧，契约 §1／§4）。
//
// 本机无 blob 凭证（见 agent-memory-store.test.ts 头注：readBlobTextAt/
// writeBlobText 静默失败）→ 全程走进程内 Map 兜底，正好同时覆盖
// 「blob 不可达不抛」这条失败纪律。
// 每个 test 开头一律 __resetAgentMemoryStoreForTests()（loadCatalog 有进程内快取）。
// 配额日期用 ingest 的 now 注入钉死（2026-09-15），测序自洽。
//
// 2026-09-15 跨片裂缝修复：deriveMemoryOwnerKey 变 async 正典化感知
// （B key → hash12(属主派生 key)，对齐 gateway resolveCanonicalKey+hashKey）。
// 双视角收敛测试可注入 resolver（纯函式层，不碰真 biz key store）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetAgentMemoryStoreForTests,
  ingestMemoryDocs,
  type AgentMemoryDocInput,
} from "./agent-memory-store";
import {
  MEMORY_INJECTION_MAX_PRIVATE_DOCS,
  buildMemoryInjectionPayload,
  deriveMemoryOwnerKey,
  hashMemoryOwnerKey,
} from "./agent-memory-injection";

const NOW = new Date("2026-09-15T12:00:00.000Z");

/** 交叉断言用固定 key；常数由 node 现算（见 test 内 gateway subtle 版比对）。 */
const CROSS_KEY = "sk-test-cross-assert-123";
const CROSS_OWNER_KEY = "60e999bec6f9a2bc7a658070"; // hashKey(CROSS_KEY)：24 位小写 hex

function sharedDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "shared",
    domain: "测试领域",
    slug: "basic-note",
    description: "a baseline shared knowledge note",
    type: "domain",
    body: "**Why:** 测试\n**How to apply:** 测试",
    evidence: "tool result line one",
    evidenceKind: "tool_result",
    selfScore: 5,
    // shared 自 4ea47695 起 fail-closed：无 contributorKey 一律 pending_review，
    // 不进 INDEX 也不注入。fixture 补上提出者，需要立即 active 的用例传
    // corroborationMin: 1（生产缺省门槛为 2）。
    contributorKey: "owner-a-hash",
    ...overrides,
  };
}

function privateDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "private",
    ownerKey: CROSS_OWNER_KEY,
    domain: "账户偏好",
    slug: "pref-cinematic",
    description: "user prefers cinematic lighting",
    type: "user",
    body: "always ask for cinematic look first",
    evidence: "user said so",
    evidenceKind: "user_confirmed",
    selfScore: 4,
    ...overrides,
  };
}

test("ownerKey 镜像 gateway hashKey：硬断言 24 位 hex 常数 + subtle 版逐字元等", async () => {
  assert.match(CROSS_OWNER_KEY, /^[0-9a-f]{24}$/);
  assert.equal(await deriveMemoryOwnerKey(CROSS_KEY), CROSS_OWNER_KEY);

  // gateway `index.ts:938` hashKey（WebCrypto subtle 版）现场重算，两侧必逐字元一致。
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CROSS_KEY));
  const gatewayStyle = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(await deriveMemoryOwnerKey(CROSS_KEY), gatewayStyle);

  // 空／缺 key 不产出伪 ownerKey。
  assert.equal(await deriveMemoryOwnerKey(undefined), undefined);
  assert.equal(await deriveMemoryOwnerKey(""), undefined);
  assert.equal(await deriveMemoryOwnerKey("   "), undefined);
});

test("payload 两栏：private doc 原物件（含 body、驼峰栏位不动）+ 共享索引行", async () => {
  __resetAgentMemoryStoreForTests();
  const ingested = await ingestMemoryDocs({
    batchId: "inj-1",
    docs: [privateDoc(), sharedDoc({ slug: "lighting-rule" })],
    now: NOW,
    corroborationMin: 1,
  });
  assert.equal(ingested.accepted.length, 2);

  const payload = await buildMemoryInjectionPayload(CROSS_OWNER_KEY);
  assert.deepEqual(Object.keys(payload).sort(), ["memory_docs", "memory_index_md"]);

  assert.equal(payload.memory_docs.length, 1);
  const doc = payload.memory_docs[0];
  assert.equal(doc.slug, "pref-cinematic");
  assert.equal(doc.ownerKey, CROSS_OWNER_KEY);
  assert.equal(doc.body, "always ask for cinematic look first"); // 含 body
  assert.equal(doc.evidenceKind, "user_confirmed"); // 驼峰栏位原样
  assert.equal(doc.status, "active");

  // 索引只含共享目录行（契约 §4 L1），私有 slug 与共享 doc 不互相窜台。
  assert.match(payload.memory_index_md, /- \[测试领域\] lighting-rule — .*（v1）/);
  assert.doesNotMatch(payload.memory_index_md, /pref-cinematic/);
  assert.equal(payload.memory_docs.some((item) => item.slug === "lighting-rule"), false);
});

test("≤8 截断：9 条私有 active docs 只注入 8 条", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 9 }, (_, index) =>
    privateDoc({
      domain: `偏好域${index + 1}`,
      slug: `pref-${index + 1}`,
      description: `account preference item ${index + 1} marker${index + 1}`,
    }),
  );
  const ingested = await ingestMemoryDocs({ batchId: "inj-2", docs, now: NOW });
  assert.equal(ingested.accepted.length, 9);

  const payload = await buildMemoryInjectionPayload(CROSS_OWNER_KEY);
  assert.equal(payload.memory_docs.length, MEMORY_INJECTION_MAX_PRIVATE_DOCS);
  assert.equal(MEMORY_INJECTION_MAX_PRIVATE_DOCS, 8);
});

test("账户隔离：别的 ownerKey 读不到这账户的私有记忆", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({ batchId: "inj-3", docs: [privateDoc()], now: NOW });
  const otherOwner = await deriveMemoryOwnerKey("sk-another-account-key");
  assert.ok(otherOwner && otherOwner !== CROSS_OWNER_KEY);
  const stranger = await buildMemoryInjectionPayload(otherOwner);
  assert.deepEqual(stranger.memory_docs, []);
});

test("无 ownerKey 回空：undefined／空字串都不带私有文档", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({ batchId: "inj-4", docs: [privateDoc()], now: NOW });
  for (const missing of [undefined, "", "   "]) {
    const payload = await buildMemoryInjectionPayload(missing);
    assert.deepEqual(payload.memory_docs, []);
  }
});

test("blob 不可达不抛：幽灵 ownerKey 与空库都给空值", async () => {
  __resetAgentMemoryStoreForTests();
  const payload = await buildMemoryInjectionPayload("deadbeefdeadbeefdeadbeef");
  assert.deepEqual(payload, { memory_docs: [], memory_index_md: "" });
  await assert.doesNotReject(buildMemoryInjectionPayload(CROSS_OWNER_KEY));
  await assert.doesNotReject(buildMemoryInjectionPayload(undefined));
});

test("共享索引 repo 侧不截断（字符预算归 gateway）：>800 字元照全量给出", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 20 }, (_, index) =>
    sharedDoc({
      domain: `共享域${index + 1}`,
      slug: `bulk-${index + 1}`,
      description: `shared knowledge item ${index + 1} marker${index + 1} padded padded`,
    }),
  );
  const ingested = await ingestMemoryDocs({ batchId: "inj-5", docs, now: NOW, corroborationMin: 1 });
  assert.equal(ingested.accepted.length, 20);

  const payload = await buildMemoryInjectionPayload(CROSS_OWNER_KEY);
  assert.ok(payload.memory_index_md.length > 800);
  assert.equal(payload.memory_index_md.trim().split("\n").length, 20);
});

// ───────────────────────── 2026-09-15 正典化对帐（跨片裂缝修复）

/** 模拟 biz key store＋派生 key 签发器：同一测试环境内稳定（不依赖真 store）。 */
function makeBizCanonicalizer() {
  const B_KEY = "sk-biz-1f3a9c55be7d0421a6c8e9f01234567d"; // 32 hex，同真实 B key 形状
  const C_KEY = "sk-biz-9d4c2e77ac1f0834b5d6a7c8e9f01234"; // owner userId=7 的属主派生 key
  const registered = new Map<string, number>([
    [B_KEY, 7],
    [C_KEY, 7], // getOrCreateAgentKeyForUser 签发的派生 key 本身也登记在同一 userId 名下
  ]);
  const derivedByUser = new Map<number, string>([[7, C_KEY]]);
  /** 与 defaultCanonicalKeyResolver 同语义：认领→派生；认领失败→恒等。 */
  const resolver = async (rawKey: string): Promise<string> => {
    const userId = registered.get(rawKey);
    if (userId === undefined) return rawKey;
    return derivedByUser.get(userId) as string;
  };
  return { B_KEY, C_KEY, resolver };
}

test("B/C 双视角恒等：同一 owner 的 B key 与属主派生 key 收敛同一 ownerKey", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();

  const fromB = await deriveMemoryOwnerKey(B_KEY, resolver);
  const fromC = await deriveMemoryOwnerKey(C_KEY, resolver);

  // 裂缝修复的核心断言：正典化后两视角必须逐字元等，私有库同一空间。
  assert.ok(fromB && fromC);
  assert.equal(fromB, fromC);
  // 收敛点 = hash12(派生 key)（gateway 端 hashKey(resolveCanonicalKey(...)) 同值）。
  assert.equal(fromB, hashMemoryOwnerKey(C_KEY));
  // 且确实发生了正典化：不等于旧行为 hash12(raw B key)（修复前正是这个分叉）。
  assert.notEqual(fromB, hashMemoryOwnerKey(B_KEY));
});

test("正典化收敛是不动点：派生 key 再正典化一次仍得同一 ownerKey", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();
  // 不动点在解析层：派生 key 再认领仍指向自己（canonical(C_KEY) === C_KEY）。
  assert.equal(await resolver(C_KEY), C_KEY);
  // 沿 gateway 每请求都重算的常态路径：正典 key 重复正典化，ownerKey 恒定。
  assert.equal(await deriveMemoryOwnerKey(C_KEY, resolver), await deriveMemoryOwnerKey(C_KEY, resolver));
  assert.equal(await deriveMemoryOwnerKey(B_KEY, resolver), await deriveMemoryOwnerKey(C_KEY, resolver));
});

test("注入串起正典化：B 视角 derived ownerKey 读到以派生 key 落库的私有文档", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();
  __resetAgentMemoryStoreForTests();
  // 批次写入侧（gateway 用 canonical key 的 hash）：以 hash12(C_KEY) 为 ownerKey 落库。
  const canonicalOwner = hashMemoryOwnerKey(C_KEY);
  await ingestMemoryDocs({
    batchId: "inj-canonical",
    docs: [privateDoc({ ownerKey: canonicalOwner })],
    now: NOW,
  });
  // 注入读取侧（repo 用原始 B key）：正典化感知后必须读得到。
  const bViewOwner = await deriveMemoryOwnerKey(B_KEY, resolver);
  const payload = await buildMemoryInjectionPayload(bViewOwner);
  assert.equal(payload.memory_docs.length, 1);
  assert.equal(payload.memory_docs[0].slug, "pref-cinematic");
  // 修复前的旧行为（hash12(raw B key)）读不到——正是「机制残废」的实锤对照。
  const stale = await buildMemoryInjectionPayload(hashMemoryOwnerKey(B_KEY));
  assert.deepEqual(stale.memory_docs, []);
});

test("fallback 路径：认领失败／resolver 抛错／回空都收敛 hash12(raw key)＝gateway rawKey 语义", async () => {
  const plainKey = "sk-regular-platform-key"; // 非 sk-biz 形状
  const identity = async (k: string) => k;

  // 恒等 resolver（＝非 B key 认领失败的净效果）＝直接 hash 原 key。
  assert.equal(await deriveMemoryOwnerKey(plainKey, identity), hashMemoryOwnerKey(plainKey));

  // 形状正确但未登记的 sk-biz key：走预设 resolver（本机无 blob/DB 凭证 →
  // authenticateBizApiKey 认领失败）→ fallback rawKey，不抛。
  const unknownBizKey = "sk-biz-0123456789abcdef0123456789abcdef";
  assert.equal(await deriveMemoryOwnerKey(unknownBizKey), hashMemoryOwnerKey(unknownBizKey));

  // resolver 抛错 → 兜底 rawKey（注入不阻塞开会话的失败纪律）。
  const boom = async () => {
    throw new Error("store down");
  };
  assert.equal(await deriveMemoryOwnerKey(plainKey, boom), hashMemoryOwnerKey(plainKey));

  // resolver 回空字串 → 同样收敛 rawKey，不产出「hash of 空」这种幽灵空间。
  const empty = async () => "";
  assert.equal(await deriveMemoryOwnerKey(plainKey, empty), hashMemoryOwnerKey(plainKey));
});
