// B 端 API key 画布产线写入通道的真行为测试。
//
// 验的是「route 真的落到既有实现」而不是「route 存在」：
//   · 未带 key → 401（正负对照：带 key 才进下一关）。
//   · 带 key 但跨 owner → 404，且被害者的画布一字未动（读回真专案比对）。
//   · 正常路径：回退真的改了节点内容并 append 一版；套用 ops 真的在专案留下编译器
//     确定性 id 的节点（oracle = 编译器自己的 workflowNodeId，独立于本 route）。
//
// 证人（独立来源）：`readCanvasProject` 读回的是落盘后的专案，不是 route 的回包字串。

process.env.NODE_ENV = "test"; // 无物件储存后端时允许记忆体降级（blob-backend 的既有契约）

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

/** 只有一个文本节点、带两版内容历史的画布（回退测试用）。 */
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

// ─────────────────────────────────────────── ① 未带 key 被拒

test("未带 key：回退与套用 ops 两条 B 端通道一律 401，且不触任何画布", async () => {
  const revert = await revertPOST(req("/api/v1/canvas/nodes/n1/revert", { body: { projectId: "p" } }), nodeParams("n1"));
  assert.equal(revert.status, 401);
  assert.equal(((await revert.json()) as { code?: string }).code, "missing_api_key");

  const apply = await workflowPOST(req("/api/v1/canvas/workflow", { body: { projectId: "p", source: { workflow: "d", steps: [{ id: "a", title: "A" }] } } }));
  assert.equal(apply.status, 401);
  assert.equal(((await apply.json()) as { code?: string }).code, "missing_api_key");
});

// ─────────────────────────────────────────── ② 带 key 但跨 owner 被拒

test("跨 owner：A 的 key 改不到 B 的画布（404），且 B 的画布一字未动", async () => {
  await saveCanvasProject(USER_B, projectWithVersions("proj-b"));
  await saveCanvasProject(USER_B, emptyProject("proj-b-empty"));

  // 回退：A 带 B 的 projectId
  const revert = await revertPOST(
    req("/api/v1/canvas/nodes/n1/revert", { headers: AUTH_A, body: { projectId: "proj-b", version: 1 } }),
    nodeParams("n1"),
  );
  assert.equal(revert.status, 404);
  assert.equal(((await revert.json()) as { code?: string }).code, "revert_target_missing");

  // 套用 ops：A 带 B 的 projectId
  const apply = await workflowPOST(
    req("/api/v1/canvas/workflow", {
      headers: AUTH_A,
      body: { projectId: "proj-b-empty", source: { workflow: "demo", steps: [{ id: "script", title: "脚本" }] } },
    }),
  );
  assert.equal(apply.status, 404);
  assert.equal(((await apply.json()) as { code?: string }).code, "canvas_project_not_found");

  // 被害者画布不变（真读回比对，不是看 route 回包）
  const victim = await readCanvasProject(USER_B, "proj-b");
  assert.equal(victim?.nodes[0]?.title, "新标题", "B 的节点标题不得被 A 的回退改动");
  assert.equal(victim?.nodeVersions?.length, 2, "B 的版本史不得被追加");
  const victimEmpty = await readCanvasProject(USER_B, "proj-b-empty");
  assert.equal(victimEmpty?.nodes.length, 0, "B 的空画布不得被 A 套入节点");
});

// ─────────────────────────────────────────── ③ 正常路径：回退

test("正常路径：A 回退自己的节点到 v1，落地标题回旧值并 append 一版 reason=revert", async () => {
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
  assert.equal(stored?.nodes[0]?.title, "旧标题", "落盘后的节点标题必须是旧版");
  assert.equal(stored?.nodeVersions?.length, 3, "回退本身也落一版");
});

// ─────────────────────────────────────────── ④ 正常路径：套用 ops（端到端编译→落图）

test("正常路径：A 用 DSL 写入自己的画布，专案真的出现编译器确定性 id 的节点与连线", async () => {
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
  // oracle = 编译器自己的确定性 id 函式（独立于本 route）
  assert.ok(ids.includes(workflowNodeId("demo", "script")), `缺 script 节点：${JSON.stringify(ids)}`);
  assert.ok(ids.includes(workflowNodeId("demo", "shot1")), `缺 shot1 节点：${JSON.stringify(ids)}`);
  assert.equal(stored?.connections.length, 1, "needs 应落一条连线");
  assert.ok((stored?.nodeVersions?.length ?? 0) >= 2, "新增节点应各落一版内容");
});

// ─────────────────────────────────────────── ⑤ 编译失败不落图

test("DSL 非法：422 workflow_dsl_invalid，画布不动（失败语义与纯编译端点一致）", async () => {
  await saveCanvasProject(USER_A, emptyProject("proj-a3"));
  const res = await workflowPOST(
    req("/api/v1/canvas/workflow", { headers: AUTH_A, body: { projectId: "proj-a3", source: { workflow: "demo", steps: [] } } }),
  );
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { code?: string }).code, "workflow_dsl_invalid");
  const stored = await readCanvasProject(USER_A, "proj-a3");
  assert.equal(stored?.nodes.length, 0, "非法 DSL 不得落任何节点");
});
