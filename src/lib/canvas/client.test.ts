// 畫布 client 403 露出（片P 刀 3）的真行為斷言。
//
// 姿勢：`LOCAL_TEST_MODE` 讓 authHeaders() 回假頭（不需要 localStorage/window），
// 再以 fetch stub 餵真實 HTTP 回應，斷言的是 client 回傳的 reason/message——
// 不是源碼字串。
//
// 覆蓋：
//   ① 403 + code=member_canvas_forbidden → reason=team_canvas_forbidden，且帶服務端團隊文案
//   ② 403 無此 code（其他 403 場景）→ 維持原降級 reason=not_authenticated（不擴散）
//   ③ 401 → 維持 not_authenticated
//   ④ 200 → ok，不受影響

import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProject } from "./types";

const TEAM_MESSAGE = "只有团队创建者或管理员可以创建共享画布，请联系团队管理员开启「成员创建画布」权限。";

function project(): CanvasProject {
  return {
    id: "p-1",
    title: "測試",
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

test("① 403 code=member_canvas_forbidden → reason=team_canvas_forbidden 且露出團隊文案", async () => {
  await withFetchStub(403, { success: false, error: TEAM_MESSAGE, code: "member_canvas_forbidden" }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, false);
    assert.equal(res.reason, "team_canvas_forbidden", "不得再被降級成 not_authenticated（＝offline）");
    assert.equal(res.message, TEAM_MESSAGE);
  });
});

test("② 其他 403（無此 code）→ 維持原降級 not_authenticated（不擴散）", async () => {
  await withFetchStub(403, { success: false, error: "無權限", code: "forbidden" }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_authenticated");
  });
  // 連 code 欄位都沒有（舊回應形）也一樣。
  await withFetchStub(403, { success: false, error: "無權限" }, async () => {
    const { saveCanvasProject } = await import("./client");
    assert.equal((await saveCanvasProject(project())).reason, "not_authenticated");
  });
});

test("③ 401 → 維持 not_authenticated", async () => {
  await withFetchStub(401, { success: false, error: "未登入", code: "unauthorized" }, async () => {
    const { saveCanvasProject } = await import("./client");
    assert.equal((await saveCanvasProject(project())).reason, "not_authenticated");
  });
});

test("④ 200 → ok（既有成功路徑不受影響）", async () => {
  await withFetchStub(200, { success: true }, async () => {
    const { saveCanvasProject } = await import("./client");
    const res = await saveCanvasProject(project());
    assert.equal(res.ok, true);
    assert.equal(res.data, true);
  });
});
