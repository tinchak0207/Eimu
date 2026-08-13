import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

test("image generation hook persists and restores the latest result cache", () => {
  const source = read("src/hooks/use-image-generation.ts");
  assert.match(source, /readGenerationCache/);
  assert.match(source, /writeGenerationCache/);
  assert.match(source, /recordGenerationResult/);
});

test("history page merges persisted image history with server records", () => {
  // 归并逻辑现在住在共享 store 里（/history 页和工作站侧栏共用同一份数据），
  // 所以断言要落在真正干活的模块上。只在 HistoryClient 里正则匹配符号名的话，
  // 光凭一句注释就能让测试变绿 —— 那种测试删掉整个功能也照样通过。
  const store = read("src/lib/history-client-store.ts").replace(/\/\/.*$/gm, "");
  assert.match(store, /readGenerationCache/, "必须读取 localStorage 缓存");
  assert.match(store, /selectPersistedHistoryForUser/, "必须按当前账号取本地记录");
  assert.match(store, /mergeHistoryEntries\(\s*serverEntries,\s*readLocalEntries\(/, "服务端记录与本地缓存必须归并");

  // 页面本身要接到这个 store 上，而不是自己再抓一遍数据。
  const page = read("src/components/HistoryClient.tsx");
  assert.match(page, /useHistoryStore/);

  // 只存在于本机、服务端还没落盘的记录要有可见标识。
  assert.match(read("src/components/history/HistoryCard.tsx"), /本地缓存/);
});

test("跨源归并能把同一次生成认成一条，而不是渲染三遍", () => {
  // 本地缓存 id 是 `${userId}-${客户端 Date.now()}`，服务端 id 是 `${userId}-${服务端 Date.now()}`，
  // 两个时刻不同 —— 只按 id 去重的话同一次生成会重复出现。
  const types = read("src/lib/history-types.ts");
  assert.match(types, /HISTORY_MERGE_TOLERANCE_MS/);
  assert.match(types, /function isSameGeneration/);
  assert.match(types, /promptFingerprint/);
});
