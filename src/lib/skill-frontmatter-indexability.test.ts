/**
 * repo 级 SKILL.md 可收录性守门测试（2026-09-27）。
 *
 * 跑法：npx --yes tsx --test src/lib/skill-frontmatter-indexability.test.ts
 *
 * 背景（VPS opencode 1.18.14 实测，非推论）：
 *   1. frontmatter 在 byte 0（`---`）者 → 收录。
 *   2. byte 0 是 HTML 注解（我方复用纪律的「来源（轮子）」档头）者 → **静默不进索引**
 *      （不是报错，是根本不存在于 skill 清单，物理不可达）。实测指令：
 *      `cd <probe> && opencode debug skill`，probe 内放 comment-first / name-mismatch /
 *      bad-yaml 三种档；结果 comment-first 缺席，另两者都在。
 *   3. `name` ≠ 所属目录名 → **仍收录**（VPS 索引内实例：editor/assembly/SKILL.md 的
 *      name=editor-assembly）。故本测试**刻意不**断言 name==目录名，避免立错规则。
 *   4. frontmatter YAML 不合法（如 description 内未引号的 `: `）→ 仍收录且 description
 *      原文被撷取，故本测试只要求 frontmatter 区块存在且 name/description 非空，
 *      **不**引入 YAML 解析器当 oracle（避免把 opencode 的宽容当成必须）。
 *
 * 为什么放在 repo 测试而不是脚本：禁自造工具；此为 .test.ts，进 `npm test` 的
 * src 递回测试 glob（src 任一层的 .test.ts），改档即被本地测试拦下。
 *
 * 扫描范围：本 repo 自有资产（skills、public/plugin/eimu/skills、plugins 下各外挂的
 * skills），排除 vendored/快取根（node_modules、.git、.next、.asset-cache、
 * workbuddy-linux）——那些不是我方资产，改不得也不该被本测试锁死。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as nodePath from "node:path";

const REPO_ROOT = process.cwd();

/** vendored / 快取 / 产物根：非我方资产，不纳入断言。 */
const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".asset-cache",
  "workbuddy-linux",
]);

function collectSkillFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      collectSkillFiles(nodePath.join(dir, ent.name), out);
    } else if (ent.isFile() && ent.name === "SKILL.md") {
      out.push(nodePath.join(dir, ent.name));
    }
  }
  return out;
}

const SKILL_FILES = collectSkillFiles(REPO_ROOT).sort();

test("SKILL.md 普查非空集合（防扫描器静默归零的假绿）", () => {
  // 2026-09-27 基线：本 repo 共 147 份 SKILL.md（含 vendored），本测试纳入自有资产 128 份。
  // 若扫描逻辑退化（cwd 不对、skip 名单过宽），此断言会先红，不让下面的回圈空跑成绿。
  assert.ok(
    SKILL_FILES.length >= 100,
    `扫描到的 SKILL.md 仅 ${SKILL_FILES.length} 份，低于预期下限 100——扫描器可能失效`,
  );
  for (const p of SKILL_FILES) {
    assert.ok(p.startsWith(REPO_ROOT), `扫描越界（非 repo 内档案）：${p}`);
  }
});

test("每份 SKILL.md 的 YAML frontmatter 必须在 byte 0（否则 opencode 静默不收录）", () => {
  const dead: string[] = [];
  for (const p of SKILL_FILES) {
    const buf = readFileSync(p);
    const b0 = buf.subarray(0, 3).toString("utf8");
    if (b0 !== "---") {
      const head = buf.subarray(0, 40).toString("utf8").replace(/\n/g, "\\n");
      dead.push(`${nodePath.relative(REPO_ROOT, p)}（byte0=${JSON.stringify(head)}）`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `以下 SKILL.md 的 byte 0 不是 '---'，opencode 不会把它们收进 skill 索引（前置 HTML 注解／标题／引用块都会导致静默死亡）：\n` +
      dead.map((d) => `  - ${d}`).join("\n") +
      `\n修法：把 frontmatter 之前的注解块整块搬到 frontmatter 之后（纯位移，正文一字不改）。`,
  );
});

test("每份 SKILL.md 的 frontmatter 区块含非空 name 与 description", () => {
  for (const p of SKILL_FILES) {
    const rel = nodePath.relative(REPO_ROOT, p);
    const body = readFileSync(p, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(body);
    assert.ok(fm, `${rel} 缺 frontmatter 收尾 '---'（区块不完整）`);
    assert.match(fm[1], /^name:\s*\S+/m, `${rel} frontmatter 缺非空 name`);
    assert.match(fm[1], /^description:\s*\S+/m, `${rel} frontmatter 缺非空 description`);
  }
});
