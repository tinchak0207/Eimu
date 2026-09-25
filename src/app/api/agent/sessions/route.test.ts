// REQ-B2-2 agent 資產包注入閘的接線守門件（**源碼層變更探針，不計入「已驗證」**，口徑見 TG-02）。
//
// 為何只能走源碼層：本路由用 resolveAgentCaller（要打網關驗身分），離線測不起來。
// 真正的**行為**斷言在 `src/lib/asset-library.test.ts`（isAssetUsable 逐條實測：
// 跨 project／無項目上下文／跨 owner 一律不可用；個人包零回歸）。本檔只釘住
// 「getActiveAssetPack 的結果確實先過 isAssetUsable 才注入」——防接線被無聲拆掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PATHS = ["src/app/api/agent/sessions/route.ts", "src/app/api/agent/sessions/[id]/memory/route.ts"];

function code(relPath: string): string {
  return readFileSync(relPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("agent 会话注入：active 资产包先过作用域裁决才进 buildAssetPackInjection", () => {
  for (const path of PATHS) {
    const source = code(path);
    const readAt = source.indexOf("getActiveAssetPack(");
    const gateAt = source.indexOf("isAssetUsable(");
    const injectAt = source.indexOf("buildAssetPackInjection(");
    assert.ok(readAt >= 0, `${path} 应读 active 包`);
    assert.ok(gateAt >= 0, `${path} 必须调用 isAssetUsable（B2-2 使用路径裁决）`);
    assert.ok(injectAt >= 0, `${path} 应注入 active 包`);
    assert.ok(gateAt < injectAt, `${path}: 作用域裁决必须早于注入（否则不可见的包被注入）`);
  }
});
