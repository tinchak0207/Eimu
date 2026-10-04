// `/api/canvas/scene-3d` 上传路由的身分来源测试（真跑路由函式，非源码扫描）。
//
// 本刀只动身分来源一件事（新增连接码两条通道），所以测试也只钉这三条不变量：
//   ① 合法连接码（Bearer 或表单栏位）能通过认证 → 真的走到档案验证（回 bad_extension）；
//   ② 伪造/过期码必须 401，且**不得**走进上传逻辑（回的是连接码错误，不是验证错误）；
//   ③ 明文码不得出现在任何回应讯息里（负向断言）。
// 另外补一条回归：会话令牌用的也是 `Authorization: Bearer`，加了连接码通道后
// 必须原样落到 cookie 路径（回「请先登录。」），不能被误判成无效码。
//
// 离线跑得起来的原因（刻意设计）：`requireVerifiedUser` → `authenticateImageUser`
// 在「没有 Authorization」或「没有 user id 标头」时**直接回 401、不打上游**，
// 所以 cookie 路径的失败分支与连接码分支都能离线断言，不需要打桩、不需要网路。
// 也刻意**不**让任何案例走到物件存储：所有档案都在验证阶段被拒
// （测试里不做真上传＝不在测试中产生外部副作用）。
//
// 真执行器：`npx tsx --test src/app/api/canvas/scene-3d/route.test.ts`（本仓无 vitest）。

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as uploadScene3d } from "./route";
import { POST as mintLinkCode } from "./link/route";
import { signScene3dLinkCode } from "@/lib/canvas/scene-3d-link";

const SECRET = "test-scene3d-link-route-secret";

/** 一个「副档名就是错的」位元组序列：公开的 PNG magic，用来在验证阶段被挡下。 */
const NOT_A_MODEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const savedSecret = process.env.SCENE_3D_LINK_SECRET;
const savedLocalTest = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;

beforeEach(() => {
  process.env.SCENE_3D_LINK_SECRET = SECRET;
  // 本地测试模式会让 requireVerifiedUser 放行 id:0 的假身分，这里必须关掉，
  // 否则「没带凭证必须 401」的断言会假绿。
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SCENE_3D_LINK_SECRET;
  else process.env.SCENE_3D_LINK_SECRET = savedSecret;
  if (savedLocalTest === undefined) delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  else process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = savedLocalTest;
});

function uploadRequest(input: {
  fileName?: string;
  bytes?: Uint8Array;
  code?: string;
  bearer?: string;
}): NextRequest {
  const form = new FormData();
  form.append(
    "file",
    new File([input.bytes ?? NOT_A_MODEL], input.fileName ?? "model.png", { type: "application/octet-stream" }),
  );
  if (input.code !== undefined) form.append("code", input.code);
  const headers = new Headers();
  if (input.bearer !== undefined) headers.set("authorization", `Bearer ${input.bearer}`);
  return new NextRequest("http://localhost/api/canvas/scene-3d", { method: "POST", headers, body: form });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 明文码不得出现在回应体里的负向对照（所有案例共用）。 */
function assertNoCodeEcho(body: unknown, code: string, label: string) {
  const text = JSON.stringify(body);
  assert.ok(!text.includes(code), `${label}：回应体不得回显连接码明文`);
  assert.ok(!text.includes(code.slice(0, 24)), `${label}：回应体不得回显连接码片段`);
}

test("合法连接码走 Authorization: Bearer（无 cookie）能通过认证 → 走到文件验证", async () => {
  const code = signScene3dLinkCode(42);
  const res = await uploadScene3d(uploadRequest({ bearer: code }));
  const body = await json(res);
  assert.equal(res.status, 400, "认证通过后应由文件验证拒绝（.png 副档名）");
  assert.equal(body.code, "bad_extension");
  assert.equal(body.error, "只支持 .glb / .gltf 格式的 3D 模型文件。");
  assertNoCodeEcho(body, code, "Bearer 合法码");
});

test("合法连接码走表单栏位 code（无 cookie、无授权头）能通过认证 → 走到文件验证", async () => {
  const code = signScene3dLinkCode(42);
  const res = await uploadScene3d(uploadRequest({ code }));
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, "bad_extension");
  assertNoCodeEcho(body, code, "表单合法码");
});

test("合法连接码 + .glb 档名（容器头不对）→ 认证已通过，验证再挡一层", async () => {
  const code = signScene3dLinkCode(42);
  const res = await uploadScene3d(uploadRequest({ code, fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, "bad_content", "认证明明通过后才会走到魔数校验");
  assertNoCodeEcho(body, code, "表单合法码 + glb");
});

test("伪连接码（表单栏位）→ 401，且不得走进上传逻辑", async () => {
  const forged = signScene3dLinkCode(42).replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const res = await uploadScene3d(uploadRequest({ code: forged }));
  const body = await json(res);
  assert.equal(res.status, 401, "伪造码必须是 401（不是 400/200）");
  assert.equal(body.code, "invalid_code");
  assert.equal(body.success, false);
  // 不得出现任何「档案层」的错误码＝没有进到上传/验证逻辑。
  for (const uploadCode of ["bad_extension", "bad_content", "too_large", "no_file", "storage_unconfigured", "upload_failed"]) {
    assert.notEqual(body.code, uploadCode, `伪造码不得走进上传逻辑（出现了 ${uploadCode}）`);
  }
  assert.ok(!String(body.error).includes("只支持"), "不得泄露上传路径的验证规则");
  assertNoCodeEcho(body, forged, "伪造码");
});

test("伪连接码走 Authorization: Bearer → 401（未被误判为合法会话，也没换到身份）", async () => {
  const forged = "Zm9yZ2Vk.cafebabe";
  const res = await uploadScene3d(uploadRequest({ bearer: forged, fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 401);
  assert.equal(body.success, false);
  assertNoCodeEcho(body, forged, "Bearer 伪造码");
});

test("过期的合法连接码 → 401 link_expired（两条通道都要堵）", async () => {
  const expired = signScene3dLinkCode(42, -1_000);

  const viaForm = await uploadScene3d(uploadRequest({ code: expired }));
  const formBody = await json(viaForm);
  assert.equal(viaForm.status, 401);
  assert.equal(formBody.code, "link_expired");

  const viaBearer = await uploadScene3d(uploadRequest({ bearer: expired }));
  const bearerBody = await json(viaBearer);
  assert.equal(viaBearer.status, 401);
  assert.equal(bearerBody.code, "link_expired");

  assertNoCodeEcho(formBody, expired, "过期码（表单）");
  assertNoCodeEcho(bearerBody, expired, "过期码（Bearer）");
});

test("密钥未配置：连接码通道诚实失败 503，不得降级放行", async () => {
  delete process.env.SCENE_3D_LINK_SECRET;
  const res = await uploadScene3d(uploadRequest({ code: "any-shaped-code" }));
  const body = await json(res);
  assert.equal(res.status, 503);
  assert.equal(body.code, "link_not_configured");
  assert.equal(body.success, false);
});

test("回归：会话令牌用的也是 Bearer，必须原样落到 cookie 路径（不被误判成无效码）", async () => {
  const res = await uploadScene3d(uploadRequest({ bearer: "some-session-token", fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 401);
  // cookie 路径被 requireVerifiedUser 覆写过的中性文案（与改刀前逐字相同）。
  assert.equal(body.error, "请先登录。");
  assert.equal(body.code, "unauthorized");
});

test("回归：完全不带凭据 → 401「请先登录。」（cookie 路径行为逐字不变）", async () => {
  const res = await uploadScene3d(uploadRequest({ fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 401);
  assert.equal(body.error, "请先登录。");
  assert.equal(body.code, "unauthorized");
});

// ─────────────────────────────────────────── 铸码端点（POST /api/canvas/scene-3d/link）

test("铸码端点：未登入 → 401，且回应里没有任何码", async () => {
  const res = await mintLinkCode(new NextRequest("http://localhost/api/canvas/scene-3d/link", { method: "POST" }));
  const body = await json(res);
  assert.equal(res.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.code, "unauthorized");
  assert.ok(body.expires_in_ms === undefined, "未授权不得回 TTL（那等于承认端点可用）");
});

test("铸码端点：假身分（本地测试模式 id:0）→ 403，不发一串验不过的码", async () => {
  process.env.NEXT_PUBLIC_LOCAL_TEST_MODE = "true";
  const res = await mintLinkCode(new NextRequest("http://localhost/api/canvas/scene-3d/link", { method: "POST" }));
  const body = await json(res);
  assert.equal(res.status, 403);
  assert.equal(body.code, "session_not_linkable");
  assert.equal(body.success, false);
});
