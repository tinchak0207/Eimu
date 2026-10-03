// B 端 API key 的「列出本账号畫布项目」端點（GET /api/v1/canvas/projects）真行為測試。
//
// 驗的是「route 真的只回本 key 帳號的專案」而不是「route 存在」：
//   · 未帶 key → 401（正負對照：帶 key 才進下一關）。
//   · A 的 key 看不到 B 的專案（owner 隔離）——證人＝落盤後再用 B 的 key 讀回比對。
//   · 正常路徑：回摘要欄位（id/title/createdAt/updatedAt/nodeCount），不回節點內容。

process.env.NODE_ENV = "test"; // 無物件儲存後端時允許記憶體降級（blob-backend 的既有契約）

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { __resetCanvasStoreForTests, saveCanvasProject } from "@/lib/canvas/project-store";
import type { CanvasProject } from "@/lib/canvas/types";
import { GET } from "./route";

const KEY_A = `sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`;
const KEY_B = `sk-biz-${"b1b2c3d4e5f60718".repeat(2)}`;
const USER_A = 8101;
const USER_B = 8102;

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

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/canvas/projects", { method: "GET", headers: new Headers(headers) });
}

function project(id: string, title: string, nodeCount: number): CanvasProject {
  return {
    id,
    title,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `${id}-n${i}`,
      type: "text" as const,
      title: `节点 ${i}`,
      position: { x: 0, y: 0 },
      width: 200,
      height: 100,
      metadata: {},
    })),
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

test("未帶 key：401，不回任何專案", async () => {
  const res = await GET(req());
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code?: string }).code, "missing_api_key");
});

test("owner 隔離：A 的 key 只看到自己的專案，看不到 B 的（結構性、無 leak）", async () => {
  await saveCanvasProject(USER_A, project("proj-a", "A 的画布", 3));
  await saveCanvasProject(USER_B, project("proj-b", "B 的画布", 5));

  const resA = await GET(req({ authorization: `Bearer ${KEY_A}` }));
  assert.equal(resA.status, 200);
  const bodyA = (await resA.json()) as {
    success: boolean;
    count: number;
    projects: Array<{ id: string; title: string; createdAt: string; updatedAt: string; nodeCount: number }>;
  };
  assert.equal(bodyA.success, true);
  assert.equal(bodyA.count, 1);
  assert.deepEqual(bodyA.projects.map((p) => p.id), ["proj-a"]);
  // 摘要欄位齊全且不洩漏節點內容。
  const summary = bodyA.projects[0];
  assert.equal(summary.title, "A 的画布");
  assert.equal(summary.nodeCount, 3);
  assert.equal(typeof summary.createdAt, "string");
  assert.equal(typeof summary.updatedAt, "string");
  assert.equal("nodes" in summary, false, "摘要不得回節點內容");
  assert.equal(JSON.stringify(bodyA).includes("B 的画布"), false, "A 的回包不得出現 B 的專案");

  const resB = await GET(req({ authorization: `Bearer ${KEY_B}` }));
  const bodyB = (await resB.json()) as { projects: Array<{ id: string }> };
  assert.deepEqual(bodyB.projects.map((p) => p.id), ["proj-b"]);
});
