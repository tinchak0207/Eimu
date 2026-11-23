// POST /api/agent/sessions/[id]/project/patch 的行为测试（真 handler + 本机 fake 网关，不打外网）。
//
// 钉住五件事：未登录 401、session_id 与会话不一致 400、ops 非数组 400、
// 成功透传（只转 ops/baseVersion/atomic，不把 session_id 送进网关；带 Cache-Control: no-store）、
// 网关不可达 502 与网关错误原样回。

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

process.env.AGENT_CHAT_ENABLED = "true";
process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = "true";
process.env.IMAGE_STUDIO_BIZ_KEY = "sk-biz-local-test";

interface Seen {
  url: string;
  method: string;
  body: string;
}

let handler: ((req: Seen) => Promise<Response>) | null = null;
let POST: ((req: unknown, ctx: { params: Promise<{ id: string }> }) => Promise<Response>) | null = null;
let NextRequestCtor: (new (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => unknown) | null = null;
let seen: Seen[] = [];
let server: Server;
let origin = "";

before(async () => {
  const routeModule = (await import("./route")) as unknown as { POST: NonNullable<typeof POST> };
  POST = routeModule.POST;
  const nextServer = (await import("next/server")) as unknown as { NextRequest: NonNullable<typeof NextRequestCtor> };
  NextRequestCtor = nextServer.NextRequest;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const item = { url: req.url ?? "", method: req.method ?? "", body: Buffer.concat(chunks).toString("utf8") };
      seen.push(item);
      void (async () => {
        const reply = handler
          ? await handler(item)
          : new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        res.writeHead(reply.status, Object.fromEntries(reply.headers.entries()));
        res.end(Buffer.from(await reply.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

function replyJson(status: number, body: unknown): (req: Seen) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function reset(next: ((req: Seen) => Promise<Response>) | null): void {
  seen = [];
  handler = next;
  process.env.AGENT_GATEWAY_ORIGIN = origin;
}

async function call(id: string, payload: unknown): Promise<Response> {
  const url = `http://localhost/api/agent/sessions/${id}/project/patch`;
  const req = new (NextRequestCtor as NonNullable<typeof NextRequestCtor>)(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  return (POST as NonNullable<typeof POST>)(req, { params: Promise.resolve({ id }) });
}

test("未登录 → 401，且不打网关", async () => {
  reset(replyJson(200, { ok: true }));
  const previous = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  try {
    const res = await call("s1", { session_id: "s1", ops: [] });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, false);
    assert.equal(seen.length, 0);
  } finally {
    process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = previous;
  }
});

test("session_id 与会话不一致 → 400 session_mismatch，且不打网关", async () => {
  reset(replyJson(200, { ok: true }));
  const res = await call("s1", { session_id: "s2", ops: [{ op: "set_node_note", node: "n1", note: "x" }] });
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "session_mismatch");
  assert.equal(seen.length, 0);

  // 现役 S10b client 不带 session_id：不能因为缺栏位挡住真实回写。
  const active = await call("s1", { ops: [] });
  assert.equal(active.status, 200);
  assert.equal(seen.length, 1);
});

test("ops 非数组 → 400 invalid_request，且不打网关", async () => {
  reset(replyJson(200, { ok: true }));
  const res = await call("s1", { session_id: "s1", ops: "nope" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>).code, "invalid_request");
  assert.equal(seen.length, 0);
});

test("S10b 回写：POST 路径逐字、body 只转 ops（不带 session_id 也照发），回执 no-store", async () => {
  const receipt = { ok: true, version: 4, cursor: 9, applied: 1 };
  reset(replyJson(200, receipt));
  // 逐字照 src/hooks/canvas/project-sync.ts 的现役 body：{ ops }，没有 session_id。
  const ops = [{ op: "remove_node", node: "kf1" }];
  const res = await call("s1", { ops });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), receipt);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/agent/v1/sessions/s1/project/patch");
  assert.deepEqual(JSON.parse(seen[0].body), { ops });
});

test("baseVersion 原样转发，未给的不补默认值", async () => {
  reset(replyJson(200, { ok: true, version: 5, cursor: 10, applied: 1 }));
  const ops = [{ op: "set", node: "kf1", path: "params.prompt", value: "重拍" }];
  const res = await call("s1", { ops, baseVersion: 4 });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(seen[0].body), { ops, baseVersion: 4 });
});

test("调用方自带 session_id 一致时接受，且不把它送进网关", async () => {
  reset(replyJson(200, { ok: true, version: 6, cursor: 11, applied: 1 }));
  const ops = [{ op: "unlock", node: "kf1" }];
  const res = await call("s1", { session_id: "s1", ops, atomic: true });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(seen[0].body), { ops, atomic: true });
});

test("网关 409（版本冲突/lane 违规）原样回，不改状态码", async () => {
  const conflict = { ok: false, version: 4, cursor: 9, error: { code: "VERSION_CONFLICT", message: "版本冲突" } };
  reset(replyJson(409, conflict));
  const res = await call("s1", { session_id: "s1", ops: [] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), conflict);
});

test("网关不可达 → 502，带 agent_gateway_unreachable", async () => {
  seen = [];
  process.env.AGENT_GATEWAY_ORIGIN = "http://127.0.0.1:1";
  const res = await call("s1", { session_id: "s1", ops: [] });
  assert.equal(res.status, 502);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "agent_gateway_unreachable");
  assert.equal(seen.length, 0);
});
