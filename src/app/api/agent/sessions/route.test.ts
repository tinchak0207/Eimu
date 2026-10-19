// REQ-B2-2 agent 资产包注入闸的接线守门件（**源码层变更探针，不计入「已验证」**，口径见 TG-02）。
//
// 为何只能走源码层：本路由用 resolveAgentCaller（要打网关验身分），离线测不起来。
// 真正的**行为**断言在 `src/lib/asset-library.test.ts`（isAssetUsable 逐条实测：
// 跨 project／无项目上下文／跨 owner 一律不可用；个人包零回归）。本档只钉住
// 「getActiveAssetPack 的结果确实先过 isAssetUsable 才注入」——防接线被无声拆掉。
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
