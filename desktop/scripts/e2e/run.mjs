// desktop/scripts/e2e/run.mjs
//
// 逐条执行 cases.mjs 的测试清单，每条产出截图 PNG ＋ JSON 结果，最后印总结。
//
// 用法：
//   node desktop/scripts/e2e/run.mjs [--only name1,name2] [--out /tmp/dir]
// 预设输出 /tmp/eimu-e2e-<timestamp>/（不写进 repo）。
//
// 退出码：全部 pass = 0；有任何 fail = 1；harness 自身崩溃 = 2。

import fs from "node:fs";
import path from "node:path";
import { timestampTag } from "./harness.mjs";
import { cases } from "./cases.mjs";

function parseArgs(argv) {
  const out = { only: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") out.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out || path.join("/tmp", `eimu-e2e-${timestampTag()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const selected = args.only ? cases.filter((c) => args.only.includes(c.name)) : cases;
  if (!selected.length) {
    console.error(`没有符合的测试：--only ${args.only && args.only.join(",")}`);
    process.exit(2);
  }

  console.log(`Eimu 真壳 E2E 测试台`);
  console.log(`输出目录：${outDir}`);
  console.log(`选中 ${selected.length} 条：${selected.map((c) => c.name).join(", ")}\n`);

  const results = [];
  for (const c of selected) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    process.stdout.write(`▶ ${c.name} ... `);
    let result;
    try {
      const r = await c.run({ outDir, repoRoot: process.cwd() });
      result = {
        name: c.name,
        status: "pass",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        observations: r.observations || {},
        artifacts: r.artifacts || {},
      };
      console.log(`PASS (${result.durationMs}ms)`);
    } catch (err) {
      result = {
        name: c.name,
        status: "fail",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        observations: {},
        artifacts: {},
        error: String((err && err.stack) || err),
      };
      console.log(`FAIL (${result.durationMs}ms) ${err && err.message}`);
    }
    fs.writeFileSync(path.join(outDir, `${c.name}.json`), JSON.stringify(result, null, 2));
    results.push(result);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const summary = {
    outDir,
    total: results.length,
    passed,
    failed: results.length - passed,
    results: results.map((r) => ({
      name: r.name,
      status: r.status,
      durationMs: r.durationMs,
      screenshot: r.artifacts && r.artifacts.screenshot ? r.artifacts.screenshot.path : null,
      screenshotBytes: r.artifacts && r.artifacts.screenshot ? r.artifacts.screenshot.size : null,
      error: r.error ? r.error.split("\n")[0] : null,
    })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\n=== 总结 ${passed}/${results.length} pass ===`);
  for (const r of summary.results) {
    const extra = r.screenshot ? `${r.screenshot} (${r.screenshotBytes} bytes)` : "";
    console.log(`  [${r.status.toUpperCase()}] ${r.name} ${r.durationMs}ms ${extra}${r.error ? " :: " + r.error : ""}`);
  }
  console.log(`\n结果目录：${outDir}`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness fatal:", err);
  process.exit(2);
});
