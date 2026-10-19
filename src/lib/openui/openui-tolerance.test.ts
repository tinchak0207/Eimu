// OpenUI 容错回归锁（2026-10-18）：
//   ① repair：别名/大小写/模糊映射、命名参数、按钮错位、补 root、未知组件可见降级——
//      每条都用与渲染器同一个 eimuLibrary 的解析器验证「修完能解析出 root」；
//   ② 裸 DSL 识别：未套围栏的程序被包成 ```openui bare，普通正文不误伤，流式尾行不闪；
//   ③ 回传路径：@ToAssistant + 表单取值 → 发出的消息文本；
//   ④ 同源：catalog 白名单 = eimuLibrary 注册组件 = 网关提示词里列出的白名单。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { OPENUI_COMPONENTS } from "./catalog";
import { repairOpenUISource, resolveComponentName } from "./repair";
import { buildOpenUIActionMessage, safeOpenUrl } from "./action-message";
import { fenceBareOpenUI, isBareOpenUIInfo, isOpenUILang, parseAgentMarkdown } from "../agent-markdown";

const require = createRequire(import.meta.url);
const { createParser } = require("@openuidev/react-lang") as typeof import("@openuidev/react-lang");
const { eimuLibrary, eimuArgOrder } = require("./eimu-library.ts") as typeof import("./eimu-library");
const parser = createParser(eimuLibrary.toJSONSchema());

function repairAndParse(code: string) {
  const r = repairOpenUISource(code, eimuArgOrder);
  const p = parser.parse(r.code);
  return { r, p };
}

test("合规程序是恒等变换（逐字不变）", () => {
  const code = 'root = Card([h])\nh = CardHeader("标题")';
  const r = repairOpenUISource(code, eimuArgOrder);
  assert.equal(r.changed, false);
  assert.equal(r.code, code);
});

test("大小写错：card/cardheader → 解析出 root 且 0 错误", () => {
  const { r, p } = repairAndParse('root = card([h])\nh = cardheader("标题")');
  assert.ok(p.root, r.code);
  assert.equal(p.meta.errors.length, 0, JSON.stringify(p.meta.errors));
});

test("常见误名：Dropdown/Option/ButtonGroup → Select/SelectItem/Buttons", () => {
  const code = [
    "root = Card([f])",
    'f = Form("p", btns, [c])',
    'btns = ButtonGroup([Button("生成", @ToAssistant("生成"), "primary")])',
    'c = FormControl("风格", s)',
    's = Dropdown("style", [o1, o2])',
    'o1 = Option("a", "写实")',
    'o2 = Option("b", "动画")',
  ].join("\n");
  const { r, p } = repairAndParse(code);
  assert.ok(p.root);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
});

test("模糊拼写：Calout → Callout；Slidr → 已移除（删除）；歧义短名不乱映射", () => {
  // 2026-10-18 成品展示层改造：Slider 等表单组件移出白名单，拼错的也按已移除处理。
  assert.deepEqual(resolveComponentName("Slidr"), { kind: "removed", via: "alias" });
  assert.deepEqual(resolveComponentName("Calout"), { kind: "component", name: "Callout", via: "fuzzy" });
  assert.equal(resolveComponentName("Xyz"), null);
});

test("命名参数 → 位置参数：CardHeader(title: …, subtitle = …)", () => {
  const { r, p } = repairAndParse('root = Card([h])\nh = CardHeader(subtitle: "副", title = "主")');
  assert.ok(p.root);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
  assert.match(r.code, /CardHeader\("主", "副"\)/);
});

test("按钮错位 Button(label, \"primary\", @Action) 与字符串动作被纠正", () => {
  const { r, p } = repairAndParse('root = Card([b])\nb = Buttons([Button("生成", "primary", @toAssistant("生成")), Button("换一个", "换一个风格")])');
  assert.ok(p.root);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
  assert.match(r.code, /Button\("生成", @ToAssistant\("生成"\), "primary"\)/);
  assert.match(r.code, /Button\("换一个", @ToAssistant\("换一个风格"\)\)/);
});

test("Slider defaultValue 写成数字 → [数字]", () => {
  const code = [
    "root = Card([f])",
    'f = Form("p", Buttons([Button("好", @ToAssistant("好"), "primary")]), [c])',
    'c = FormControl("时长", Slider("sec", "discrete", 5, 15, 5, 10))',
  ].join("\n");
  const { r, p } = repairAndParse(code);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
});

test("已移除的文字类组件 → TextContent，Image → ImageResult", () => {
  const { r, p } = repairAndParse('root = Card([t, b, i])\nt = Text("说明文字")\nb = BoldText("text", "加粗")\ni = Image("示意", "https://example.com/a.png")');
  assert.ok(p.root);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
  assert.match(r.code, /TextContent\("说明文字"\)/);
  assert.match(r.code, /ImageResult\("https:\/\/example.com\/a.png"\)/);
});

test("映射不了的组件 → 可见 Callout（带原文字），不静默丢", () => {
  const { r, p } = repairAndParse('root = Card([h, x])\nh = CardHeader("标题")\nx = FancyWidget3D("旋转木马", "第二段文字")');
  assert.ok(p.root);
  assert.equal(p.meta.errors.length, 0, `${r.code}\n${JSON.stringify(p.meta.errors)}`);
  assert.match(r.code, /Callout\("warning", "未识别组件：FancyWidget3D", "旋转木马\\n第二段文字"\)/);
  assert.ok(r.notes.some((n) => n.kind === "unknown-component" && n.detail === "FancyWidget3D"));
});

test("缺 root：首句是 Card → root 指向它；首句非 Card → 外包 Card", () => {
  const a = repairAndParse('main = Card([h])\nh = CardHeader("标题")');
  assert.ok(a.p.root, a.r.code);
  const b = repairAndParse('root = Buttons([Button("a", @ToAssistant("a"))])');
  assert.ok(b.p.root, b.r.code);
  assert.equal(b.p.meta.errors.length, 0, `${b.r.code}\n${JSON.stringify(b.p.meta.errors)}`);
});

test("流式半截尾句原样保留，不做根修复（避免跳变）", () => {
  const partial = 'root = Card([h, f])\nh = CardHeader("标题")\nf = Form("p", btns, [c1';
  const r = repairOpenUISource(partial, eimuArgOrder);
  assert.equal(r.code, partial);
});

test("完全不可解析的输入：repair 不抛错，原样返回", () => {
  for (const junk of ["root = Card([", "))))", "这不是程序", 'root = "unterminated']) {
    const r = repairOpenUISource(junk, eimuArgOrder);
    assert.equal(typeof r.code, "string");
  }
});

// ── 裸 DSL 识别 ──
const BARE = [
  "好的，先选个风格：",
  "root = Card([hdr, picks])",
  'hdr = CardHeader("选风格")',
  'picks = Buttons([Button("写实", @ToAssistant("写实"), "secondary")])',
  "",
  "选好告诉我。",
].join("\n");

test("裸 DSL：被包成 ```openui bare，前后中文正文保留", () => {
  const blocks = parseAgentMarkdown(BARE);
  const code = blocks.find((b) => b.type === "code");
  assert.ok(code && code.type === "code");
  assert.ok(isOpenUILang(code.lang) && isBareOpenUIInfo(code.lang), String(code.lang));
  assert.match(code.text, /^root = Card/);
  assert.ok(!code.text.includes("选好告诉我"));
  const paras = blocks.filter((b) => b.type === "p").length;
  assert.ok(paras >= 2);
});

test("裸 DSL：已在围栏里的不重复包；普通正文与 a = b 式算式不误伤", () => {
  const fenced = "说明\n```openui\nroot = Card([h])\nh = CardHeader(\"x\")\n```";
  assert.equal(fenceBareOpenUI(fenced), fenced);
  const prose = "把 root = 根目录 记下来。\nx = 1 + 2\n普通一句话。";
  assert.equal(fenceBareOpenUI(prose), prose);
});

test("裸 DSL：流式末行只有 `root =` 也先进块（不先闪纯文本）", () => {
  const out = fenceBareOpenUI("好的：\nroot =");
  assert.match(out, /```openui bare\nroot =\n```/);
});

test("围栏语言名变体：openui-lang / OpenUI / 无语言但内容是程序", () => {
  assert.ok(isOpenUILang("openui-lang"));
  assert.ok(isOpenUILang(" OpenUI title=x"));
  const blocks = parseAgentMarkdown("```\nroot = Card([h])\nh = CardHeader(\"x\")\n```");
  const code = blocks.find((b) => b.type === "code");
  assert.ok(code && code.type === "code" && isBareOpenUIInfo(code.lang));
  const js = parseAgentMarkdown("```js\nconst a = 1\n```").find((b) => b.type === "code");
  assert.ok(js && js.type === "code" && !isOpenUILang(js.lang));
});

// ── 回传路径 ──
test("回传：@ToAssistant + 表单取值 → 中文前缀附录（网关清洗不吞）", () => {
  const msg = buildOpenUIActionMessage({
    type: "continue_conversation",
    humanFriendlyMessage: "按当前参数生成",
    formState: {
      gen_params: {
        style: { value: "anime", componentType: "Select" },
        ratio: { value: "9:16", componentType: "RadioGroup" },
        seconds: { value: [10], componentType: "Slider" },
        tags: { value: { 夜景: true, 雨: false }, componentType: "CheckBoxGroup" },
      },
    },
  });
  assert.equal(msg, "按当前参数生成\n当前表单取值：style=anime；ratio=9:16；seconds=10；tags=夜景");
});

test("回传：快捷按钮只发按钮消息；空消息不发；open_url 只放行 http(s)", () => {
  assert.equal(buildOpenUIActionMessage({ type: "continue_conversation", params: { message: "用水墨风格" } }), "用水墨风格");
  assert.equal(buildOpenUIActionMessage({ type: "continue_conversation", humanFriendlyMessage: "  " }), null);
  assert.equal(buildOpenUIActionMessage({ type: "open_url", params: { url: "https://a.b" } }), null);
  assert.equal(safeOpenUrl("javascript:alert(1)"), null);
  assert.equal(safeOpenUrl("https://eimu.dev/x"), "https://eimu.dev/x");
});

// ── 同源 ──
test("同源：catalog = eimuLibrary 注册组件 = 网关提示词白名单行", () => {
  const lib = Object.keys(eimuLibrary.components).sort();
  assert.deepEqual(lib, [...OPENUI_COMPONENTS].sort());
  const prompt = readFileSync(new URL("../../../deploy-staging/gateway/openui-system-prompt.txt", import.meta.url), "utf8");
  const line = prompt.split("\n").find((l) => l.includes("只能使用以下组件"));
  assert.ok(line);
  const listed = line!.split("：")[1].split("。")[0].split(", ").map((s) => s.trim()).sort();
  assert.deepEqual(listed, [...OPENUI_COMPONENTS].sort());
  assert.ok(prompt.length <= 25000); // 2026-10-18 富展示：预算放宽到约 25k
  assert.ok(!/ENTIRE|entire response/i.test(prompt));
});
