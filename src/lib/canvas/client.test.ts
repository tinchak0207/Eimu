// 画布 client 403 露出（片P 刀 3）的真行为断言。
//
// 姿势：`LOCAL_TEST_MODE` 让 authHeaders() 回假头（不需要 localStorage/window），
// 再以 fetch stub 喂真实 HTTP 回应，断言的是 client 回传的 reason/message——
// 不是源码字串。
//
// 覆盖：
//   ① 403 + code=member_canvas_forbidden → reason=team_canvas_forbidden，且带服务端团队文案
//   ② 403 无此 code（其他 403 场景）→ 维持原降级 reason=not_authenticated（不扩散）
//   ③ 401 → 维持 not_authenticated
//   ④ 200 → ok，不受影响

import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProject } from "./types";

const TEAM_MESSAGE = "只有团队创建者或管理员可以创建共享画布，请联系团队管理员开启「成员创建画布」权限。";

function project(): CanvasProject {
  return {
    id: "p-1",
    title: "测试",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
  };
}

async function withFetchStub(
  status: number,
  body: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previousMode = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = "true";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
    else process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = previousMode;
  }
}

test("① 403 code=member_canvas_forbidden → reason=team_canvas_forbidden 且露出团队文案", async () => {
  await withFetchStub(403, { success: false, error: TEAM_MESSAGE, code: "member_canvas_forbidden" }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, false);
    assert.equal(res.reason, "team_canvas_forbidden", "不得再被降级成 not_authenticated（＝offline）");
    assert.equal(res.message, TEAM_MESSAGE);
  });
});

test("② 其他 403（无此 code）→ 维持原降级 not_authenticated（不扩散）", async () => {
  await withFetchStub(403, { success: false, error: "无权限", code: "forbidden" }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_authenticated");
  });
  // 连 code 栏位都没有（旧回应形）也一样。
  await withFetchStub(403, { success: false, error: "无权限" }, async () => {
    const { saveCanvasProject } = await import("./client");
    assert.equal((await saveCanvasProject(project())).reason, "not_authenticated");
  });
});

test("③ 401 → 维持 not_authenticated", async () => {
  await withFetchStub(401, { success: false, error: "未登入", code: "unauthorized" }, async () => {
    const { saveCanvasProject } = await import("./client");
    assert.equal((await saveCanvasProject(project())).reason, "not_authenticated");
  });
});

test("④ 200 → ok（既有成功路径不受影响）", async () => {
  await withFetchStub(200, { success: true }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, true);
    assert.equal(res.data, true);
  });
});
