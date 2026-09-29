// `/api/admin/statistics?format=csv`（P2-1／對稱差 D16 用量導出）——真跑路由函式。
//
// 鑑權不 mock requireAdminSession，而是 patch `next/headers` 的 `cookies()`（同
// `admin/model-pricing/route.test.ts` 的既有手法），再 mint 一顆真 session token。
// 控制面 DB 刻意**不配置**（刪掉 GENERATION_DATABASE_URL）⇒ 投影確定性地回
// `configured:false`，導出檔只含 meta 段。這正是要驗的誠實路徑：沒有資料時**不吐一排 0**。
//
// 真執行器：`npx tsx --test src/app/api/admin/statistics/route.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from "@/lib/admin-auth";
import { STATISTICS_CSV_BOM } from "@/lib/generation-core/statistics-csv";
import { GET } from "./route";

const requireFn = createRequire(import.meta.url);
const nextHeaders = requireFn("next/headers") as { cookies: unknown };

process.env.ADMIN_SESSION_SECRET = "statistics-export-test-secret";
process.env.ADMIN_USERNAME = "tinchak0207";
// 未配置控制面 DB ⇒ buildStatisticsProjection 回 configured:false（確定性、不碰網路）。
delete process.env.GENERATION_DATABASE_URL;
delete process.env.DATABASE_URL;

function installCookieMock(signedIn: boolean) {
  const store = new Map<string, string>();
  if (signedIn) {
    store.set(ADMIN_SESSION_COOKIE, createAdminSessionToken("tinchak0207", process.env.ADMIN_SESSION_SECRET!));
  }
  nextHeaders.cookies = async () => ({
    get: (name: string) => {
      const value = store.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  });
}

function get(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/admin/statistics${query}`);
}

test("未登入 → 401（導出與 JSON 同一道門，不因 format 而放行）", async () => {
  installCookieMock(false);
  const res = await GET(get("?format=csv"));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).success, false);
});

test("format=csv → 200 text/csv＋BOM＋attachment 檔名（Excel 可直接開）", async () => {
  installCookieMock(true);
  const res = await GET(get("?format=csv&days=7"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv; charset=utf-8$/);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="statistics-\d{4}-\d{2}-\d{2}-7d\.csv"$/);
  // BOM 要看**位元組**：`Response.text()` 走 UTF-8 decode，規範會把開頭 BOM 吃掉，
  // 用它來驗 BOM 會得到假陰性（Excel 看到的是位元組，不是 text()）。
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "缺 BOM ⇒ Excel 開中文欄位名會亂碼");
  // 註：`TextDecoder`／`Response.text()` 都會吃掉開頭 BOM（規範如此），所以只能用位元組驗。
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  assert.equal(text.startsWith(STATISTICS_CSV_BOM), true);
  const body = text.slice(STATISTICS_CSV_BOM.length);
  assert.match(body, /^section,key,label,quota,coins,operations,record_ids\r\n/, "表頭即契約");
  assert.match(body, /meta,configured,false/, "未配置如實記錄");
  // 沒有消耗面 ⇒ 不得出現任何 total 列（不吐一排 0 冒充「用量是 0」）。
  assert.equal(/,total,/.test(body), false);
});

test("format=json（與省略）→ 既有 JSON 形狀逐位不變", async () => {
  installCookieMock(true);
  const implicit = await GET(get());
  assert.equal(implicit.status, 200);
  assert.match(implicit.headers.get("content-type") ?? "", /^application\/json/);
  const payload = await implicit.json();
  assert.equal(payload.success, true);
  assert.equal(payload.configured, false);

  const explicit = await GET(get("?format=json"));
  assert.equal(explicit.status, 200);
  assert.equal((await explicit.json()).configured, false);
});

test("拼錯的 format → 具名 400（不靜默回一份 JSON 讓人誤當導出檔）", async () => {
  installCookieMock(true);
  const res = await GET(get("?format=xlsx"));
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.success, false);
  assert.match(payload.message, /format 只能是 json 或 csv/);
});

test("窗口參數越界仍走既有 400（導出不得繞過參數驗證）", async () => {
  installCookieMock(true);
  const res = await GET(get("?format=csv&days=999"));
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /days 必须是/);
});