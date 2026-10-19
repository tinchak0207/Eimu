// /api/skills/mine 端点**真行为**测试（2026-09-27 立）。
//
// 手法：直接调 route handler（NextRequest → Response），不是源码字串扫描——
// 依 [[verification-guards-not-oracles-0923]]，源码层守门件只算变更探针。
// 身份走 `resolveAgentCaller` 的 LOCAL_TEST_MODE 通道（env 逐次读取），
// 故可在同一进程内**换身份**：owner A 建的 skill，owner B 一律看不到、删不到
// ＝跨租户隔离的端到端负对照。存储走 store 的进程内兜底（与
// agent-memory-store.test.ts 同款 E2E 路径）。
//
// 另验：公开端点 `GET /api/skills`、`GET /api/skills/<id>` 在本人已建 skill、
// 且已登入的情况下**仍不**把它并进公开集合（这是本片的核心隔离 REQ）。

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { __resetAgentMemoryStoreForTests } from "@/lib/agent-memory-store";
import { DELETE } from "./[id]/route.ts";
import { GET as MINE_GET, POST } from "./route.ts";
import { GET as PUBLIC_GET } from "../route.ts";
import { GET as PUBLIC_BY_ID } from "../[id]/route.ts";

const KEY_A = "test-owner-key-alpha";
const KEY_B = "test-owner-key-beta";

function req(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; rawBody?: string } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body !== undefined || init.rawBody !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** 以指定身份（env 读取在呼叫当下）跑一段；跑完还原环境。 */
async function asIdentity<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  const prevKey = process.env.IMAGE_STUDIO_BIZ_KEY;
  process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = "true";
  if (key === null) delete process.env.IMAGE_STUDIO_BIZ_KEY;
  else process.env.IMAGE_STUDIO_BIZ_KEY = key;
  try {
    return await fn();
  } finally {
    if (prevMode === undefined) delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
    else process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = prevMode;
    if (prevKey === undefined) delete process.env.IMAGE_STUDIO_BIZ_KEY;
    else process.env.IMAGE_STUDIO_BIZ_KEY = prevKey;
  }
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "端点测试技能",
    oneLiner: "端点层的一句话",
    family: "casting",
    useScenario: "端点测试的场景",
    inputType: "一句描述",
    outputContent: "一张成图",
    outputKind: "image",
    toolIds: ["image_generate"],
    tags: ["端点测试"],
    ...overrides,
  };
}

test("未登入（无 LOCAL_TEST_MODE、无凭证）三种方法一律 401，且不写入任何东西", async () => {
  __resetAgentMemoryStoreForTests();
  const prevMode = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  const prevKey = process.env.IMAGE_STUDIO_BIZ_KEY;
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.IMAGE_STUDIO_BIZ_KEY;
  try {
    const get = await MINE_GET(req("/api/skills/mine"));
    assert.equal(get.status, 401, "未登入 GET 应 401");
    const post = await POST(req("/api/skills/mine", { method: "POST", body: draft() }));
    assert.equal(post.status, 401, "未登入 POST 应 401");
    const del = await DELETE(req("/api/skills/mine/user-casting-x", { method: "DELETE" }), {
      params: Promise.resolve({ id: "user-casting-x" }),
    });
    assert.equal(del.status, 401, "未登入 DELETE 应 401");
    assert.deepEqual((await bodyOf(post)).error, "unauthorized");
  } finally {
    if (prevMode !== undefined) process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = prevMode;
    if (prevKey !== undefined) process.env.IMAGE_STUDIO_BIZ_KEY = prevKey;
  }
  __resetAgentMemoryStoreForTests();
});

test("私有 CRUD 端到端：建 → 我的列得到／公开列不到 → 改 → 删；跨身份全 404", async () => {
  __resetAgentMemoryStoreForTests();

  // 建（身份 A）
  const created = await asIdentity(KEY_A, async () => {
    const res = await POST(req("/api/skills/mine", { method: "POST", body: draft() }));
    assert.equal(res.status, 200, `建立应 200：${JSON.stringify(await bodyOf(res.clone?.() ?? res))}`);
    return bodyOf(res);
  });
  const skill = created.skill as { id: string; source: string; oneLiner: string };
  assert.ok(skill?.id?.startsWith("user-casting-"), `id 应为 user-<family>-hash：${skill?.id}`);
  assert.equal(skill.source, "user");
  assert.equal(created.created, true);

  // 我的列得到
  await asIdentity(KEY_A, async () => {
    const res = await MINE_GET(req("/api/skills/mine"));
    const listed = (await bodyOf(res)).skills as { id: string }[];
    assert.deepEqual(listed.map((s) => s.id), [skill.id], "A 应只列到自己的那条");

    // 公开列不到（即使呼叫者已登入）
    const pub = await PUBLIC_GET(req("/api/skills?limit=500"));
    const pubSkills = (await bodyOf(pub)).skills as { id: string; source: string }[];
    assert.equal(pubSkills.some((s) => s.id === skill.id), false, "公开列表不得包含 A 的私有 skill");
    assert.equal(pubSkills.some((s) => s.source === "user"), false, "公开列表不得含任何 user 来源");

    // 公开单条不得以 id 命中他人私有 skill
    const pubById = await PUBLIC_BY_ID(req(`/api/skills/${skill.id}`), {
      params: Promise.resolve({ id: skill.id }),
    });
    assert.equal(pubById.status, 404, "公开单条不得命中私有 skill id");
  });

  // 跨身份：B 看不到、删不到
  await asIdentity(KEY_B, async () => {
    const res = await MINE_GET(req("/api/skills/mine"));
    assert.deepEqual((await bodyOf(res)).skills, [], "B 的私有库必须是空的");
    const del = await DELETE(req(`/api/skills/mine/${skill.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: skill.id }),
    });
    assert.equal(del.status, 404, "删别人的 skill 必须 404（不得用 403 泄漏存在性）");
    assert.equal((await bodyOf(del)).error, "not_found");
  });
  // A 的 skill 仍在（B 的删除尝试无效）
  await asIdentity(KEY_A, async () => {
    const res = await MINE_GET(req("/api/skills/mine"));
    assert.equal(((await bodyOf(res)).skills as unknown[]).length, 1, "B 的删除不得影响 A 的条目");
  });

  // 改（身份 A，带自己的 id）
  await asIdentity(KEY_A, async () => {
    const res = await POST(
      req("/api/skills/mine", { method: "POST", body: draft({ id: skill.id, oneLiner: "改过的一句话" }) }),
    );
    assert.equal(res.status, 200);
    const payload = await bodyOf(res);
    assert.equal(payload.created, false, "带自己的 id 应判为更新");
    assert.equal((payload.skill as { id: string }).id, skill.id);
    assert.equal((payload.skill as { oneLiner: string }).oneLiner, "改过的一句话");
    const listed = (await bodyOf(await MINE_GET(req("/api/skills/mine")))).skills as { id: string }[];
    assert.equal(listed.length, 1, "更新不得长出第二条");
  });

  // 删（身份 A）
  await asIdentity(KEY_A, async () => {
    const del = await DELETE(req(`/api/skills/mine/${skill.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: skill.id }),
    });
    assert.equal(del.status, 200);
    const listed = (await bodyOf(await MINE_GET(req("/api/skills/mine")))).skills as unknown[];
    assert.deepEqual(listed, [], "删除后我的列表应为空");
    // 幂等：再删 404
    const again = await DELETE(req(`/api/skills/mine/${skill.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: skill.id }),
    });
    assert.equal(again.status, 404);
  });

  __resetAgentMemoryStoreForTests();
});

test("端点错误体：非法 JSON 400、无效草稿 400 invalid_skill 且 reason 稳定", async () => {
  __resetAgentMemoryStoreForTests();
  await asIdentity(KEY_A, async () => {
    const badJson = await POST(
      req("/api/skills/mine", { method: "POST", rawBody: "{ not json", headers: { "content-type": "application/json" } }),
    );
    assert.equal(badJson.status, 400);
    assert.equal((await bodyOf(badJson)).error, "invalid_json");

    const invalid = await POST(req("/api/skills/mine", { method: "POST", body: draft({ family: "hollywood" }) }));
    assert.equal(invalid.status, 400);
    const payload = await bodyOf(invalid);
    assert.equal(payload.error, "invalid_skill");
    assert.equal(payload.reason, "family_invalid");
  });
  __resetAgentMemoryStoreForTests();
});
