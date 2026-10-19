import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { embedTicketInState, extractTicketFromState } from "./github-auth.ts";

// PWA handoff 契约测试：state↔ticket 编解码是真跑的纯函数；路由/入口侧
// 只钉关键接线（源码字串断言），避免为单测起 DB/HTTP。

const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("handoff ticket round-trips through the oauth state", () => {
  const state = embedTicketInState("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "deadbeefcafe0123456789abcdef0123");
  assert.equal(state, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.deadbeefcafe0123456789abcdef0123");
  assert.equal(extractTicketFromState(state), "deadbeefcafe0123456789abcdef0123");
});

test("extractTicketFromState rejects malformed states", () => {
  assert.equal(extractTicketFromState("no-dot-here"), null); // 无点：普通 state
  assert.equal(extractTicketFromState("a.b.c"), null); // 多点
  assert.equal(extractTicketFromState(".ticket"), null); // base 空段
  assert.equal(extractTicketFromState("base."), null); // ticket 空段
  assert.equal(extractTicketFromState(""), null); // 全空
});

test("handoff route wires claimHandoff and seeds napi_token", () => {
  const route = readSrc("../app/api/auth/handoff/route.ts");
  assert.ok(route.includes("claimHandoff"), "claim 分支必须消费 ticket");
  assert.ok(route.includes("napi_token"), "claim 必须种 napi_token");
});

test("github callback branch extracts handoff ticket and redirects to complete?handoff=1", () => {
  const route = readSrc("../app/api/auth/github/callback/route.ts");
  assert.ok(route.includes("extractTicketFromState"), "callback 必须从 state 提取 ticket");
  assert.ok(route.includes("auth/complete?handoff=1"), "handoff 分支必须回 complete?handoff=1");
});

test("standalone detection keeps the display-mode: standalone media query", () => {
  const login = readSrc("./github-login.ts");
  assert.ok(login.includes("display-mode: standalone"), "standalone 检测依赖该媒体查询");
});

test("pwa-handoff lib wires the dual-mode relay channel", () => {
  const lib = readSrc("./pwa-handoff.ts");
  assert.ok(lib.includes("generationDatabaseConfigured"), "无 DB 时必须经 generationDatabaseConfigured 分派到代理通道");
  assert.ok(lib.includes("image-control/api/internal/pwa-handoff"), "代理通道必须指向控制面 internal 端点");
});

test("internal pwa-handoff route verifies the HMAC signature domain", () => {
  const route = readSrc("../app/api/internal/pwa-handoff/route.ts");
  assert.ok(route.includes("verifyBizKeySync"), "internal 端点必须校验 HMAC 签名");
  assert.ok(route.includes('"pwa-handoff"'), "签名域必须钉死为 pwa-handoff");
});
