// refactor-audit.ts — 无损重构机械等价审计
// 用法：bun run refactor-audit.ts <baseline.ts> <newIndex.ts> [module2.ts module3.ts ...]
// 原理：基线档 vs {新 index.ts + 全部新模组} 的「语义行多重集」必须完全相等。
// 语义行 = 剥离注释行后，去掉行首 `export ` 前缀、去掉 import 语句（跨模组补线）、
// 去掉纯 import 相关的新增行。任何缺失/多出的逻辑行都会被列出。
// 白名单（显式登记的等价改写，例如整合时剥掉冗余 import）以 exact-line 形式登记。

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: bun run refactor-audit.ts <baseline.ts> <newIndex.ts> [more.ts ...]");
  process.exit(2);
}

const WHITELIST_MISSING: string[] = [
  // 登记基线中有、新集合中「允许」没有的行（整行 trim 后精确匹配）。
  // 仅用于：基线 import 语句被整并、已宣布的等价改写。逐条附理由注释。
];

function semanticLines(path: string): { lines: string[]; count: number } {
  const raw = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let inImport = false;
  for (let line of raw) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) continue;
    // 多行 import 块：从 `import {` 起整块跳过（跨模组补线，非语义行）
    if (inImport) {
      if (/from\s+["'][^"']+["']\s*;?\s*$/.test(trimmed)) inImport = false;
      continue;
    }
    if (/^import(\s+type)?\s/.test(trimmed)) {
      if (/\{\s*$/.test(trimmed) && !/from\s+["'][^"']+["']/.test(trimmed)) inImport = true;
      continue;
    }
    // 再导出行（组合根桥接）：export { X } from "./y.ts" / export * from ...
    if (/^export\s+(type\s*)?(\{[^}]*\}|\*)\s+from\s+["']/.test(trimmed)) continue;
    // 剥离 export 前缀（函数/常量/型别搬到模组后补的关键字）
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
  console.log("\n[audit] FAIL — 行多重集不等价，重构非无损");
  process.exit(1);
}
console.log("\n[audit] PASS — 行多重集完全等价（无损证明成立）");
