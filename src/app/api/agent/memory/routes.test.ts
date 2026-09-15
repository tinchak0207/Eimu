// 記憶庫端點的 HTTP 行為測試（PRD §9 R6「無簽名請求被拒」＋契約 §3 響應形狀）。
//
// 行為尺，不是源碼字串尺：直接構造 NextRequest 呼叫 route handler。
// 2xx 路徑本機 blob 不可達（實測無憑證即刻拋）→ 走 store 的進程內 Map 兜底，
// 照样能端到端驗「驗簽＋snake_case 映射＋響應形狀」。密鑰逐案設定與還原。

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

/** GET 無 body →  gateway 對空 bytes 簽；測試同算法。 */
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
      domain: "電商美妝",
      slug: "route-probe",
      description: "route level snake case mapping probe",
      type: "feedback",
      body: "**Why:** 測試端點\n**How to apply:** 讀回欄位",
      links: ["other-note"],
      evidence: "user confirmed in chat",
      evidence_kind: "user_confirmed",
      self_score: 4,
    },
  ],
});

test("ingest：無簽名 → 401 {error:unauthorized}", async () => {
  await withSecret(SECRET, async () => {
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest：錯簽 → 401", async () => {
  await withSecret(SECRET, async () => {
    const forged = signMemoryBody(bytes(INGEST_BODY + "tampered"), SECRET);
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY, forged),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest：有簽但密鑰未配置 → 401（不放行不崩潰）", async () => {
  const signature = signMemoryBody(bytes(INGEST_BODY), SECRET);
  await withSecret(undefined, async () => {
    const res = await ingestPOST(
      postRequest("http://localhost/api/agent/memory/ingest", INGEST_BODY, signature),
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

test("ingest 2xx：有簽＋snake_case 映射＋契約 §3.1 響應形狀", async () => {
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
      stats: { received: number; accepted: number; index_lines: number };
    };
    assert.deepEqual(data.accepted, ["r-1-route-probe"]);
    assert.deepEqual(data.rejected, []);
    assert.deepEqual(data.stats, { received: 1, accepted: 1, index_lines: 1 });

    // 欄位映射落地檢查：owner_key→ownerKey、evidence_kind→evidenceKind、self_score→selfScore。
    const docs = await listMemoryDocs({ scope: "private", ownerKey: "owner-hash-1" });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].evidenceKind, "user_confirmed");
    assert.equal(docs[0].selfScore, 4);
    assert.equal(docs[0].promptVersion, "v1");
    assert.equal(docs[0].revision, 1);
    __resetAgentMemoryStoreForTests();
  });
});

test("ingest：簽名正確但 body 非 JSON → 400 invalid_json", async () => {
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

test("retract：無簽 401；有簽 → {retracted:[id]}（契約 §3.2）", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const unsigned = await retractPOST(
      postRequest("http://localhost/api/agent/memory/retract", JSON.stringify({ batch_id: "r-2" })),
    );
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 先經 ingest 端點寫一筆，再按 batch_id 撤回。
    const body = JSON.stringify({
      batch_id: "r-2",
      docs: [
        {
          scope: "shared",
          domain: "測試",
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

test("review：無簽 401；action 非法 400；有簽 → {reviewed:[ids],action}（PRD §5.6）", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    // 防線同 retract：無簽一律 401，先於一切入參校驗。
    const unsigned = await reviewPOST(
      postRequest(
        "http://localhost/api/agent/memory/review",
        JSON.stringify({ batch_id: "rv-r", action: "pending_review" }),
      ),
    );
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 有簽但 action 缺／非法 → 400 invalid_action（不落 store）。
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

    // 2xx 端到端：先 ingest 一條 shared，再按 batch_id 轉 pending_review。
    const body = JSON.stringify({
      batch_id: "rv-r",
      docs: [
        {
          scope: "shared",
          domain: "測試",
          slug: "to-review",
          description: "a doc to flip pending_review via endpoint",
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

    const reviewRaw = JSON.stringify({ batch_id: "rv-r", action: "pending_review" });
    const res = await reviewPOST(
      postRequest(
        "http://localhost/api/agent/memory/review",
        reviewRaw,
        signMemoryBody(bytes(reviewRaw), SECRET),
      ),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reviewed: ["rv-r-to-review"], action: "pending_review" });
    assert.deepEqual(await listMemoryDocs({ scope: "shared" }), []);
    __resetAgentMemoryStoreForTests();
  });
});

test("export：GET 對空 bytes 驗簽——無簽 401、非空 bytes 簽 401、空 bytes 簽 200", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const url = "http://localhost/api/agent/memory/export?scope=shared";
    const unsigned = await exportGET(getRequest(url));
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "unauthorized" });

    // 常見錯法：拿「某個 body」的簽來驗 GET（GET 真義是空 bytes）。
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

test("export private：owner_key 過濾；缺 owner_key 回空；只含 active", async () => {
  __resetAgentMemoryStoreForTests();
  await withSecret(SECRET, async () => {
    const body = JSON.stringify({
      batch_id: "r-3",
      docs: [
        {
          scope: "private",
          owner_key: "owner-x",
          domain: "日本動漫",
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
          domain: "日本動漫",
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
    assert.match(data.index_md, /- \[日本動漫\] mine — private doc for owner x （v1）/);

    const noOwner = await exportGET(
      getRequest("http://localhost/api/agent/memory/export?scope=private", signEmpty()),
    );
    assert.equal(noOwner.status, 200);
    assert.deepEqual(((await noOwner.json()) as { docs: unknown[] }).docs, []);
    __resetAgentMemoryStoreForTests();
  });
});

test("memory-trace：未帶 agent 身份 → 401（沿用既有 agent key 認證，非 HMAC 尺）", async () => {
  const res = await memoryTraceGET(
    getRequest("http://localhost/api/agent/sessions/ses_abc/memory-trace"),
    { params: Promise.resolve({ id: "ses_abc" }) },
  );
  assert.equal(res.status, 401);
  const data = (await res.json()) as { success: boolean; code: string };
  assert.equal(data.success, false);
  assert.equal(data.code, "agent_not_signed_in");
});
