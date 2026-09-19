// refactor-audit.ts — 無損重構機械等價審計
// 用法：bun run refactor-audit.ts <baseline.ts> <newIndex.ts> [module2.ts module3.ts ...]
// 原理：基線檔 vs {新 index.ts + 全部新模組} 的「語義行多重集」必須完全相等。
// 語義行 = 剝離註釋行後，去掉行首 `export ` 前綴、去掉 import 語句（跨模組補線）、
// 去掉純 import 相關的新增行。任何缺失/多出的邏輯行都會被列出。
// 白名單（顯式登記的等價改寫，例如整合時剝掉冗餘 import）以 exact-line 形式登記。

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: bun run refactor-audit.ts <baseline.ts> <newIndex.ts> [more.ts ...]");
  process.exit(2);
}

const WHITELIST_MISSING: string[] = [
  // 登記基線中有、新集合中「允許」沒有的行（整行 trim 後精確匹配）。
  // 僅用於：基線 import 語句被整併、已宣佈的等價改寫。逐條附理由註釋。
];

function semanticLines(path: string): { lines: string[]; count: number } {
  const raw = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let inImport = false;
  for (let line of raw) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) continue;
    // 多行 import 塊：從 `import {` 起整塊跳過（跨模組補線，非語義行）
    if (inImport) {
      if (/from\s+["'][^"']+["']\s*;?\s*$/.test(trimmed)) inImport = false;
      continue;
    }
    if (/^import(\s+type)?\s/.test(trimmed)) {
      if (/\{\s*$/.test(trimmed) && !/from\s+["'][^"']+["']/.test(trimmed)) inImport = true;
      continue;
    }
    // 再導出行（組合根橋接）：export { X } from "./y.ts" / export * from ...
    if (/^export\s+(type\s*)?(\{[^}]*\}|\*)\s+from\s+["']/.test(trimmed)) continue;
    // 剝離 export 前綴（函數/常量/型別搬到模組後補的關鍵字）
    if (trimmed.startsWith("export ")) {
      line = trimmed.replace(/^export\s+(?=(const|let|var|function|async function|class|type|interface|enum|declare)\b)/, "");
    }
    out.push(line.trimEnd());
  }
  return { lines: out, count: raw.length };
}

function multiset(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

const [baselinePath, ...newPaths] = args;
const base = semanticLines(baselinePath);
const merged: string[] = [];
for (const p of newPaths) merged.push(...semanticLines(p).lines);

const baseSet = multiset(base.lines);
const newSet = multiset(merged);

const missing: string[] = [];
for (const [line, n] of baseSet) {
  const have = newSet.get(line) ?? 0;
  for (let i = 0; i < n - have; i++) missing.push(line);
}
const extra: string[] = [];
for (const [line, n] of newSet) {
  const have = baseSet.get(line) ?? 0;
  for (let i = 0; i < n - have; i++) extra.push(line);
}

const allowedMissing = missing.filter((l) => !WHITELIST_MISSING.includes(l.trim()));
const blocked = allowedMissing.length > 0 || extra.length > 0;

console.log(`[audit] baseline ${baselinePath}: ${base.count} raw lines -> ${base.lines.length} semantic lines`);
for (const p of newPaths) console.log(`[audit] module ${p}: ${semanticLines(p).lines.length} semantic lines`);
console.log(`[audit] merged new-set: ${merged.length} semantic lines (baseline ${base.lines.length})`);
console.log(`[audit] missing (in baseline, not in new set): ${allowedMissing.length}${missing.length - allowedMissing.length > 0 ? ` (+${missing.length - allowedMissing.length} whitelisted)` : ""}`);
console.log(`[audit] extra   (in new set, not in baseline): ${extra.length}`);

if (blocked) {
  console.log("\n=== MISSING ===");
  for (const l of allowedMissing.slice(0, 80)) console.log(`  - ${l.slice(0, 160)}`);
  console.log("\n=== EXTRA ===");
  for (const l of extra.slice(0, 80)) console.log(`  + ${l.slice(0, 160)}`);
  if (allowedMissing.length > 80 || extra.length > 80) console.log("  ... (truncated)");
  console.log("\n[audit] FAIL — 行多重集不等價，重構非無損");
  process.exit(1);
}
console.log("\n[audit] PASS — 行多重集完全等價（無損證明成立）");
