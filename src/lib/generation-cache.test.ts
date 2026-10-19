import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyGenerationCache,
  mergePersistedHistory,
  readGenerationCache,
  recordGenerationResult,
  selectPersistedHistoryForUser,
  writeGenerationCache,
} from "./generation-cache.ts";

test("recordGenerationResult keeps the latest generated images for the active account", () => {
  const cache = createEmptyGenerationCache();

  const next = recordGenerationResult(cache, {
    userId: 7,
    username: "alice",
    prompt: "make a poster",
    generatedAt: 1000,
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "b64-a", imageUrl: null },
    ],
  });

  assert.equal(next.current.userId, 7);
  assert.equal(next.current.prompt, "make a poster");
  // base64 不落 localStorage（避免生成结束时多 MB 同步 stringify 卡顿），回显走 imageUrl
  assert.equal(next.current.results[0]?.image, null);
  assert.equal(next.historyByUser["7"]?.length, 1);
});

test("recordGenerationResult preserves professional workflow metadata", () => {
  const cache = createEmptyGenerationCache();

  const next = recordGenerationResult(cache, {
    userId: 7,
    username: "alice",
    prompt: "make product variants",
    generatedAt: 1000,
    workflow: {
      schemaVersion: 2,
      contextPrompt: "brand: clean skincare",
      negativePrompt: "no distorted labels",
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      promptHint: "clean product studio",
      negativeHint: "no broken labels",
      estimatedCredits: 3,
      referenceImages: [{ name: "bottle.png", role: "product", size: 1234 }],
      copies: 3,
      concurrency: 2,
    },
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "b64-a", imageUrl: null },
    ],
  });

  assert.equal(next.current.workflow?.workflowPreset, "product-shot");
  assert.equal(next.current.workflow?.schemaVersion, 2);
  assert.equal(next.current.workflow?.workflowPresetLabel, "商品主图");
  assert.equal(next.current.workflow?.estimatedCredits, 3);
  assert.equal(next.current.workflow?.referenceImages?.[0]?.role, "product");
  assert.equal(next.historyByUser["7"]?.[0]?.workflow?.negativePrompt, "no distorted labels");
});

test("recordGenerationResult keeps history isolated by account", () => {
  const cache = createEmptyGenerationCache();

  const withAlice = recordGenerationResult(cache, {
    userId: 7,
    username: "alice",
    prompt: "alice image",
    generatedAt: 1000,
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "alice-b64", imageUrl: null },
    ],
  });

  const withBob = recordGenerationResult(withAlice, {
    userId: 8,
    username: "bob",
    prompt: "bob image",
    generatedAt: 2000,
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "bob-b64", imageUrl: null },
    ],
  });

  assert.equal(withBob.historyByUser["7"]?.[0]?.prompt, "alice image");
  assert.equal(withBob.historyByUser["8"]?.[0]?.prompt, "bob image");
  assert.equal(selectPersistedHistoryForUser(withBob, 7).length, 1);
  assert.equal(selectPersistedHistoryForUser(withBob, 8).length, 1);
});

test("mergePersistedHistory keeps local entries first and strips image payloads", () => {
  const cache = recordGenerationResult(createEmptyGenerationCache(), {
    userId: 7,
    username: "alice",
    prompt: "cached prompt",
    generatedAt: 1000,
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "cached-b64", imageUrl: null },
    ],
  });

  const merged = mergePersistedHistory(cache, 7, [
    {
      id: "upstream-1",
      prompt: "server prompt",
      generatedAt: 900,
      results: [],
      source: "server",
    },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.prompt, "cached prompt");
  assert.equal(merged[0]?.results[0]?.image, null);
  assert.equal(merged[1]?.source, "server");
});

test("writeGenerationCache does not let localStorage quota failures interrupt generation", () => {
  const writes: string[] = [];
  const localStorage = {
    getItem: () => null,
    setItem: (_key: string, value: string) => {
      writes.push(value);
      if (writes.length === 1) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
    },
  };
  globalThis.window = { localStorage } as Window & typeof globalThis;

  const cache = recordGenerationResult(createEmptyGenerationCache(), {
    userId: 7,
    username: "alice",
    prompt: "large image",
    generatedAt: 3000,
    results: [
      { provider: "image_eimu", modelId: "gpt-image-2", image: "x".repeat(1000), imageUrl: null },
    ],
  });

  assert.doesNotThrow(() => writeGenerationCache(cache));
  const saved = JSON.parse(writes.at(-1) ?? "{}");
  assert.equal(saved.current.results[0].image, null);
  assert.equal(saved.historyByUser["7"][0].results[0].image, null);

  delete (globalThis as { window?: Window }).window;
});

test("readGenerationCache 对结构损坏的载荷返回空缓存，而不是让调用方崩掉", () => {
  // 语法合法但结构不对的载荷曾经会被原样返回，
  // 随后 cache.historyByUser[userId] 抛 TypeError，把整个历史页带崩。
  const corrupted = [
    "null",
    "[]",
    '"a string"',
    "42",
    '{"current":null}',                      // 缺 historyByUser
    '{"historyByUser":[]}',                  // historyByUser 是数组
    '{"historyByUser":{"7":"not-an-array"}}',
    "{not json at all",
  ];

  for (const raw of corrupted) {
    globalThis.window = {
      localStorage: { getItem: () => raw, setItem: () => {}, removeItem: () => {} },
    } as unknown as Window & typeof globalThis;

    const cache = readGenerationCache();
    assert.deepEqual(cache.historyByUser, {}, `载荷 ${raw} 应当被当作空缓存`);
    assert.equal(cache.current, null);
    assert.doesNotThrow(() => selectPersistedHistoryForUser(cache, 7));
  }

  delete (globalThis as { window?: Window }).window;
});

test("readGenerationCache 丢掉损坏的条目但保留同一桶里的好条目", () => {
  const payload = JSON.stringify({
    current: null,
    historyByUser: {
      "7": [
        { id: "good", prompt: "p", generatedAt: 1, results: [], source: "local" },
        { id: 42, results: [] },      // id 不是字符串
        { prompt: "no id", results: [] },
        { id: "no-results" },          // 缺 results
        null,
      ],
    },
  });

  globalThis.window = {
    localStorage: { getItem: () => payload, setItem: () => {}, removeItem: () => {} },
  } as unknown as Window & typeof globalThis;

  const entries = selectPersistedHistoryForUser(readGenerationCache(), 7);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "good");

  delete (globalThis as { window?: Window }).window;
});

test("readGenerationCache 在 localStorage 直接抛异常时也不炸（Safari 无痕模式）", () => {
  globalThis.window = {
    localStorage: {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    },
  } as unknown as Window & typeof globalThis;

  assert.doesNotThrow(() => readGenerationCache());
  assert.deepEqual(readGenerationCache().historyByUser, {});

  delete (globalThis as { window?: Window }).window;
});
