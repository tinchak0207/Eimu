// `/api/biz/character-cards` 掛載點的斷言 = **同一份**共用套件（與 `/v1/character-cards`
// 逐條相同），外加一條跨掛載點等價斷言：同一份操作經兩條 route 必須得到逐欄相同的結果
// ——證明「兩條 route 真的代理到同一行為」，而不是各自長了一套。
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

/** 卡的業務欄（`updated_at` 是寫入時間戳，兩次寫入必然不同，不參與等價比較）。 */
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

test("跨掛載點等價：同 body 經 /api/biz 與 /api/v1 → 存回/讀回的業務欄逐欄相同；非法 payload 錯誤體同形", async () => {
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
  assert.deepEqual(businessFields(bizCard), businessFields(v1Card), "两条 route 必须铸出逐欄相同的卡");
  assert.ok(!Number.isNaN(Date.parse(bizCard.updated_at)) && !Number.isNaN(Date.parse(v1Card.updated_at)));

  // 讀回路徑也等價（同一份 store，同一份清洗/投影）
  const bizList = (await (await bizGet(req("/api/biz/character-cards"))).json()) as { object: string; data: WireCard[] };
  const v1List = (await (await v1Get(req("/v1/character-cards"))).json()) as { object: string; data: WireCard[] };
  assert.equal(bizList.object, v1List.object);
  assert.deepEqual(bizList.data.map(businessFields), v1List.data.map(businessFields));
  assert.equal(bizList.data.length, 1, "同 id upsert：两条 route 写的是同一张卡");

  // 負對照：非法 payload 的錯誤體必須同形（code/type/鍵集合），否則 agent 側 classifyError 會分叉
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
