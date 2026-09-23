// 禁硬編碼基座具名驗收測試（源碼層；本倉 runner 是 node:test，無 jsdom 故不渲染 DOM）。
//
// 釘住三件事：
// 1. 範圍內三個面（C2 AdminStatistics／B2 ProjectAssetLibraryPanel／D1 LineageDrawer）去註解後
//    **零 CJK**＝元件內沒有殘留的用戶可見硬編文案（解釋規則的註解不算違規，同 readCode 慣例）；
// 2. **ui-strings.ts 是唯一來源**：抽樣具名文案在 src 下只出現在該檔，且元件引用的每個鍵都存在；
// 3. 中文內容＝改造前逐字原文（UI 視覺零變化），插值行為如約。
//
// 未來上 i18n 時：本檔的斷言不必改——元件照樣零硬編，接縫在 ui-strings.ts 的 `text()`。

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

/** 去註解後才做斷言（與 statistics-projection.test.ts 的 readCode 同款）。 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 掃活程式碼（來源＝repo 掃描地圖的活路徑；測試檔不列入「來源」）。 */
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

test("範圍內三元件去註解後零 CJK（無硬編用戶可見文案）", () => {
  for (const file of SCOPE_COMPONENTS) {
    const offenders = readCode(file)
      .split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => CJK.test(line))
      .map(({ line, index }) => `${index}: ${line.trim()}`);
    assert.deepEqual(offenders, [], `${file} 殘留硬編文案（含 CJK）：\n${offenders.join("\n")}`);
  }
});

test("三元件都經唯一取用口 text() 取文案（禁自造第二條取用路徑）", () => {
  for (const file of SCOPE_COMPONENTS) {
    const code = readCode(file);
    assert.match(code, /from "@\/lib\/ui-strings"/, `${file} 未從文案單一來源 import`);
    assert.match(code, /\btext\("/, `${file} 未使用 text() 取文案`);
  }
});

test("元件引用的每個 x.y.z 型字面量都必須是文案表既有鍵（表外詞不許上屏）", () => {
  const known = new Set(Object.keys(UI_STRINGS));
  for (const file of SCOPE_COMPONENTS) {
    const code = readCode(file);
    const tokens = new Set<string>();
    for (const match of code.matchAll(/"([a-z][a-z0-9]*(?:\.[a-zA-Z0-9]+)+)"/g)) tokens.add(match[1]);
    assert.ok(tokens.size > 0, `${file} 找不到任何文案鍵（疑未接基座）`);
    for (const token of tokens) {
      assert.ok(known.has(token), `${file} 引用了文案表沒有的鍵：${token}`);
    }
  }
});

test("唯一來源：抽樣具名文案在 src 下只出現在 ui-strings.ts", () => {
  const samples = [
    // REQ-B2b 起副標題改述 copy-on-use 語義（掛用＝建本地副本），抽樣跟著現行文案走。
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
  assert.ok(files.length > 500, `掃描檔案數異常（${files.length}），疑路徑漂移`);
  for (const sample of samples) {
    const hits = files.filter((file) => readFileSync(file, "utf8").includes(sample));
    assert.deepEqual(hits, [join(process.cwd(), COPY_MODULE)], `「${sample}」不是單一來源，命中：${hits.join(", ")}`);
  }
});

test("插值：已知佔位符替換，缺參數保留佔位符（可診斷，不吐 undefined）", () => {
  assert.equal(text("stats.window.days", { days: 7 }), "近 7 天");
  assert.equal(text("stats.rate.percent", { value: "12.3" }), "12.3%");
  assert.equal(text("lineage.expandMore", { depth: 3 }), "继续向上（当前展开 3 层）");
  assert.equal(text("assets.summary", { total: 4, mounted: 2 }), "共 4 项 · 已挂用 2");
  assert.equal(text("stats.window.days"), "近 {days} 天");
  assert.equal(text("stats.refresh", { unused: 1 }), "刷新");
});

test("文案表本身：每條非空、不含 key 原文、不含未填佔位符殘渣", () => {
  const keys = Object.keys(UI_STRINGS) as UiStringKey[];
  assert.ok(keys.length >= 70, `文案條數過少（${keys.length}），疑覆蓋不全`);
  for (const key of keys) {
    const value = UI_STRINGS[key];
    assert.ok(value.trim().length > 0, `${key} 為空`);
    assert.ok(!value.includes(key), `${key} 的值含 key 原文`);
    assert.doesNotMatch(value, /undefined|\bNaN\b/, `${key} 含未填殘渣`);
  }
  // 期數格式化的語言標籤與文案同層（未來上 i18n 時一起切）。
  assert.equal(NUMBER_LOCALE, "zh-CN");
});

test("中文內容＝改造前逐字原文（UI 視覺零變化）", () => {
  // D1 兩態 + 溯源文案。
  assert.equal(text("lineage.status.deleted"), "已删除 · 曾有引用，记录已不在");
  assert.equal(text("lineage.status.unscanned"), "查无 · 本范围扫描不完整");
  assert.equal(text("lineage.status.unknownOrigin"), "来源不明 · 未登记血统");
  // C2 三態與樣本不足。
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
