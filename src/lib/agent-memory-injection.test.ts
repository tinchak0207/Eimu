// agent-memory-injection 行為測試（PRD P0-4 repo 側，契約 §1／§4）。
//
// 本機無 blob 憑證（見 agent-memory-store.test.ts 頭注：readBlobTextAt/
// writeBlobText 靜默失敗）→ 全程走進程內 Map 兜底，正好同時覆蓋
// 「blob 不可達不拋」這條失敗紀律。
// 每個 test 開頭一律 __resetAgentMemoryStoreForTests()（loadCatalog 有進程內快取）。
// 配額日期用 ingest 的 now 注入釘死（2026-09-15），測序自洽。
//
// 2026-09-15 跨片裂縫修復：deriveMemoryOwnerKey 變 async 正典化感知
// （B key → hash12(屬主派生 key)，對齊 gateway resolveCanonicalKey+hashKey）。
// 雙視角收斂測試可注入 resolver（純函式層，不碰真 biz key store）。

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

/** 交叉斷言用固定 key；常數由 node 現算（見 test 內 gateway subtle 版比對）。 */
const CROSS_KEY = "sk-test-cross-assert-123";
const CROSS_OWNER_KEY = "60e999bec6f9a2bc7a658070"; // hashKey(CROSS_KEY)：24 位小寫 hex

function sharedDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "shared",
    domain: "測試領域",
    slug: "basic-note",
    description: "a baseline shared knowledge note",
    type: "domain",
    body: "**Why:** 測試\n**How to apply:** 測試",
    evidence: "tool result line one",
    evidenceKind: "tool_result",
    selfScore: 5,
    ...overrides,
  };
}

function privateDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "private",
    ownerKey: CROSS_OWNER_KEY,
    domain: "賬戶偏好",
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

test("ownerKey 鏡像 gateway hashKey：硬斷言 24 位 hex 常數 + subtle 版逐字元等", async () => {
  assert.match(CROSS_OWNER_KEY, /^[0-9a-f]{24}$/);
  assert.equal(await deriveMemoryOwnerKey(CROSS_KEY), CROSS_OWNER_KEY);

  // gateway `index.ts:938` hashKey（WebCrypto subtle 版）現場重算，兩側必逐字元一致。
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CROSS_KEY));
  const gatewayStyle = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(await deriveMemoryOwnerKey(CROSS_KEY), gatewayStyle);

  // 空／缺 key 不產出偽 ownerKey。
  assert.equal(await deriveMemoryOwnerKey(undefined), undefined);
  assert.equal(await deriveMemoryOwnerKey(""), undefined);
  assert.equal(await deriveMemoryOwnerKey("   "), undefined);
});

test("payload 兩欄：private doc 原物件（含 body、駝峰欄位不動）+ 共享索引行", async () => {
  __resetAgentMemoryStoreForTests();
  const ingested = await ingestMemoryDocs({
    batchId: "inj-1",
    docs: [privateDoc(), sharedDoc({ slug: "lighting-rule" })],
    now: NOW,
  });
  assert.equal(ingested.accepted.length, 2);

  const payload = await buildMemoryInjectionPayload(CROSS_OWNER_KEY);
  assert.deepEqual(Object.keys(payload).sort(), ["memory_docs", "memory_index_md"]);

  assert.equal(payload.memory_docs.length, 1);
  const doc = payload.memory_docs[0];
  assert.equal(doc.slug, "pref-cinematic");
  assert.equal(doc.ownerKey, CROSS_OWNER_KEY);
  assert.equal(doc.body, "always ask for cinematic look first"); // 含 body
  assert.equal(doc.evidenceKind, "user_confirmed"); // 駝峰欄位原樣
  assert.equal(doc.status, "active");

  // 索引只含共享目錄行（契約 §4 L1），私有 slug 與共享 doc 不互相竄台。
  assert.match(payload.memory_index_md, /- \[測試領域\] lighting-rule — .*（v1）/);
  assert.doesNotMatch(payload.memory_index_md, /pref-cinematic/);
  assert.equal(payload.memory_docs.some((item) => item.slug === "lighting-rule"), false);
});

test("≤8 截斷：9 條私有 active docs 只注入 8 條", async () => {
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

test("賬戶隔離：別的 ownerKey 讀不到這賬戶的私有記憶", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({ batchId: "inj-3", docs: [privateDoc()], now: NOW });
  const otherOwner = await deriveMemoryOwnerKey("sk-another-account-key");
  assert.ok(otherOwner && otherOwner !== CROSS_OWNER_KEY);
  const stranger = await buildMemoryInjectionPayload(otherOwner);
  assert.deepEqual(stranger.memory_docs, []);
});

test("無 ownerKey 回空：undefined／空字串都不帶私有文檔", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({ batchId: "inj-4", docs: [privateDoc()], now: NOW });
  for (const missing of [undefined, "", "   "]) {
    const payload = await buildMemoryInjectionPayload(missing);
    assert.deepEqual(payload.memory_docs, []);
  }
});

test("blob 不可達不拋：幽靈 ownerKey 與空庫都給空值", async () => {
  __resetAgentMemoryStoreForTests();
  const payload = await buildMemoryInjectionPayload("deadbeefdeadbeefdeadbeef");
  assert.deepEqual(payload, { memory_docs: [], memory_index_md: "" });
  await assert.doesNotReject(buildMemoryInjectionPayload(CROSS_OWNER_KEY));
  await assert.doesNotReject(buildMemoryInjectionPayload(undefined));
});

test("共享索引 repo 側不截斷（字符預算歸 gateway）：>800 字元照全量給出", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 20 }, (_, index) =>
    sharedDoc({
      domain: `共享域${index + 1}`,
      slug: `bulk-${index + 1}`,
      description: `shared knowledge item ${index + 1} marker${index + 1} padded padded`,
    }),
  );
  const ingested = await ingestMemoryDocs({ batchId: "inj-5", docs, now: NOW });
  assert.equal(ingested.accepted.length, 20);

  const payload = await buildMemoryInjectionPayload(CROSS_OWNER_KEY);
  assert.ok(payload.memory_index_md.length > 800);
  assert.equal(payload.memory_index_md.trim().split("\n").length, 20);
});

// ───────────────────────── 2026-09-15 正典化對帳（跨片裂縫修復）

/** 模擬 biz key store＋派生 key 簽發器：同一測試環境內穩定（不依賴真 store）。 */
function makeBizCanonicalizer() {
  const B_KEY = "sk-biz-1f3a9c55be7d0421a6c8e9f01234567d"; // 32 hex，同真實 B key 形狀
  const C_KEY = "sk-biz-9d4c2e77ac1f0834b5d6a7c8e9f01234"; // owner userId=7 的屬主派生 key
  const registered = new Map<string, number>([
    [B_KEY, 7],
    [C_KEY, 7], // getOrCreateAgentKeyForUser 簽發的派生 key 本身也登記在同一 userId 名下
  ]);
  const derivedByUser = new Map<number, string>([[7, C_KEY]]);
  /** 與 defaultCanonicalKeyResolver 同語義：認領→派生；認領失敗→恆等。 */
  const resolver = async (rawKey: string): Promise<string> => {
    const userId = registered.get(rawKey);
    if (userId === undefined) return rawKey;
    return derivedByUser.get(userId) as string;
  };
  return { B_KEY, C_KEY, resolver };
}

test("B/C 雙視角恆等：同一 owner 的 B key 與屬主派生 key 收斂同一 ownerKey", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();

  const fromB = await deriveMemoryOwnerKey(B_KEY, resolver);
  const fromC = await deriveMemoryOwnerKey(C_KEY, resolver);

  // 裂縫修復的核心斷言：正典化後兩視角必須逐字元等，私有庫同一空间。
  assert.ok(fromB && fromC);
  assert.equal(fromB, fromC);
  // 收斂點 = hash12(派生 key)（gateway 端 hashKey(resolveCanonicalKey(...)) 同值）。
  assert.equal(fromB, hashMemoryOwnerKey(C_KEY));
  // 且確實發生了正典化：不等於舊行為 hash12(raw B key)（修復前正是這個分叉）。
  assert.notEqual(fromB, hashMemoryOwnerKey(B_KEY));
});

test("正典化收斂是不動點：派生 key 再正典化一次仍得同一 ownerKey", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();
  // 不動點在解析層：派生 key 再認領仍指向自己（canonical(C_KEY) === C_KEY）。
  assert.equal(await resolver(C_KEY), C_KEY);
  // 沿 gateway 每請求都重算的常態路徑：正典 key 重複正典化，ownerKey 恆定。
  assert.equal(await deriveMemoryOwnerKey(C_KEY, resolver), await deriveMemoryOwnerKey(C_KEY, resolver));
  assert.equal(await deriveMemoryOwnerKey(B_KEY, resolver), await deriveMemoryOwnerKey(C_KEY, resolver));
});

test("注入串起正典化：B 視角 derived ownerKey 讀到以派生 key 落庫的私有文檔", async () => {
  const { B_KEY, C_KEY, resolver } = makeBizCanonicalizer();
  __resetAgentMemoryStoreForTests();
  // 批次寫入側（gateway 用 canonical key 的 hash）：以 hash12(C_KEY) 為 ownerKey 落庫。
  const canonicalOwner = hashMemoryOwnerKey(C_KEY);
  await ingestMemoryDocs({
    batchId: "inj-canonical",
    docs: [privateDoc({ ownerKey: canonicalOwner })],
    now: NOW,
  });
  // 注入讀取側（repo 用原始 B key）：正典化感知後必須讀得到。
  const bViewOwner = await deriveMemoryOwnerKey(B_KEY, resolver);
  const payload = await buildMemoryInjectionPayload(bViewOwner);
  assert.equal(payload.memory_docs.length, 1);
  assert.equal(payload.memory_docs[0].slug, "pref-cinematic");
  // 修復前的舊行為（hash12(raw B key)）讀不到——正是「機制殘廢」的實錘對照。
  const stale = await buildMemoryInjectionPayload(hashMemoryOwnerKey(B_KEY));
  assert.deepEqual(stale.memory_docs, []);
});

test("fallback 路徑：認領失敗／resolver 拋錯／回空都收斂 hash12(raw key)＝gateway rawKey 語義", async () => {
  const plainKey = "sk-regular-platform-key"; // 非 sk-biz 形狀
  const identity = async (k: string) => k;

  // 恆等 resolver（＝非 B key 認領失敗的淨效果）＝直接 hash 原 key。
  assert.equal(await deriveMemoryOwnerKey(plainKey, identity), hashMemoryOwnerKey(plainKey));

  // 形狀正確但未登記的 sk-biz key：走預設 resolver（本機無 blob/DB 憑證 →
  // authenticateBizApiKey 認領失敗）→ fallback rawKey，不拋。
  const unknownBizKey = "sk-biz-0123456789abcdef0123456789abcdef";
  assert.equal(await deriveMemoryOwnerKey(unknownBizKey), hashMemoryOwnerKey(unknownBizKey));

  // resolver 拋錯 → 兜底 rawKey（注入不阻塞開會話的失敗紀律）。
  const boom = async () => {
    throw new Error("store down");
  };
  assert.equal(await deriveMemoryOwnerKey(plainKey, boom), hashMemoryOwnerKey(plainKey));

  // resolver 回空字串 → 同樣收斂 rawKey，不產出「hash of 空」這種幽靈空间。
  const empty = async () => "";
  assert.equal(await deriveMemoryOwnerKey(plainKey, empty), hashMemoryOwnerKey(plainKey));
});
