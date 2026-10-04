// 禁硬编码基座具名验收测试（源码层；本仓 runner 是 node:test，无 jsdom 故不渲染 DOM）。
//
// 钉住三件事：
// 1. 范围内三个面（C2 AdminStatistics／B2 ProjectAssetLibraryPanel／D1 LineageDrawer）去注解后
//    **零 CJK**＝元件内没有残留的用户可见硬编文案（解释规则的注解不算违规，同 readCode 惯例）；
// 2. **ui-strings.ts 是唯一来源**：抽样具名文案在 src 下只出现在该档，且元件引用的每个键都存在；
// 3. 中文内容＝改造前逐字原文（UI 视觉零变化），插值行为如约。
//
// 未来上 i18n 时：本档的断言不必改——元件照样零硬编，接缝在 ui-strings.ts 的 `text()`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NUMBER_LOCALE, UI_STRINGS, text, type UiStringKey } from "./ui-strings";

const SCOPE_COMPONENTS = [
  "src/components/admin/AdminStatistics.tsx",
  "src/components/assets/ProjectAssetLibraryPanel.tsx",
  "src/components/lineage/LineageDrawer.tsx",
] as const;

const COPY_MODULE = "src/lib/ui-strings.ts";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 去注解后才做断言（与 statistics-projection.test.ts 的 readCode 同款）。 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 扫活程式码（来源＝repo 扫描地图的活路径；测试档不列入「来源」）。 */
function sourceFiles(): string[] {
  const roots = ["src/lib", "src/components", "src/app", "src/hooks"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  for (const root of roots) walk(join(process.cwd(), root));
  return out;
}

const CJK = /[\u4e00-\u9fff]/;

test("范围内三元件去注解后零 CJK（无硬编用户可见文案）", () => {
  for (const file of SCOPE_COMPONENTS) {
    const offenders = readCode(file)
      .split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => CJK.test(line))
      .map(({ line, index }) => `${index}: ${line.trim()}`);
    assert.deepEqual(offenders, [], `${file} 残留硬编文案（含 CJK）：\n${offenders.join("\n")}`);
  }
});

test("三元件都经唯一取用口 text() 取文案（禁自造第二条取用路径）", () => {
  for (const file of SCOPE_COMPONENTS) {
    const code = readCode(file);
    assert.match(code, /from "@\/lib\/ui-strings"/, `${file} 未从文案单一来源 import`);
    assert.match(code, /\btext\("/, `${file} 未使用 text() 取文案`);
  }
});

test("元件引用的每个 x.y.z 型字面量都必须是文案表既有键（表外词不许上屏）", () => {
  const known = new Set(Object.keys(UI_STRINGS));
  for (const file of SCOPE_COMPONENTS) {
    const code = readCode(file);
    const tokens = new Set<string>();
    for (const match of code.matchAll(/"([a-z][a-z0-9]*(?:\.[a-zA-Z0-9]+)+)"/g)) tokens.add(match[1]);
    assert.ok(tokens.size > 0, `${file} 找不到任何文案键（疑未接基座）`);
    for (const token of tokens) {
      assert.ok(known.has(token), `${file} 引用了文案表没有的键：${token}`);
    }
  }
});

test("唯一来源：抽样具名文案在 src 下只出现在 ui-strings.ts", () => {
  const samples = [
    // REQ-B2b 起副标题改述 copy-on-use 语义（挂用＝建本地副本），抽样跟著现行文案走。
    "挂用＝在本项目建本地副本（改来源不影响副本，删来源副本仍可用）；跨项目复用需先显式分享",
    "已挂用：已在本项目建本地副本并锁定（生成用的是副本）",
    "窗口内没有任何已落账的扣费记录——不做 0 曲线，这里是「无记录」。",
    "已删除 · 曾有引用，记录已不在",
    "来源不明：这条记录没有可恢复的血统登记（存量早于溯源功能，或生成时未携带可解析的来源）。",
    "直接来源超过上限，仅保留最近 5 个（截断已标记）",
    "正在读取资产库…",
    "资料不足（{samples}/{minimum} 样本）",
    "继续向上（当前展开 {depth} 层）",
    "全部数字都是既有账本的只读投影：每个数字都能指回一条 billing_operation / capability 记录，无数据源不画。",
    "没有可见资产 · 去「资源库 / 角色卡」存一个",
    "本项目还没有挂用的资产",
    "未读到任何渠道记录（supplier 表为空或不可达）。",
  ];
  const files = sourceFiles();
  assert.ok(files.length > 500, `扫描档案数异常（${files.length}），疑路径漂移`);
  for (const sample of samples) {
    const hits = files.filter((file) => readFileSync(file, "utf8").includes(sample));
    assert.deepEqual(hits, [join(process.cwd(), COPY_MODULE)], `「${sample}」不是单一来源，命中：${hits.join(", ")}`);
  }
});

test("插值：已知占位符替换，缺参数保留占位符（可诊断，不吐 undefined）", () => {
  assert.equal(text("stats.window.days", { days: 7 }), "近 7 天");
  assert.equal(text("stats.rate.percent", { value: "12.3" }), "12.3%");
  assert.equal(text("lineage.expandMore", { depth: 3 }), "继续向上（当前展开 3 层）");
  assert.equal(text("assets.summary", { total: 4, mounted: 2 }), "共 4 项 · 已挂用 2");
  assert.equal(text("stats.window.days"), "近 {days} 天");
  assert.equal(text("stats.refresh", { unused: 1 }), "刷新");
});

test("文案表本身：每条非空、不含 key 原文、不含未填占位符残渣", () => {
  const keys = Object.keys(UI_STRINGS) as UiStringKey[];
  assert.ok(keys.length >= 70, `文案条数过少（${keys.length}），疑覆盖不全`);
  for (const key of keys) {
    const value = UI_STRINGS[key];
    assert.ok(value.trim().length > 0, `${key} 为空`);
    assert.ok(!value.includes(key), `${key} 的值含 key 原文`);
    assert.doesNotMatch(value, /undefined|\bNaN\b/, `${key} 含未填残渣`);
  }
  // 期数格式化的语言标签与文案同层（未来上 i18n 时一起切）。
  assert.equal(NUMBER_LOCALE, "zh-CN");
});

test("中文内容＝改造前逐字原文（UI 视觉零变化）", () => {
  // D1 两态 + 溯源文案。
  assert.equal(text("lineage.status.deleted"), "已删除 · 曾有引用，记录已不在");
  assert.equal(text("lineage.status.unscanned"), "查无 · 本范围扫描不完整");
  assert.equal(text("lineage.status.unknownOrigin"), "来源不明 · 未登记血统");
  // C2 三态与样本不足。
  assert.equal(text("stats.liveness.available"), "可用");
  assert.equal(text("stats.liveness.unavailable"), "不可用");
  assert.equal(text("stats.liveness.unknown"), "无法判定");
  assert.equal(text("stats.rate.insufficient", { samples: 1, minimum: 3 }), "资料不足（1/3 样本）");
  assert.equal(text("stats.card.ledgerSource"), "billing_operation commit+refund/applied");
  // B2 面板。
  assert.equal(text("assets.title"), "项目资产库");
  assert.equal(text("assets.mount.release"), "已挂用 · 解除");
  assert.equal(text("assets.share.existing"), "此前已分享过该项目（幂等，未重复建记录）");
});
