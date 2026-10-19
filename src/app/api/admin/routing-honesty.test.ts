import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 诚实性守护：admin 的探测与诊断必须与生产队列同源（channel-registry /
// channel-overrides），不得退回各自为战的 env 拼装——那正是「admin 停用渠道后
// 探测照样扣费、第一分页与第四分页各说各话」的病根。

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

  // 同源不变量：队列只能来自 channel-registry，覆写只能来自 channel-overrides。
  assert.match(code, /buildModelQueue/);
  assert.match(code, /getRuntimeChannelOverrides/);
  assert.match(code, /from "@\/lib\/channel-registry"/);
  assert.match(code, /from "@\/lib\/channel-overrides"/);

  // 防回退：不得再自行拼装 env 端点 + 池合并——那会无视 admin 的调度启停。
  assert.doesNotMatch(code, /buildGatewayEndpointsWithPools\(/);
  assert.doesNotMatch(code, /buildGatewayEndpoints\(/);
});

test("account-pools routing diagnosis honors admin channel overrides", () => {
  const code = readCode("src/app/api/admin/account-pools/route.ts");

  // 诊断必须读 runtime 覆写，且针对的正是可覆写渠道 id「env:sub2api」。
  assert.match(code, /getRuntimeChannelOverrides/);
  assert.match(code, /env:sub2api/);
  assert.match(code, /from "@\/lib\/channel-overrides"/);

  // 停用时要对 admin 明说，而不是沉默地继续宣称路由生效。
  assert.match(code, /sub2api 已在路由调度中被停用/);
});
