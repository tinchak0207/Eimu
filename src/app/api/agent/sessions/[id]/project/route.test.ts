// GET /api/agent/sessions/[id]/project 的行为测试（真 handler + 本机 fake 网关，不打外网）。
//
// 钉住五件事：未登录 401、查询参数与 S10b client 逐字一致（含顺序）、网关不可达 502、
// 成功透传带 Cache-Control: no-store、网关 404（view=node 找不到节点）原样回。
// 鉴权走 LOCAL_TEST_MODE 的离线 bypass（与生产无关，仅本机/测试用）。

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";

process.env.AGENT_CHAT_ENABLED = "true";
process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = "true";
process.env.IMAGE_STUDIO_BIZ_KEY = "sk-biz-local-test";

interface Seen {
  url: string;
  method: string;
  body: string;
}

let handler: ((req: Seen) => Promise<Response>) | null = null;
let GET: ((req: unknown, ctx: { params: Promise<{ id: string }> }) => Promise<Response>) | null = null;
let NextRequestCtor: (new (url: string) => unknown) | null = null;
let seen: Seen[] = [];
let server: Server;
let origin = "";

before(async () => {
  const routeModule = (await import("./route")) as unknown as { GET: NonNullable<typeof GET> };
  GET = routeModule.GET;
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

async function call(id: string, query = ""): Promise<Response> {
  const url = `http://localhost/api/agent/sessions/${id}/project${query}`;
  const req = new (NextRequestCtor as NonNullable<typeof NextRequestCtor>)(url);
  return (GET as NonNullable<typeof GET>)(req, { params: Promise.resolve({ id }) });
}

test("未登录 → 401，且不打网关", async () => {
  reset(replyJson(200, { ok: true }));
  const previous = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  try {
    const res = await call("s1");
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, false);
    assert.equal(seen.length, 0);
  } finally {
    process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = previous;
  }
});

test("S10b 的 view=node 读：路径与查询参数逐字转发，成功透传并 no-store", async () => {
  const receipt = { ok: true, version: 3, cursor: 7, node: { id: "kf1", type: "keyframe", status: "done" } };
  reset(replyJson(200, receipt));
  const res = await call("s1", "?view=node&detail=summary&node=kf1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), receipt);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "/agent/v1/sessions/s1/project?view=node&detail=summary&node=kf1");
});

test("白名单外的查询参数不转给网关", async () => {
  reset(replyJson(200, { ok: true, version: 1, cursor: 0, digest: "x" }));
  const res = await call("s1", "?view=digest&evil=1&wait_sec=9");
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, "/agent/v1/sessions/s1/project?view=digest&wait_sec=9");
});

test("网关 view=node 的 404 原样回（不改成 500，不套 success 包）", async () => {
  const missing = { ok: false, version: 0, cursor: 0 };
  reset(replyJson(404, missing));
  const res = await call("s1", "?view=node&node=nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), missing);
});

test("网关不可达 → 502，带 agent_gateway_unreachable", async () => {
  seen = [];
  process.env.AGENT_GATEWAY_ORIGIN = "http://127.0.0.1:1";
  const res = await call("s1");
  assert.equal(res.status, 502);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "agent_gateway_unreachable");
  assert.equal(seen.length, 0);
});

test("会话 id 非法 → 400 invalid_session_id", async () => {
  reset(replyJson(200, { ok: true }));
  const res = await call("bad id!", "");
  assert.equal(res.status, 400);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "invalid_session_id");
  assert.equal(seen.length, 0);
});
