// OpenUI 富展示回归锁（2026-10-18）：
//   ① 6 条示范程序：repair 恒等 + 解析 0 错误（网关提示词与演示页同源）；
//   ② Query：只许 artifact/artifacts 两个只读工具；第 3 参默认值（手写假数据入口）被丢弃；
//   ③ 数据组件：Table/Col/图表/Series 的数据位只许引用 Query 结果，字面量数字整件删除；
//   ④ Badge/Callout 文字里的字面量数字整件删除；字段引用（m.duration）保留；
//   ⑤ 预览纯函数：LRC → 歌词片段、采样 → 波形峰值；元数据纯函数：曲序/扣费/模型。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { OPENUI_COMPONENTS, OPENUI_TOOLS } from "./catalog";
import { repairOpenUISource } from "./repair";
import { RICH_EXAMPLES, fillRichExample } from "./rich-examples";
import { lyricPreviewLines, peaksFromSamples } from "./artifact-preview";

const require = createRequire(import.meta.url);
const { createParser } = require("@openuidev/react-lang") as typeof import("@openuidev/react-lang");
const { eimuLibrary, eimuArgOrder, eimuToolSpecs } = require("./eimu-library.ts") as typeof import("./eimu-library");
const parser = createParser(eimuLibrary.toJSONSchema());
const IDS = ["TASK_ID_1", "TASK_ID_2", "TASK_ID_3", "TASK_ID_4"];

function fix(code: string) {
  const r = repairOpenUISource(code, eimuArgOrder);
  const p = parser.parse(r.code);
  return { ...r, root: Boolean(p.root), errors: p.meta.errors };
}

test("示范程序：repair 恒等 + 解析 0 错误，且字符串里没有数字", () => {
  assert.ok(RICH_EXAMPLES.length >= 4 && RICH_EXAMPLES.length <= 6);
  for (const ex of RICH_EXAMPLES) {
    const code = fillRichExample(ex.code, IDS);
    const r = fix(code);
    assert.equal(r.changed, false, `${ex.key}: ${JSON.stringify(r.notes)}`);
    assert.ok(r.root, ex.key);
    assert.deepEqual(r.errors, [], ex.key);
    const strs = [...code.replace(/TASK_ID_\d/g, "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    assert.ok(!strs.some((s) => /\d/.test(s)), `${ex.key} 字符串含数字`);
  }
});

test("白名单：富展示组件全部注册，表单/控制台类仍不在内", () => {
  for (const name of ["Row", "Grid", "Box", "Carousel", "Tabs", "TabItem", "Title", "Caption", "Badge", "List", "ListItem", "Table", "Col", "BarChart", "Series"]) {
    assert.ok((OPENUI_COMPONENTS as readonly string[]).includes(name), name);
  }
  for (const name of ["Form", "Input", "Slider", "Select", "Steps", "Mutation", "HtmlView"]) {
    assert.ok(!(OPENUI_COMPONENTS as readonly string[]).includes(name), name);
  }
  assert.deepEqual(Object.keys(eimuLibrary.components).sort(), [...OPENUI_COMPONENTS].sort());
  assert.deepEqual(eimuToolSpecs.map((t) => t.name).sort(), [...OPENUI_TOOLS].sort());
});

test("Query：未知工具整条删除；第 3 参默认值被丢弃", () => {
  const bad = fix(`root = Card([t, b])
q = Query("get_orders", {}, {rows: []})
t = Table([Col("x", q.rows.x)])
b = TextContent("ok")`);
  assert.ok(bad.notes.some((n) => n.kind === "removed-component" && n.detail === "Query(get_orders)"));
  assert.ok(!/Query|Table/.test(bad.code), bad.code);
  assert.ok(bad.root);

  const defaults = fix(`root = Card([b])
m = Query("artifact", {taskId: "t1"}, {duration: "2:31"})
b = Badge(m.duration)`);
  assert.ok(defaults.notes.some((n) => n.kind === "query-defaults-dropped"));
  assert.match(defaults.code, /m = Query\("artifact", \{taskId: "t1"\}\)\n/);
  assert.ok(!defaults.code.includes("2:31"));
  assert.ok(defaults.root);
});

test("数据组件：字面量数字/数组整件删除，Query 字段与 @Each 保留", () => {
  const r = fix(`root = Card([t1, c1, ok])
t1 = Table([Col("模型", ["A", "B"]), Col("耗时", [12, 30])])
vals = [1, 2, 3]
c1 = BarChart(["a", "b", "c"], [Series("x", vals)])
arts = Query("artifacts", {kind: "image"})
ok = Table([Col("模型", @Each(arts.rows, "a", a.model)), Col("尺寸", arts.rows.size)])`);
  assert.ok(r.root, r.code);
  assert.ok(!r.code.includes("t1 ="), r.code);
  assert.ok(!r.code.includes("BarChart"), r.code);
  assert.ok(!r.code.includes("vals"), r.code);
  assert.match(r.code, /ok = Table\(\[Col\("模型", @Each\(arts\.rows, "a", a\.model\)\), Col\("尺寸", arts\.rows\.size\)\]\)/);
  assert.deepEqual(r.errors, []);
});

test("Badge / Callout：字面量数字删除，字段引用保留", () => {
  const r = fix(`root = Card([b1, b2, c1, c2])
m = Query("artifact", {taskId: "t1"})
b1 = Badge("30 秒", "info")
b2 = Badge(m.duration, "info")
c1 = Callout("info", "队列", "排队第 3 位")
c2 = Callout("warning", "有一张生成失败", "已自动退款")`);
  assert.ok(r.root);
  assert.ok(!r.code.includes("30 秒") && !r.code.includes("排队"), r.code);
  assert.match(r.code, /b2 = Badge\(m\.duration, "info"\)/);
  assert.match(r.code, /c2 = Callout/);
});

test("成员访问引用不影响孤儿裁剪：被 m.x 引用的 Query 语句保留", () => {
  const r = fix(`root = Card([b, gone])
m = Query("artifact", {taskId: "t1"})
b = Badge(m.resolution)
gone = Slider("x", 1)`);
  assert.match(r.code, /m = Query/);
  assert.ok(!r.code.includes("Slider"));
});

test("歌词片段：去时间戳/段落标记/括号哼唱，取前 4 句；无 LRC 用纯文本", () => {
  const lines = lyricPreviewLines({ lrc: "[00:06.28][Intro]\n[00:06.36]（轻轻哼唱）\n[00:09.93]末班车把我放在站台\n[00:17.96]两只箱子 一个背包\n[00:20.38]<00:20.38>导<00:20.50>航\n[00:25.30]第四句\n[00:30.00]第五句" });
  assert.deepEqual(lines, ["末班车把我放在站台", "两只箱子 一个背包", "导航", "第四句"]);
  assert.deepEqual(lyricPreviewLines({ lrc: "", lyrics_plain: "[Verse 1]\n深山的矿脉\n表面藏着" }), ["深山的矿脉", "表面藏着"]);
  assert.deepEqual(lyricPreviewLines(undefined), []);
});

test("波形峰值：归一化到 0-1，静音返回空", () => {
  const samples = Float32Array.from({ length: 6400 }, (_, i) => (i < 3200 ? 0.5 : -1) * Math.sin(i));
  const peaks = peaksFromSamples(samples, 8);
  assert.equal(peaks.length, 8);
  assert.ok(Math.max(...peaks) === 1 && peaks.every((p) => p >= 0 && p <= 1));
  assert.deepEqual(peaksFromSamples(new Float32Array(100), 8), []);
});

test("网关提示词：同源生成、含 Query 工具说明，组件白名单与 catalog 一致", () => {
  const prompt = readFileSync(new URL("../../../deploy-staging/gateway/openui-system-prompt.txt", import.meta.url), "utf8");
  assert.ok(prompt.length > 5000 && prompt.length <= 25000, String(prompt.length));
  assert.match(prompt, /Query\("artifact", \{taskId:/);
  assert.match(prompt, /不许写 Mutation/);
  for (const name of OPENUI_COMPONENTS) assert.match(prompt, new RegExp(`^${name}\\(`, "m"), name);
  assert.ok(!/realistic|mock data/i.test(prompt));
});
