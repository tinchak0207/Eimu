// REQ-B2-2 生成注入闸的接线守门件（**源码层变更探针，不计入「已验证」**，口径见 TG-02）。
//
// 为何只能走源码层：本路由用 requireVerifiedUser（要打上游 /api/user/self 验身分），离线测不起来。
// 真正的**行为**断言在 `src/lib/asset-library.test.ts`（filterCardIdsForProject 逐条实测）
// 与 `src/lib/storyboard-contract.test.ts`（注入端逐条实测）；本档只钉住「路由确实把闸接上、
// 且闸在落库之前」——防的是接线被无声拆掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTE_PATH = "src/app/api/canvas/projects/route.ts";

function code(relPath: string): string {
  return readFileSync(relPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("画布项目保存：cardIds 先过作用域闸再落库（跨项目未分享的卡不得锁进本项目）", () => {
  const source = code(ROUTE_PATH);
  const gateAt = source.indexOf("filterCardIdsForProject(");
  // 落库走带团队闸的 saveCanvasProjectWithTeamGate（片F 面 2 接线）；闸内仍是 saveCanvasProject。
  const saveAt = source.indexOf("saveCanvasProjectWithTeamGate(");
  assert.ok(gateAt >= 0, "必须调用 filterCardIdsForProject（B2-2 生成卡注入闸）");
  assert.ok(saveAt >= 0, "必须调用 saveCanvasProjectWithTeamGate（团队建画布闸 + 落库）");
  assert.ok(gateAt < saveAt, "作用域裁决必须早于落库（否则不可见的卡已被锁进 cardIds）");
  assert.match(source, /\bcardIds\b/);
});

test("画布项目保存：cardIds 非数组时不臆造空集合（缺栏=不覆盖，零回归）", () => {
  const source = code(ROUTE_PATH);
  assert.match(source, /Array\.isArray\(body\.cardIds\)/, "cardIds 只在真的是数组时才过闸/落库");
});
