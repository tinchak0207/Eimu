// 记忆库端点的 HTTP 行为测试（PRD §9 R6「无签名请求被拒」＋契约 §3 响应形状）。
//
// 行为尺，不是源码字串尺：直接构造 NextRequest 呼叫 route handler。
// 2xx 路径本机 blob 不可达（实测无凭证即刻抛）→ 走 store 的进程内 Map 兜底，
// 照样能端到端验「验签＋snake_case 映射＋响应形状」。密钥逐案设定与还原。

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as ingestPOST } from "./ingest/route";
import { POST as retractPOST } from "./retract/route";
import { POST as reviewPOST } from "./review/route";
import { GET as exportGET } from "./export/route";
import { GET as memoryTraceGET } from "../sessions/[id]/memory-trace/route";
import { MEMORY_SIGNATURE_HEADER, signMemoryBody } from "@/lib/memory-hmac";
import {
  __resetAgentMemoryStoreForTests,
  listMemoryDocs,
} from "@/lib/agent-memory-store";

const SECRET = "route-test-secret-not-real";

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

async function withSecret<T>(secret: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MEMORY_INGEST_SECRET;
  if (secret === undefined) delete process.env.MEMORY_INGEST_SECRET;
  else process.env.MEMORY_INGEST_SECRET = secret;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MEMORY_INGEST_SECRET;
    else process.env.MEMORY_INGEST_SECRET = previous;
  }
}

function postRequest(url: string, bodyText: string, signature?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers[MEMORY_SIGNATURE_HEADER] = signature;
  return new NextRequest(url, { method: "POST", headers, body: bodyText });
}

function getRequest(url: string, signature?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (signature) headers[MEMORY_SIGNATURE_HEADER] = signature;
  return new NextRequest(url, { method: "GET", headers });
}

/** GET 无 body →  gateway 对空 bytes 签；测试同算法。 */
function signEmpty(): string {
  return signMemoryBody(new ArrayBuffer(0), SECRET);
}

const INGEST_BODY = JSON.stringify({
  batch_id: "r-1",
  prompt_version: "v1",
  docs: [
    {
      scope: "private",
      owner_key: "owner-hash-1",
      domain: "电商美妆",
      slug: "route-probe",
      description: "route level snake case mapping probe",
      type: "feedback",
      body: "**Why:** 测试端点\n**How to apply:** 读回栏位",
      links: ["other-note"],
      evidence: "user confirmed in chat",
      evidence_kind: "user_confirmed",
      self_score: 4,
    },
  ],
});

test("ingest：无签名 → 401 {error:unauthorized}", async () => {
  await withSecret(SECRET, async () => {
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest：错签 → 401", async () => {
  await withSecret(SECRET, async () => {
    const forged = signMemoryBody(bytes(INGEST_BODY + "tampered"), SECRET);
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY, forged),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest：有签但密钥未配置 → 401（不放行不崩溃）", async () => {
  const signature = signMemoryBody(bytes(INGEST_BODY), SECRET);
  await withSecret(undefined, async () => {
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY, signature),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest 2xx：有签＋snake_case 映射＋契约 §3.1 响应形状", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const res = await ingestPOST(
      postRequest(
        "http://localhost/api/agent/memory/ingest",
        INGEST_BODY,
        signMemoryBody(bytes(INGEST_BODY), SECRET),
      ),
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      accepted: string[];
      rejected: unknown[];
      stats: { received: number; accepted: number; index_lines: number; seed_accepted: number };
    };
    assert.deepEqual(data.accepted, ["r-1-route-probe"]);
    assert.deepEqual(data.rejected, []);
    assert.deepEqual(data.stats, { received: 1, accepted: 1, index_lines: 1, seed_accepted: 0 });

    // 栏位映射落地检查：owner_key→ownerKey、evidence_kind→evidenceKind、self_score→selfScore。
    const docs = await listMemoryDocs({ scope: "private", ownerKey: "owner-hash-1" });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].evidenceKind, "user_confirmed");
    assert.equal(docs[0].selfScore, 4);
    assert.equal(docs[0].promptVersion, "v1");
    assert.equal(docs[0].revision, 1);
    __resetAgentMemoryStoreForTests();
  });
});

test("ingest：签名正确但 body 非 JSON → 400 invalid_json", async () => {
  const raw = "not-json{{{";
  await withSecret(SECRET, async () => {
    const res = await ingestPOST(
      postRequest(
        "http://localhost/api/agent/memory/ingest",
        raw,
        signMemoryBody(bytes(raw), SECRET),
      ),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_json" });
  });
});

test("retract：无签 401；有签 → {retracted:[id]}（契约 §3.2）", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const unsigned = await retractPOST(
      postRequest("http://localhost/api/agent/memory/retract", JSON.stringify({ batch_id: "r-2" })),
    );
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 先经 ingest 端点写一笔，再按 batch_id 撤回。
    const body = JSON.stringify({
      batch_id: "r-2",
      docs: [
        {
          scope: "shared",
          domain: "测试",
          slug: "to-retract",
          description: "a doc to retract via endpoint",
          type: "domain",
          body: "body",
          evidence: "ev",
          evidence_kind: "verbatim",
          self_score: 5,
        },
      ],
    });
    const ingested = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", body, signMemoryBody(bytes(body), SECRET)),
    );
    assert.equal(ingested.status, 200);

    const retractBody = JSON.stringify({ batch_id: "r-2" });
    const retracted = await retractPOST(
      postRequest(
        "http://localhost/api/agent/memory/retract",
        retractBody,
        signMemoryBody(bytes(retractBody), SECRET),
      ),
    );
    assert.equal(retracted.status, 200);
    assert.deepEqual(await retracted.json(), { retracted: ["r-2-to-retract"] });
    assert.deepEqual(await listMemoryDocs({ scope: "shared" }), []);
    __resetAgentMemoryStoreForTests();
  });
});

test("review：无签 401；action 非法 400；有签 → {reviewed:[ids],action}（PRD §5.6）", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    // 防线同 retract：无签一律 401，先于一切入参校验。
    const unsigned = await reviewPOST(
      postRequest(
        "http://localhost/api/agent/memory/review",
        JSON.stringify({ batch_id: "rv-r", action: "pending_review" }),
      ),
    );
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 有签但 action 缺／非法 → 400 invalid_action（不落 store）。
    const badActionRaw = JSON.stringify({ batch_id: "rv-r", action: "delete_everything" });
    const badAction = await reviewPOST(
      postRequest(
        "http://localhost/api/agent/memory/review",
        badActionRaw,
        signMemoryBody(bytes(badActionRaw), SECRET),
      ),
    );
    assert.equal(badAction.status, 400);
    assert.deepEqual(await badAction.json(), { error: "invalid_action" });

    // 2xx 端到端：先 ingest 一条 shared，再按 batch_id 转 pending_review。
    // shared 自 4ea47695 起 fail-closed：必须带 contributor_key 且过佐证门槛才 active，
    // 这里用运营旋钮把门槛降到 1（与 store 测试的 corroborationMin: 1 同口径，不改生产默认）。
    const body = JSON.stringify({
      batch_id: "rv-r",
      docs: [
        {
          scope: "shared",
          domain: "测试",
          slug: "to-review",
          description: "a doc to flip pending_review via endpoint",
          type: "domain",
          body: "body",
          evidence: "ev",
          evidence_kind: "verbatim",
          self_score: 5,
          contributor_key: "owner-hash-1",
        },
      ],
    });
    const previousMin = process.env.MEMORY_SHARED_CORROBORATION_MIN;
    process.env.MEMORY_SHARED_CORROBORATION_MIN = "1";
    try {
      const ingested = await ingestPOST(
        postRequest("http://localhost/api/agent/memory/ingest", body, signMemoryBody(bytes(body), SECRET)),
      );
      assert.equal(ingested.status, 200);
      // 控制组：文档必须真的 active，否则下面的翻转只是在空集上「成功」。
      assert.deepEqual(
        (await listMemoryDocs({ scope: "shared" })).map((doc) => doc.status),
        ["active"],
      );

      const reviewRaw = JSON.stringify({ batch_id: "rv-r", action: "pending_review" });
      const res = await reviewPOST(
        postRequest(
          "http://localhost/api/agent/memory/review",
          reviewRaw,
          signMemoryBody(bytes(reviewRaw), SECRET),
        ),
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        reviewed: ["rv-r-to-review"],
        action: "pending_review",
        blocked: [],
      });
      assert.deepEqual(await listMemoryDocs({ scope: "shared" }), []);

      // 回程：pending_review → active（人工放行），验证真是双向翻转而非只改期望。
      const activateRaw = JSON.stringify({ batch_id: "rv-r", action: "activate" });
      const activated = await reviewPOST(
        postRequest(
          "http://localhost/api/agent/memory/review",
          activateRaw,
          signMemoryBody(bytes(activateRaw), SECRET),
        ),
      );
      assert.equal(activated.status, 200);
      assert.deepEqual(await activated.json(), {
        reviewed: ["rv-r-to-review"],
        action: "activate",
        blocked: [],
      });
      const restored = await listMemoryDocs({ scope: "shared" });
      assert.equal(restored.length, 1);
      assert.equal(restored[0].status, "active");
    } finally {
      if (previousMin === undefined) delete process.env.MEMORY_SHARED_CORROBORATION_MIN;
      else process.env.MEMORY_SHARED_CORROBORATION_MIN = previousMin;
    }
    __resetAgentMemoryStoreForTests();
  });
});

test("export：GET 对空 bytes 验签——无签 401、非空 bytes 签 401、空 bytes 签 200", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const url = "http://localhost/api/agent/memory/export?scope=shared";
    const unsigned = await exportGET(getRequest(url));
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 常见错法：拿「某个 body」的签来验 GET（GET 真义是空 bytes）。
    const wrongScope = await exportGET(
      getRequest(url, signMemoryBody(bytes("scope=shared"), SECRET)),
    );
    assert.equal(wrongScope.status, 401);

    const ok = await exportGET(getRequest(url, signEmpty()));
    assert.equal(ok.status, 200);
    const data = (await ok.json()) as { docs: unknown[]; index_md: string; generated_at: string };
    assert.deepEqual(data.docs, []);
    assert.equal(data.index_md, "");
    assert.match(data.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("export private：owner_key 过滤；缺 owner_key 回空；只含 active", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const body = JSON.stringify({
      batch_id: "r-3",
      docs: [
        {
          scope: "private",
          owner_key: "owner-x",
          domain: "日本动漫",
          slug: "mine",
          description: "private doc for owner x",
          type: "user",
          body: "b",
          evidence: "e",
          evidence_kind: "tool_result",
          self_score: 3,
        },
        {
          scope: "private",
          owner_key: "owner-y",
          domain: "日本动漫",
          slug: "theirs",
          description: "private doc for owner y",
          type: "user",
          body: "b",
          evidence: "e",
          evidence_kind: "tool_result",
          self_score: 3,
        },
      ],
    });
    const ingested = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", body, signMemoryBody(bytes(body), SECRET)),
    );
    assert.equal(ingested.status, 200);
    assert.equal(((await ingested.json()) as { accepted: string[] }).accepted.length, 2);

    const ok = await exportGET(
      getRequest(
        "http://localhost/api/agent/memory/export?scope=private&owner_key=owner-x",
        signEmpty(),
      ),
    );
    assert.equal(ok.status, 200);
    const data = (await ok.json()) as { docs: Array<{ slug: string }>; index_md: string };
    assert.deepEqual(data.docs.map((doc) => doc.slug), ["mine"]);
    assert.match(data.index_md, /- \[日本动漫\] mine — private doc for owner x （v1）/);

    const noOwner = await exportGET(
      getRequest("http://localhost/api/agent/memory/export?scope=private", signEmpty()),
    );
    assert.equal(noOwner.status, 200);
    assert.deepEqual(((await noOwner.json()) as { docs: unknown[] }).docs, []);
    __resetAgentMemoryStoreForTests();
  });
});

test("memory-trace：未带 agent 身份 → 401（沿用既有 agent key 认证，非 HMAC 尺）", async () => {
  const res = await memoryTraceGET(
    getRequest("http://localhost/api/agent/sessions/ses_abc/memory-trace"),
    { params: Promise.resolve({ id: "ses_abc" }) },
  );
  assert.equal(res.status, 401);
  const data = (await res.json()) as { success: boolean; code: string };
  assert.equal(data.success, false);
  assert.equal(data.code, "agent_not_signed_in");
});
