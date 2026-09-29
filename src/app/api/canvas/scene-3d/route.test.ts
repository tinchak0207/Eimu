// `/api/canvas/scene-3d` 上傳路由的身分來源測試（真跑路由函式，非源碼掃描）。
//
// 本刀只動身分來源一件事（新增連接碼兩條通道），所以測試也只釘這三條不變量：
//   ① 合法連接碼（Bearer 或表單欄位）能通過認證 → 真的走到檔案驗證（回 bad_extension）；
//   ② 偽造/過期碼必須 401，且**不得**走進上傳邏輯（回的是連接碼錯誤，不是驗證錯誤）；
//   ③ 明文碼不得出現在任何回應訊息裡（負向斷言）。
// 另外補一條回歸：會話令牌用的也是 `Authorization: Bearer`，加了連接碼通道後
// 必須原樣落到 cookie 路徑（回「请先登录。」），不能被誤判成無效碼。
//
// 離線跑得起來的原因（刻意設計）：`requireVerifiedUser` → `authenticateImageUser`
// 在「沒有 Authorization」或「沒有 user id 標頭」時**直接回 401、不打上游**，
// 所以 cookie 路徑的失敗分支與連接碼分支都能離線斷言，不需要打樁、不需要網路。
// 也刻意**不**讓任何案例走到物件存儲：所有檔案都在驗證階段被拒
// （測試裡不做真上傳＝不在測試中產生外部副作用）。
//
// 真執行器：`npx tsx --test src/app/api/canvas/scene-3d/route.test.ts`（本倉無 vitest）。

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as uploadScene3d } from "./route";
import { POST as mintLinkCode } from "./link/route";
import { signScene3dLinkCode } from "@/lib/canvas/scene-3d-link";

const SECRET = "test-scene3d-link-route-secret";

/** 一個「副檔名就是錯的」位元組序列：公開的 PNG magic，用來在驗證階段被擋下。 */
const NOT_A_MODEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const savedSecret = process.env.SCENE_3D_LINK_SECRET;
const savedLocalTest = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;

beforeEach(() => {
  process.env.SCENE_3D_LINK_SECRET = SECRET;
  // 本地測試模式會讓 requireVerifiedUser 放行 id:0 的假身分，這裡必須關掉，
  // 否則「沒帶憑證必須 401」的斷言會假綠。
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

/** 明文碼不得出現在回應體裡的負向對照（所有案例共用）。 */
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

test("合法连接码走表單欄位 code（无 cookie、无授权头）能通过认证 → 走到文件验证", async () => {
  const code = signScene3dLinkCode(42);
  const res = await uploadScene3d(uploadRequest({ code }));
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, "bad_extension");
  assertNoCodeEcho(body, code, "表單合法码");
});

test("合法连接码 + .glb 檔名（容器头不对）→ 认证已通过，验证再挡一层", async () => {
  const code = signScene3dLinkCode(42);
  const res = await uploadScene3d(uploadRequest({ code, fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, "bad_content", "认证明明通过后才会走到魔数校验");
  assertNoCodeEcho(body, code, "表單合法码 + glb");
});

test("伪连接码（表單欄位）→ 401，且不得走进上传逻辑", async () => {
  const forged = signScene3dLinkCode(42).replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  const res = await uploadScene3d(uploadRequest({ code: forged }));
  const body = await json(res);
  assert.equal(res.status, 401, "伪造码必须是 401（不是 400/200）");
  assert.equal(body.code, "invalid_code");
  assert.equal(body.success, false);
  // 不得出現任何「檔案層」的錯誤碼＝沒有進到上傳/驗證邏輯。
  for (const uploadCode of ["bad_extension", "bad_content", "too_large", "no_file", "storage_unconfigured", "upload_failed"]) {
    assert.notEqual(body.code, uploadCode, `伪造码不得走进上传逻辑（出现了 ${uploadCode}）`);
  }
  assert.ok(!String(body.error).includes("只支持"), "不得泄露上传路径的验证规则");
  assertNoCodeEcho(body, forged, "偽造碼");
});

test("伪连接码走 Authorization: Bearer → 401（未被误判为合法会话，也没换到身份）", async () => {
  const forged = "Zm9yZ2Vk.cafebabe";
  const res = await uploadScene3d(uploadRequest({ bearer: forged, fileName: "model.glb" }));
  const body = await json(res);
  assert.equal(res.status, 401);
  assert.equal(body.success, false);
  assertNoCodeEcho(body, forged, "Bearer 偽造碼");
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

  assertNoCodeEcho(formBody, expired, "過期碼（表單）");
  assertNoCodeEcho(bearerBody, expired, "過期碼（Bearer）");
});

test("密鑰未配置：连接码通道诚实失败 503，不得降级放行", async () => {
  delete process.env.SCENE_3D_LINK_SECRET;
  const res = await uploadScene3d(uploadRequest({ code: "any-shaped-code" }));
  const body = await json(res);
  assert.equal(res.status, 503);
  assert.equal(body.code, "link_not_configured");
  assert.equal(body.success, false);
});

test("回归：会话令牌用的也是 Bearer，必须原樣落到 cookie 路径（不被误判成无效码）", async () => {
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
