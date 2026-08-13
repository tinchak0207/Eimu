import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 誠實性守護：admin 的探測與診斷必須與生產隊列同源（channel-registry /
// channel-overrides），不得退回各自為戰的 env 拼裝——那正是「admin 停用渠道後
// 探測照樣扣費、第一分頁與第四分頁各說各話」的病根。

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/**
 * Same file with comments stripped. Negative assertions ("this bug must not come back")
 * have to run against code only — otherwise a comment *explaining* the old bug trips the
 * very guard that documents it. The (^|[^:]) keeps `https://…` URLs intact.
 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("image-upstream-probe probes the exact production queue (buildModelQueue + runtime overrides)", () => {
  const code = readCode("src/app/api/admin/image-upstream-probe/route.ts");

  // 同源不變量：隊列只能來自 channel-registry，覆寫只能來自 channel-overrides。
  assert.match(code, /buildModelQueue/);
  assert.match(code, /getRuntimeChannelOverrides/);
  assert.match(code, /from "@\/lib\/channel-registry"/);
  assert.match(code, /from "@\/lib\/channel-overrides"/);

  // 防回退：不得再自行拼裝 env 端點 + 池合併——那會無視 admin 的調度啟停。
  assert.doesNotMatch(code, /buildGatewayEndpointsWithPools\(/);
  assert.doesNotMatch(code, /buildGatewayEndpoints\(/);
});

test("account-pools routing diagnosis honors admin channel overrides", () => {
  const code = readCode("src/app/api/admin/account-pools/route.ts");

  // 診斷必須讀 runtime 覆寫，且針對的正是可覆寫渠道 id「env:sub2api」。
  assert.match(code, /getRuntimeChannelOverrides/);
  assert.match(code, /env:sub2api/);
  assert.match(code, /from "@\/lib\/channel-overrides"/);

  // 停用時要對 admin 明說，而不是沉默地繼續宣稱路由生效。
  assert.match(code, /sub2api 已在路由调度中被停用/);
});
