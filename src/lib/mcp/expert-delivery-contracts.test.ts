// 交付契约 JSON 的「建置可携性」同步棘轮。
//
// 背景（2026-10-03 远端建置事故）：`deploy-staging/` 同时被 .vercelignore（`/deploy-staging/`）
// 与 .gitignore（`/deploy-staging/*`）排除、且完全未被 git 追踪，所以它**永远上不了 Vercel**。
// 若 route 用静态 import 读它，远端 webpack 会 `Module not found` 直接炸生产 build（本地有档故
// `next build` 验不出）。修法＝把契约档镜像到 `src/lib/mcp/expert-delivery-contracts.json`（会被打包）。
//
// 本测试守三条：
//   ① src 镜像 与 deploy-staging 原档 **逐位元组相同**（Buffer 比对；原档缺席时明确 skip，不红）。
//   ② route 载入的契约集合＝八个域、每域 requiredFields 非空。
//   ③ 三边一致：src 镜像 ↔ 指南 HARNESS_DELIVERY_CONTRACTS ↔ deploy-staging 原档（逐域逐栏位）。
//   ④ 接线探针：route.ts 的静态 import 指向 src 镜像，且不再 import 任何 deploy-staging 路径。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// route 使用的就是这条模块说明符（@@/ alias → src/）；直接 import 同一份档＝验 route 真正载入的集合。
import contractSource from "./expert-delivery-contracts.json";
import { HARNESS_DELIVERY_CONTRACTS } from "./harness-guide";

const REPO_ROOT = process.cwd();
const MIRROR_PATH = join(REPO_ROOT, "src/lib/mcp/expert-delivery-contracts.json");
const ORIGINAL_PATH = join(REPO_ROOT, "deploy-staging/expert-gateway/expert-delivery-contracts.json");
const ROUTE_PATH = join(
  REPO_ROOT,
  "src/app/api/harness/expert/deliverable/validate/route.ts",
);

interface DomainContract {
  requiredFields: string[];
  qcSignatureRequired: boolean;
}
type Contracts = Record<string, DomainContract>;

/** deploy-staging/ 是本机专属目录（未进 git）；别人 clone 没有它 → 同步检查须 skip，不得红。 */
const ORIGINAL_ABSENT_MSG =
  "deploy-staging/ 为本机专属目录（未进 git），缺席时跳过同步检查（src 镜像已随 git 上传，不影响建置）";

test("同步棘轮：src 镜像与 deploy-staging 原档逐位元组相同（原档缺席则 skip）", (t) => {
  if (!existsSync(ORIGINAL_PATH)) {
    t.skip(ORIGINAL_ABSENT_MSG);
    return;
  }
  const mirror = readFileSync(MIRROR_PATH);
  const original = readFileSync(ORIGINAL_PATH);
  assert.ok(
    mirror.equals(original),
    `src/lib/mcp/expert-delivery-contracts.json 与 deploy-staging/expert-gateway/expert-delivery-contracts.json 不再逐位元组一致（镜像漂移）。请 cp 原档覆盖镜像后重跑。mirror=${mirror.length}B sha=… original=${original.length}B`,
  );
});

test("route 载入的契约＝八域、requiredFields 非空、与指南逐域逐栏位一致（有原档时并验原档）", () => {
  const loaded = contractSource as unknown as Contracts;
  const guide = JSON.parse(HARNESS_DELIVERY_CONTRACTS) as Contracts;

  // ② route 实际载入的集合：八个合法域、每域 requiredFields 非空。
  assert.equal(Object.keys(loaded).length, 8, "route 载入的契约必须是 8 个域");
  for (const [domain, contract] of Object.entries(loaded)) {
    assert.ok(Array.isArray(contract.requiredFields), `${domain}.requiredFields 必须是数组`);
    assert.ok(contract.requiredFields.length > 0, `${domain}.requiredFields 不得为空`);
    assert.equal(typeof contract.qcSignatureRequired, "boolean", `${domain}.qcSignatureRequired 必须是布林`);
  }

  // ③a 镜像 ↔ 指南（逐域清单 + 逐域逐栏位）。
  assert.deepEqual(
    Object.keys(loaded).sort(),
    Object.keys(guide).sort(),
    "src 镜像与指南 HARNESS_DELIVERY_CONTRACTS 的域清单不一致",
  );
  for (const domain of Object.keys(guide)) {
    assert.deepEqual(
      loaded[domain].requiredFields,
      guide[domain].requiredFields,
      `${domain}.requiredFields 镜像与指南不一致`,
    );
    assert.equal(
      loaded[domain].qcSignatureRequired,
      guide[domain].qcSignatureRequired,
      `${domain}.qcSignatureRequired 镜像与指南不一致`,
    );
  }

  // ③b 有原档时把第三边接上（无原档则跳过这一段，由上面的字节测试负责）。
  if (existsSync(ORIGINAL_PATH)) {
    const original = JSON.parse(readFileSync(ORIGINAL_PATH, "utf8")) as Contracts;
    assert.deepEqual(
      Object.keys(loaded).sort(),
      Object.keys(original).sort(),
      "src 镜像与 deploy-staging 原档的域清单不一致（同步漂移）",
    );
    for (const domain of Object.keys(original)) {
      assert.deepEqual(
        loaded[domain].requiredFields,
        original[domain].requiredFields,
        `${domain}.requiredFields 镜像与 deploy-staging 原档不一致`,
      );
      assert.equal(
        loaded[domain].qcSignatureRequired,
        original[domain].qcSignatureRequired,
        `${domain}.qcSignatureRequired 镜像与 deploy-staging 原档不一致`,
      );
    }
  }
});

test("接线探针：route.ts 静态 import 指向 src 镜像，且不含任何 deploy-staging 静态 import", () => {
  const routeSrc = readFileSync(ROUTE_PATH, "utf8");

  assert.ok(
    routeSrc.includes('from "@/lib/mcp/expert-delivery-contracts.json"'),
    "route.ts 必须静态 import src/lib/mcp/expert-delivery-contracts.json（建置可打包的镜像）",
  );
  // 反向棘轮：不得再有指向 deploy-staging/ 的静态 import（会被 Vercel 剪掉 → 远端 Module not found）。
  const staticImportLines = routeSrc
    .split("\n")
    .filter((line) => /^\s*import\s.*from\s/.test(line));
  const offenders = staticImportLines.filter((line) => line.includes("deploy-staging"));
  assert.deepEqual(offenders, [], `route.ts 仍有静态 import 指向 deploy-staging/：${JSON.stringify(offenders)}`);
});
