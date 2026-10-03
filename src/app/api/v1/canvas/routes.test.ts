// B 端 API key 畫布產線寫入通道的真行為測試。
//
// 驗的是「route 真的落到既有實現」而不是「route 存在」：
//   · 未帶 key → 401（正負對照：帶 key 才進下一關）。
//   · 帶 key 但跨 owner → 404，且被害者的畫布一字未動（讀回真專案比對）。
//   · 正常路徑：回退真的改了節點內容並 append 一版；套用 ops 真的在專案留下編譯器
//     確定性 id 的節點（oracle = 編譯器自己的 workflowNodeId，獨立於本 route）。
//
// 證人（獨立來源）：`readCanvasProject` 讀回的是落盤後的專案，不是 route 的回包字串。

process.env.NODE_ENV = "test"; // 無物件儲存後端時允許記憶體降級（blob-backend 的既有契約）

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { readCanvasProject, saveCanvasProject, __resetCanvasStoreForTests } from "@/lib/canvas/project-store";
import { workflowNodeId } from "@/lib/workflow-dsl/compile";
import type { CanvasProject } from "@/lib/canvas/types";
import { POST as revertPOST } from "./nodes/[id]/revert/route";
import { POST as workflowPOST } from "./workflow/route";

const KEY_A = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const KEY_B = `sk-biz-${"b1b2c3d4e5f60718".repeat(2)}`;
const USER_A = 7001;
const USER_B = 7002;
const AUTH_A = { authorization: `Bearer ${KEY_A}` };
const AUTH_B = { authorization: `Bearer ${KEY_B}` };

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.IMAGE_DATA_BASE_URL;
  delete process.env.IMAGE_DATA_API_KEY;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(KEY_A)}:${USER_A},${hashBizApiKey(KEY_B)}:${USER_B}`;
  __resetBizKeyStoreForTests();
  __resetCanvasStoreForTests();
}

function req(url: string, init: { headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const nodeParams = (id: string) => ({ params: Promise.resolve({ id }) });

/** 只有一個文本節點、帶兩版內容歷史的畫布（回退測試用）。 */
function projectWithVersions(id: string): CanvasProject {
  return {
    id,
    title: "回退测试画布",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    nodes: [
      {
        id: "n1",
        type: "text",
        title: "新标题",
        position: { x: 0, y: 0 },
        width: 200,
        height: 100,
        metadata: { prompt: "new" },
      },
    ],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
    nodeVersions: [
      { version: 1, nodeId: "n1", createdAt: "2026-10-01T00:00:00.000Z", reason: "created", title: "旧标题", metadata: { prompt: "old" } },
      { version: 2, nodeId: "n1", createdAt: "2026-10-02T00:00:00.000Z", reason: "edited", title: "新标题", metadata: { prompt: "new" } },
    ],
  };
}

function emptyProject(id: string): CanvasProject {
  return {
    id,
    title: "空画布",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
  };
}

test.beforeEach(reset);
test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
  __resetCanvasStoreForTests();
});

// ─────────────────────────────────────────── ① 未帶 key 被拒

test("未帶 key：回退與套用 ops 兩條 B 端通道一律 401，且不觸任何畫布", async () => {
  const revert = await revertPOST(req("/api/v1/canvas/nodes/n1/revert", { body: { projectId: "p" } }), nodeParams("n1"));
  assert.equal(revert.status, 401);
  assert.equal(((await revert.json()) as { code?: string }).code, "missing_api_key");

  const apply = await workflowPOST(req("/api/v1/canvas/workflow", { body: { projectId: "p", source: { workflow: "d", steps: [{ id: "a", title: "A" }] } } }));
  assert.equal(apply.status, 401);
  assert.equal(((await apply.json()) as { code?: string }).code, "missing_api_key");
});

// ─────────────────────────────────────────── ② 帶 key 但跨 owner 被拒

test("跨 owner：A 的 key 改不到 B 的畫布（404），且 B 的畫布一字未動", async () => {
  await saveCanvasProject(USER_B, projectWithVersions("proj-b"));
  await saveCanvasProject(USER_B, emptyProject("proj-b-empty"));

  // 回退：A 帶 B 的 projectId
  const revert = await revertPOST(
    req("/api/v1/canvas/nodes/n1/revert", { headers: AUTH_A, body: { projectId: "proj-b", version: 1 } }),
    nodeParams("n1"),
  );
  assert.equal(revert.status, 404);
  assert.equal(((await revert.json()) as { code?: string }).code, "revert_target_missing");

  // 套用 ops：A 帶 B 的 projectId
  const apply = await workflowPOST(
    req("/api/v1/canvas/workflow", {
      headers: AUTH_A,
      body: { projectId: "proj-b-empty", source: { workflow: "demo", steps: [{ id: "script", title: "脚本" }] } },
    }),
  );
  assert.equal(apply.status, 404);
  assert.equal(((await apply.json()) as { code?: string }).code, "canvas_project_not_found");

  // 被害者畫布不變（真讀回比對，不是看 route 回包）
  const victim = await readCanvasProject(USER_B, "proj-b");
  assert.equal(victim?.nodes[0]?.title, "新标题", "B 的節點標題不得被 A 的回退改動");
  assert.equal(victim?.nodeVersions?.length, 2, "B 的版本史不得被追加");
  const victimEmpty = await readCanvasProject(USER_B, "proj-b-empty");
  assert.equal(victimEmpty?.nodes.length, 0, "B 的空畫布不得被 A 套入節點");
});

// ─────────────────────────────────────────── ③ 正常路徑：回退

test("正常路徑：A 回退自己的節點到 v1，落地標題回舊值並 append 一版 reason=revert", async () => {
  await saveCanvasProject(USER_A, projectWithVersions("proj-a"));

  const res = await revertPOST(
    req("/api/v1/canvas/nodes/n1/revert", { headers: AUTH_A, body: { projectId: "proj-a", version: 1 } }),
    nodeParams("n1"),
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { success: boolean; node: { title: string }; versions: Array<{ version: number; reason: string }> };
  assert.equal(payload.success, true);
  assert.equal(payload.node.title, "旧标题");
  assert.deepEqual(payload.versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(payload.versions[2].reason, "revert");

  const stored = await readCanvasProject(USER_A, "proj-a");
  assert.equal(stored?.nodes[0]?.title, "旧标题", "落盤後的節點標題必須是舊版");
  assert.equal(stored?.nodeVersions?.length, 3, "回退本身也落一版");
});

// ─────────────────────────────────────────── ④ 正常路徑：套用 ops（端到端編譯→落圖）

test("正常路徑：A 用 DSL 寫入自己的畫布，專案真的出現編譯器確定性 id 的節點與連線", async () => {
  await saveCanvasProject(USER_A, emptyProject("proj-a2"));

  const source = {
    workflow: "demo",
    title: "两步产线",
    steps: [
      { id: "script", title: "脚本", kind: "text", prompt: "三幕大纲" },
      { id: "shot1", title: "镜头一", needs: ["script"], prompt: "夕阳海面" },
    ],
  };
  const res = await workflowPOST(req("/api/v1/canvas/workflow", { headers: AUTH_A, body: { projectId: "proj-a2", source, label: "起两条" } }));
  assert.equal(res.status, 200, await res.clone().text());
  const payload = (await res.json()) as { success: boolean; applied: number; created_node_ids: string[] };
  assert.equal(payload.success, true);
  assert.ok(payload.applied >= 3, `applied=${payload.applied}`);

  const stored = await readCanvasProject(USER_A, "proj-a2");
  const ids = (stored?.nodes ?? []).map((n) => n.id);
  // oracle = 編譯器自己的確定性 id 函式（獨立於本 route）
  assert.ok(ids.includes(workflowNodeId("demo", "script")), `缺 script 節點：${JSON.stringify(ids)}`);
  assert.ok(ids.includes(workflowNodeId("demo", "shot1")), `缺 shot1 節點：${JSON.stringify(ids)}`);
  assert.equal(stored?.connections.length, 1, "needs 應落一條連線");
  assert.ok((stored?.nodeVersions?.length ?? 0) >= 2, "新增節點應各落一版內容");
});

// ─────────────────────────────────────────── ⑤ 編譯失敗不落圖

test("DSL 非法：422 workflow_dsl_invalid，畫布不動（失敗語義與純編譯端點一致）", async () => {
  await saveCanvasProject(USER_A, emptyProject("proj-a3"));
  const res = await workflowPOST(
    req("/api/v1/canvas/workflow", { headers: AUTH_A, body: { projectId: "proj-a3", source: { workflow: "demo", steps: [] } } }),
  );
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { code?: string }).code, "workflow_dsl_invalid");
  const stored = await readCanvasProject(USER_A, "proj-a3");
  assert.equal(stored?.nodes.length, 0, "非法 DSL 不得落任何節點");
});
