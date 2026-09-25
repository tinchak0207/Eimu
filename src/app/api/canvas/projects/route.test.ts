// REQ-B2-2 生成注入閘的接線守門件（**源碼層變更探針，不計入「已驗證」**，口徑見 TG-02）。
//
// 為何只能走源碼層：本路由用 requireVerifiedUser（要打上游 /api/user/self 驗身分），離線測不起來。
// 真正的**行為**斷言在 `src/lib/asset-library.test.ts`（filterCardIdsForProject 逐條實測）
// 與 `src/lib/storyboard-contract.test.ts`（注入端逐條實測）；本檔只釘住「路由確實把閘接上、
// 且閘在落庫之前」——防的是接線被無聲拆掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTE_PATH = "src/app/api/canvas/projects/route.ts";

function code(relPath: string): string {
  return readFileSync(relPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("画布项目保存：cardIds 先过作用域閘再落库（跨项目未分享的卡不得锁进本项目）", () => {
  const source = code(ROUTE_PATH);
  const gateAt = source.indexOf("filterCardIdsForProject(");
  const saveAt = source.indexOf("saveCanvasProject(");
  assert.ok(gateAt >= 0, "必须调用 filterCardIdsForProject（B2-2 生成卡注入闸）");
  assert.ok(saveAt >= 0, "必须调用 saveCanvasProject");
  assert.ok(gateAt < saveAt, "作用域裁决必须早于落库（否则不可见的卡已被锁进 cardIds）");
  assert.match(source, /\bcardIds\b/);
});

test("画布项目保存：cardIds 非数组时不臆造空集合（缺栏=不覆盖，零回归）", () => {
  const source = code(ROUTE_PATH);
  assert.match(source, /Array\.isArray\(body\.cardIds\)/, "cardIds 只在真的是数组时才过闸/落库");
});
