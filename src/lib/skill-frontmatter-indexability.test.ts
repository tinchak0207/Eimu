/**
 * repo 級 SKILL.md 可收錄性守門測試（2026-09-27）。
 *
 * 跑法：npx --yes tsx --test src/lib/skill-frontmatter-indexability.test.ts
 *
 * 背景（VPS opencode 1.18.14 實測，非推論）：
 *   1. frontmatter 在 byte 0（`---`）者 → 收錄。
 *   2. byte 0 是 HTML 註解（我方複用紀律的「來源（輪子）」檔頭）者 → **靜默不進索引**
 *      （不是報錯，是根本不存在於 skill 清單，物理不可達）。實測指令：
 *      `cd <probe> && opencode debug skill`，probe 內放 comment-first / name-mismatch /
 *      bad-yaml 三種檔；結果 comment-first 缺席，另兩者都在。
 *   3. `name` ≠ 所屬目錄名 → **仍收錄**（VPS 索引內實例：editor/assembly/SKILL.md 的
 *      name=editor-assembly）。故本測試**刻意不**斷言 name==目錄名，避免立錯規則。
 *   4. frontmatter YAML 不合法（如 description 內未引號的 `: `）→ 仍收錄且 description
 *      原文被擷取，故本測試只要求 frontmatter 區塊存在且 name/description 非空，
 *      **不**引入 YAML 解析器當 oracle（避免把 opencode 的寬容當成必須）。
 *
 * 為什麼放在 repo 測試而不是腳本：禁自造工具；此為 .test.ts，進 `npm test` 的
 * src 遞迴測試 glob（src 任一層的 .test.ts），改檔即被本地測試攔下。
 *
 * 掃描範圍：本 repo 自有資產（skills、public/plugin/eimu/skills、plugins 下各外掛的
 * skills），排除 vendored/快取根（node_modules、.git、.next、.asset-cache、
 * workbuddy-linux）——那些不是我方資產，改不得也不該被本測試鎖死。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as nodePath from "node:path";

const REPO_ROOT = process.cwd();

/** vendored / 快取 / 產物根：非我方資產，不納入斷言。 */
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

test("SKILL.md 普查非空集合（防掃描器靜默歸零的假綠）", () => {
  // 2026-09-27 基線：本 repo 共 147 份 SKILL.md（含 vendored），本測試納入自有資產 128 份。
  // 若掃描邏輯退化（cwd 不對、skip 名單過寬），此斷言會先紅，不讓下面的迴圈空跑成綠。
  assert.ok(
    SKILL_FILES.length >= 100,
    `掃描到的 SKILL.md 僅 ${SKILL_FILES.length} 份，低於預期下限 100——掃描器可能失效`,
  );
  for (const p of SKILL_FILES) {
    assert.ok(p.startsWith(REPO_ROOT), `掃描越界（非 repo 內檔案）：${p}`);
  }
});

test("每份 SKILL.md 的 YAML frontmatter 必須在 byte 0（否則 opencode 靜默不收錄）", () => {
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
    `以下 SKILL.md 的 byte 0 不是 '---'，opencode 不會把它們收進 skill 索引（前置 HTML 註解／標題／引用塊都會導致靜默死亡）：\n` +
      dead.map((d) => `  - ${d}`).join("\n") +
      `\n修法：把 frontmatter 之前的註解塊整塊搬到 frontmatter 之後（純位移，正文一字不改）。`,
  );
});

test("每份 SKILL.md 的 frontmatter 區塊含非空 name 與 description", () => {
  for (const p of SKILL_FILES) {
    const rel = nodePath.relative(REPO_ROOT, p);
    const body = readFileSync(p, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(body);
    assert.ok(fm, `${rel} 缺 frontmatter 收尾 '---'（區塊不完整）`);
    assert.match(fm[1], /^name:\s*\S+/m, `${rel} frontmatter 缺非空 name`);
    assert.match(fm[1], /^description:\s*\S+/m, `${rel} frontmatter 缺非空 description`);
  }
});
