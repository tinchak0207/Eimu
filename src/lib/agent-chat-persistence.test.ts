// agent-chat-persistence 的单元测试。
//
// 运行器：node:test（与仓库其余 84 个测试文件一致，`npm test` = tsx --test）。
// 不要改用 vitest 的 describe/it —— `tsx --test` 会 require vitest 的 CJS 入口
// 而直接抛 "Vitest cannot be imported in a CommonJS module"，整个文件计红。

import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_CHAT_RECLAIM_MS,
  AGENT_CHAT_STORAGE_KEY,
  MAX_PERSISTED_ITEMS,
  clearPersistedSnapshot,
  isPersistedExpired,
  loadPersistedSnapshot,
  sanitizeItemsForStorage,
  savePersistedSnapshot,
  truncateItems,
  type AgentStorageLike,
} from "./agent-chat-persistence";
import type { AgentTranscriptItem } from "./agent-chat-types";

// ─────────────────────────── 内存版 localStorage（可控抛错）

class MemoryStorage implements AgentStorageLike {
  private map = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error("privacy mode blocks read");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error("quota exceeded");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const NOW = 1_000_000_000_000;

function snap(overrides: Partial<Parameters<typeof savePersistedSnapshot>[1]> = {}) {
  return {
    sessionId: "sess-abc123",
    lastEventId: 42,
    savedAt: NOW,
    items: [
      { kind: "user", id: "user-0", seq: 0, text: "帮我画一张图" },
      { kind: "assistant", id: "assistant-1", seq: 1, text: "好的", streaming: false },
    ] as AgentTranscriptItem[],
    ...overrides,
  };
}

/** 直接塞一段裸 json 进存档位，用来测坏数据。 */
function seedRaw(storage: MemoryStorage, payload: unknown) {
  storage.setItem(AGENT_CHAT_STORAGE_KEY, typeof payload === "string" ? payload : JSON.stringify(payload));
}

// ─────────────────────────── 基础往返

test("保存后能完整读回：sessionId / lastEventId / items 原样还原", () => {
  const storage = new MemoryStorage();
  assert.equal(savePersistedSnapshot(storage, snap(), NOW), true);

  const loaded = loadPersistedSnapshot(storage, NOW + 1000);
  assert.ok(loaded);
  assert.equal(loaded.sessionId, "sess-abc123");
  assert.equal(loaded.lastEventId, 42);
  assert.equal(loaded.savedAt, NOW);
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0]?.kind, "user");
  assert.equal((loaded.items[0] as { text: string }).text, "帮我画一张图");
  assert.equal(loaded.items[1]?.kind, "assistant");
  assert.equal((loaded.items[1] as { text: string }).text, "好的");
});

// ─────────────────────────── 坏 json / schema / 异常读取

test("没有存档时回 null", () => {
  assert.equal(loadPersistedSnapshot(new MemoryStorage(), NOW), null);
});

test("坏 json 当作没有存档，不 throw", () => {
  const storage = new MemoryStorage();
  seedRaw(storage, "{ not valid json !!");
  assert.equal(loadPersistedSnapshot(storage, NOW), null);
});

test("schema 不符一律当作没有存档", () => {
  const cases: Array<[string, unknown]> = [
    ["items 不是数组", { version: 1, sessionId: "s", lastEventId: 1, savedAt: NOW, items: { a: 1 } }],
    ["version 不符", { version: 999, sessionId: "s", lastEventId: 1, savedAt: NOW, items: [] }],
    ["sessionId 不是字符串", { version: 1, sessionId: 123, lastEventId: 1, savedAt: NOW, items: [] }],
    ["lastEventId 为负", { version: 1, sessionId: "s", lastEventId: -3, savedAt: NOW, items: [] }],
    ["savedAt 不是数字", { version: 1, sessionId: "s", lastEventId: 1, savedAt: "yesterday", items: [] }],
    ["条目缺 seq", { version: 1, sessionId: "s", lastEventId: 1, savedAt: NOW, items: [{ id: "a", kind: "user" }] }],
    ["条目 kind 未知", { version: 1, sessionId: "s", lastEventId: 1, savedAt: NOW, items: [{ id: "a", kind: "x", seq: 0 }] }],
  ];
  for (const [label, payload] of cases) {
    const storage = new MemoryStorage();
    seedRaw(storage, payload);
    assert.equal(loadPersistedSnapshot(storage, NOW), null, `${label} 应当作没有存档`);
  }
});

test("localStorage 抛异常时读写都不 throw", () => {
  const readBlocked = new MemoryStorage();
  readBlocked.throwOnGet = true;
  assert.doesNotThrow(() => loadPersistedSnapshot(readBlocked, NOW));
  assert.equal(loadPersistedSnapshot(readBlocked, NOW), null);

  const writeBlocked = new MemoryStorage();
  writeBlocked.throwOnSet = true;
  assert.doesNotThrow(() => savePersistedSnapshot(writeBlocked, snap(), NOW));
  assert.equal(savePersistedSnapshot(writeBlocked, snap(), NOW), false);
});

// ─────────────────────────── 存活时限（对齐网关 30 分钟回收线）

test("超过 30 分钟就过期，load 直接回 null", () => {
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, snap(), NOW);
  assert.equal(loadPersistedSnapshot(storage, NOW + AGENT_CHAT_RECLAIM_MS + 1_000), null);
});

test("正好踩在 30 分钟线上（未超时）仍可读", () => {
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, snap(), NOW);
  assert.notEqual(loadPersistedSnapshot(storage, NOW + AGENT_CHAT_RECLAIM_MS), null);
});

test("isPersistedExpired 以 30 分钟为界，不含等号", () => {
  assert.equal(isPersistedExpired(NOW, NOW + AGENT_CHAT_RECLAIM_MS), false);
  assert.equal(isPersistedExpired(NOW, NOW + AGENT_CHAT_RECLAIM_MS + 1), true);
});

// ─────────────────────────── 超量截断

test("只保留最近 MAX_PERSISTED_ITEMS 条，丢的是最旧的", () => {
  const many: AgentTranscriptItem[] = Array.from({ length: 200 }, (_, i) => ({
    kind: "assistant",
    id: `assistant-${i}`,
    seq: i + 1,
    text: String(i),
    streaming: false,
  }));
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, { sessionId: "s", lastEventId: 200, savedAt: NOW, items: many }, NOW);

  const loaded = loadPersistedSnapshot(storage, NOW);
  assert.ok(loaded);
  assert.equal(loaded.items.length, MAX_PERSISTED_ITEMS);
  assert.equal(loaded.items[0]?.id, `assistant-${200 - MAX_PERSISTED_ITEMS}`);
  assert.equal(loaded.items[loaded.items.length - 1]?.id, "assistant-199");
});

test("truncateItems 对不足上限的数组原样返回", () => {
  const few = sanitizeItemsForStorage([{ kind: "user", id: "u", seq: 0, text: "hi" }] as AgentTranscriptItem[]);
  assert.equal(truncateItems(few).length, 1);
});

// ─────────────────────────── image 条目瘦身（不许把大字段塞进 5MB 配额）

test("image 条目只留 id/seq/url/costCoins，taskId 这类大字段不落盘", () => {
  const img: AgentTranscriptItem = {
    kind: "image",
    id: "image-9",
    seq: 9,
    url: "https://example.invalid/image/9.png",
    costCoins: 0.5,
    taskId: "非常长的 task id，可能携带大串内容",
  };
  const slim = sanitizeItemsForStorage([img]);
  assert.equal(slim.length, 1);
  const s = slim[0] as { kind: string; url: string; costCoins?: number };
  assert.equal(s.kind, "image");
  assert.equal(s.url, img.url);
  assert.equal(s.costCoins, 0.5);
  assert.equal(Object.prototype.hasOwnProperty.call(s, "taskId"), false);
});

test("瘦身后的 image 条目往返一致", () => {
  const storage = new MemoryStorage();
  const img: AgentTranscriptItem = {
    kind: "image",
    id: "image-9",
    seq: 9,
    url: "https://example.invalid/image/9.png",
    costCoins: 0.5,
  };
  savePersistedSnapshot(storage, { sessionId: "s", lastEventId: 9, savedAt: NOW, items: [img] }, NOW);

  const loaded = loadPersistedSnapshot(storage, NOW);
  assert.ok(loaded);
  assert.equal(loaded.items.length, 1);
  const back = loaded.items[0] as { url: string; costCoins?: number };
  assert.equal(back.url, img.url);
  assert.equal(back.costCoins, 0.5);
});

// ─────────────────────────── 清除

test("clearPersistedSnapshot 删除存档，且对不存在的 key 幂等", () => {
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, snap(), NOW);
  assert.equal(clearPersistedSnapshot(storage), true);
  assert.equal(loadPersistedSnapshot(storage, NOW), null);
  assert.doesNotThrow(() => clearPersistedSnapshot(storage));
});

// ─────────────────────────── 存档位契约

test("存档写在约定的 key 上，并带版本号", () => {
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, snap(), NOW);
  const raw = storage.getItem(AGENT_CHAT_STORAGE_KEY);
  assert.ok(raw, "必须写在 AGENT_CHAT_STORAGE_KEY 上");
  assert.equal((JSON.parse(raw) as { version: number }).version, 1);
});

test("savedAt 由 save 以调用时刻覆写，不采信入参", () => {
  const storage = new MemoryStorage();
  savePersistedSnapshot(storage, snap({ savedAt: 1 }), NOW);
  const loaded = loadPersistedSnapshot(storage, NOW);
  assert.equal(loaded?.savedAt, NOW);
});
