// `/api/biz/character-cards` 挂载点的断言 = **同一份**共用套件（与 `/v1/character-cards`
// 逐条相同），外加一条跨挂载点等价断言：同一份操作经两条 route 必须得到逐栏相同的结果
// ——证明「两条 route 真的代理到同一行为」，而不是各自长了一套。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { registerBizCharacterCardRouteSuite } from "../../../../lib/biz-character-cards-route-suite";
import { GET as bizGet, POST as bizPost } from "./route";
import { GET as v1Get, POST as v1Post } from "../../v1/character-cards/route";

registerBizCharacterCardRouteSuite("/api/biz/character-cards", { GET: bizGet, POST: bizPost });

interface WireCard {
  id: string;
  name: string;
  kind: string;
  prompt: string;
  reference_urls: string[];
  updated_at: string;
}

/** 卡的业务栏（`updated_at` 是写入时间戳，两次写入必然不同，不参与等价比较）。 */
function businessFields(card: WireCard) {
  return {
    id: card.id,
    name: card.name,
    kind: card.kind,
    prompt: card.prompt,
    reference_urls: card.reference_urls,
  };
}

const AUTH = {
  authorization: `Bearer sk-biz-${"a1b2c3d4e5f60718".repeat(2)}`,
};

function req(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ ...AUTH, ...init.headers });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

test("跨挂载点等价：同 body 经 /api/biz 与 /api/v1 → 存回/读回的业务栏逐栏相同；非法 payload 错误体同形", async () => {
  const body = {
    name: "等价对照卡",
    kind: "prop",
    prompt: "青铜古灯，锈迹斑斑",
    reference_urls: ["https://img.example/lamp.png"],
  };
  const bizSaved = await bizPost(req("/api/biz/character-cards", { method: "POST", body }));
  const v1Saved = await v1Post(req("/v1/character-cards", { method: "POST", body }));
  assert.equal(bizSaved.status, 201);
  assert.equal(v1Saved.status, 201);

  const bizCard = ((await bizSaved.json()) as { data: WireCard }).data;
  const v1Card = ((await v1Saved.json()) as { data: WireCard }).data;
  assert.deepEqual(businessFields(bizCard), businessFields(v1Card), "两条 route 必须铸出逐栏相同的卡");
  assert.ok(!Number.isNaN(Date.parse(bizCard.updated_at)) && !Number.isNaN(Date.parse(v1Card.updated_at)));

  // 读回路径也等价（同一份 store，同一份清洗/投影）
  const bizList = (await (await bizGet(req("/api/biz/character-cards"))).json()) as { object: string; data: WireCard[] };
  const v1List = (await (await v1Get(req("/v1/character-cards"))).json()) as { object: string; data: WireCard[] };
  assert.equal(bizList.object, v1List.object);
  assert.deepEqual(bizList.data.map(businessFields), v1List.data.map(businessFields));
  assert.equal(bizList.data.length, 1, "同 id upsert：两条 route 写的是同一张卡");

  // 负对照：非法 payload 的错误体必须同形（code/type/键集合），否则 agent 侧 classifyError 会分叉
  const bad = { name: "坏卡", reference_urls: ["ftp://x"] };
  const bizBad = await bizPost(req("/api/biz/character-cards", { method: "POST", body: bad }));
  const v1Bad = await v1Post(req("/v1/character-cards", { method: "POST", body: bad }));
  assert.equal(bizBad.status, 400);
  assert.equal(v1Bad.status, 400);
  const bizErr = ((await bizBad.json()) as { error: Record<string, unknown> }).error;
  const v1Err = ((await v1Bad.json()) as { error: Record<string, unknown> }).error;
  assert.equal(bizErr.code, v1Err.code);
  assert.equal(bizErr.type, v1Err.type);
  assert.deepEqual(Object.keys(bizErr).sort(), Object.keys(v1Err).sort());
});
