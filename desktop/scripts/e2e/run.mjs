// desktop/scripts/e2e/run.mjs
//
// 逐條執行 cases.mjs 的測試清單，每條產出截圖 PNG ＋ JSON 結果，最後印總結。
//
// 用法：
//   node desktop/scripts/e2e/run.mjs [--only name1,name2] [--out /tmp/dir]
// 預設輸出 /tmp/eimu-e2e-<timestamp>/（不寫進 repo）。
//
// 退出碼：全部 pass = 0；有任何 fail = 1；harness 自身崩潰 = 2。

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
    console.error(`沒有符合的測試：--only ${args.only && args.only.join(",")}`);
    process.exit(2);
  }

  console.log(`Eimu 真殼 E2E 測試台`);
  console.log(`輸出目錄：${outDir}`);
  console.log(`選中 ${selected.length} 條：${selected.map((c) => c.name).join(", ")}\n`);

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

  console.log(`\n=== 總結 ${passed}/${results.length} pass ===`);
  for (const r of summary.results) {
    const extra = r.screenshot ? `${r.screenshot} (${r.screenshotBytes} bytes)` : "";
    console.log(`  [${r.status.toUpperCase()}] ${r.name} ${r.durationMs}ms ${extra}${r.error ? " :: " + r.error : ""}`);
  }
  console.log(`\n結果目錄：${outDir}`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness fatal:", err);
  process.exit(2);
});
