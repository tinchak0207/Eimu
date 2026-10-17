/**
 * 生成 Eimu OpenUI 的网关 system prompt（2026-10-18 重写：紧凑版）。
 *
 * 用法（仓库根目录）：
 *   npx tsx tools/gen-openui-prompt.mts           # 生成并自检
 *   npx tsx tools/gen-openui-prompt.mts --check   # 只比对现档是否最新（CI/发布前）
 *
 * 输出：deploy-staging/gateway/openui-system-prompt.txt（网关注入用的构建产物，进版本库）
 *
 * 同源保证：组件签名行逐字取自 `generateSystemPrompt(eimuLibrary.toSpec())`，
 * 白名单行取自 `catalog.ts` 的 OPENUI_COMPONENTS；脚本断言两者集合相等、
 * 提示词里出现的每个 `Name(` 都在白名单内、两个示例都能被同一个 eimuLibrary
 * 解析且 0 错误。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createParser, generateSystemPrompt } from "@openuidev/react-lang";

const require = createRequire(import.meta.url);
const { eimuLibrary, eimuPromptOptions } = require("../src/lib/openui/eimu-library.ts") as {
  eimuLibrary: import("@openuidev/react-lang").Library;
  eimuPromptOptions: import("@openuidev/react-lang").PromptOptions;
};
const { OPENUI_COMPONENTS, OPENUI_ACTIONS } = require("../src/lib/openui/catalog.ts") as {
  OPENUI_COMPONENTS: readonly string[];
  OPENUI_ACTIONS: readonly string[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(repoRoot, "deploy-staging/gateway/openui-system-prompt.txt");
const MAX_CHARS = 7_000;

const RULES_FULL =
  "{required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}";

/** 去掉末尾的 `, value?: $binding<...>` / `, visible?: $binding<...>`（按尖括号配平，支持嵌套泛型）。 */
function stripBindingParams(sig: string): string {
  let out = sig;
  for (const key of [", value?: $binding<", ", visible?: $binding<"]) {
    let at = out.indexOf(key);
    while (at >= 0) {
      let i = at + key.length;
      let depth = 1;
      while (i < out.length && depth > 0) {
        if (out[i] === "<") depth += 1;
        else if (out[i] === ">") depth -= 1;
        i += 1;
      }
      out = out.slice(0, at) + out.slice(i);
      at = out.indexOf(key);
    }
  }
  return out;
}

/** 从官方生成结果里只取「组件签名」行，并做无损压缩。 */
function extractSignatures(full: string): string[] {
  const lines = full.split("\n");
  const sigs: string[] = [];
  for (const line of lines) {
    const m = /^([A-Z][A-Za-z]*)\(/.exec(line);
    if (!m || !OPENUI_COMPONENTS.includes(m[1])) continue;
    let s = line.split(RULES_FULL).join("Rules");
    s = s.replace("Vertical container for all content in a chat response.", "Vertical container for the whole openui block.");
    s = stripBindingParams(s);
    // 描述只留第一句（句号后接大写才算句末，避免切断 e.g.），最长 90 字符
    const dash = s.indexOf(") — ");
    if (dash > 0) {
      const head = s.slice(0, dash + 1);
      let desc = s.slice(dash + 4).split(/(?<=\.)\s(?=[A-Z])/)[0];
      if (desc.length > 90) desc = `${desc.slice(0, 87)}...`;
      s = `${head} — ${desc}`;
    }
    sigs.push(s);
  }
  return sigs;
}

const EXAMPLE_FORM = [
  "root = Card([hdr, form])",
  'hdr = CardHeader("生成参数", "选好后点生成")',
  'form = Form("gen_params", btns, [f1, f2, f3])',
  'btns = Buttons([Button("按这组参数生成", @ToAssistant("按当前参数生成"), "primary")])',
  'f1 = FormControl("风格", style)',
  'style = Select("style", [s1, s2, s3], "选择风格")',
  's1 = SelectItem("real", "写实摄影")',
  's2 = SelectItem("anime", "日系动画")',
  's3 = SelectItem("ink", "水墨")',
  'f2 = FormControl("比例", ratio)',
  'ratio = RadioGroup("ratio", [r1, r2], "16:9")',
  'r1 = RadioItem("横屏 16:9", "适合电脑观看", "16:9")',
  'r2 = RadioItem("竖屏 9:16", "适合手机短视频", "9:16")',
  'f3 = FormControl("时长（秒）", dur)',
  'dur = Slider("seconds", "discrete", 5, 15, 5, [10])',
].join("\n");

const EXAMPLE_PICK = [
  "root = Card([hdr, picks])",
  'hdr = CardHeader("先定个风格")',
  'picks = Buttons([b1, b2, b3])',
  'b1 = Button("写实摄影", @ToAssistant("用写实摄影风格"), "secondary")',
  'b2 = Button("日系动画", @ToAssistant("用日系动画风格"), "secondary")',
  'b3 = Button("水墨", @ToAssistant("用水墨风格"), "secondary")',
].join("\n");

function buildPrompt(signatures: string[]): string {
  return [
    "## OpenUI 交互块（可选）",
    "只有当用户需要做选择或调参数时（选风格/模型/比例/时长、比较几个方案、从多张图里挑），才在正常中文回复的末尾附加一个 ```openui 围栏块；其余所有情况照常用中文说人话，不要输出 openui。",
    "- 围栏外照常写简短中文说明（≤60字）。绝不在围栏外写 openui 语句；一次回复最多一个 openui 块；不要把整个回复写成程序。",
    "- 围栏内第一行必须是 `root = Card([...])`；每行一条语句 `名字 = 表达式`；参数严格按签名位置传，禁止 `key: value` 写法。",
    "- 引用的名字都要定义；定义的名字都要能从 root 引用到，否则不渲染。",
    `- 只能使用以下组件（白名单，名字和大小写必须完全一致，不许自造）：${OPENUI_COMPONENTS.join(", ")}。动作只有 ${OPENUI_ACTIONS.map((a) => `@${a}`).join(" / ")}。`,
    '- 表单：`Form(name, Buttons([...]), [FormControl...])`，每个字段一个 FormControl，恰好一个 "primary" 提交按钮且动作是 @ToAssistant("...")；表单取值由客户端自动附在消息后，不要手写取值。',
    "- 表单外的快捷选项用 Buttons + secondary Button + @ToAssistant。",
    "- 图片只用对话或工具结果里的真实 URL（ImageBlock 单张、ImageGallery 多张）；没有真实 URL 就不放图片组件，也不要用 Markdown 图片语法。",
    "- 布局要在手机宽度（约 360px）可读：选项 ≤6 个，文案简短。",
    "",
    `### 组件签名（? 为可选参数；Rules = ${RULES_FULL}）`,
    ...signatures,
    "",
    "### 示例 1：生成参数面板",
    "```openui",
    EXAMPLE_FORM,
    "```",
    "",
    "### 示例 2：快捷选择",
    "```openui",
    EXAMPLE_PICK,
    "```",
    "",
  ].join("\n");
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const full = generateSystemPrompt({ library: eimuLibrary.toSpec(), promptOptions: eimuPromptOptions });
const signatures = extractSignatures(full);
const prompt = buildPrompt(signatures);

// ── 自检 ──
const sigNames = signatures.map((s) => /^([A-Z][A-Za-z]*)\(/.exec(s)![1]).sort();
const want = [...OPENUI_COMPONENTS].sort();
if (JSON.stringify(sigNames) !== JSON.stringify(want)) {
  fail(`签名组件 ≠ catalog 白名单\n  sig=${sigNames.join(",")}\n  cat=${want.join(",")}`);
}
const registered = Object.keys(eimuLibrary.components).sort();
if (JSON.stringify(registered) !== JSON.stringify(want)) {
  fail(`eimuLibrary 注册组件 ≠ catalog 白名单\n  lib=${registered.join(",")}`);
}
const allowed = new Set<string>([...OPENUI_COMPONENTS, ...OPENUI_ACTIONS, "Action"]);
const mentioned = new Set([...prompt.matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map((m) => m[1]));
const stray = [...mentioned].filter((n) => !allowed.has(n));
if (stray.length) fail(`提示词里出现白名单外的组件：${stray.join(", ")}`);
// 签名的参数部分里出现的大写类型名必须都在白名单（防 `topContent?: Icon | Image` 这类漏网）。
const { openuiChatLibrary } = require("@openuidev/react-ui") as { openuiChatLibrary: { components: Record<string, unknown> } };
const chatNames = new Set(Object.keys(openuiChatLibrary.components));
for (const sig of signatures) {
  const head = sig.split(") — ")[0];
  const bad = [...head.matchAll(/\b([A-Z][A-Za-z]+)\b/g)].map((m) => m[1]).filter((n) => chatNames.has(n) && !allowed.has(n));
  if (bad.length) fail(`签名引用白名单外组件 ${bad.join(",")}：${head}`);
  if (/\$binding|>\)/.test(head)) fail(`签名压缩残留：${head}`);
}
for (const pattern of [/ENTIRE/i, /no markdown/i, /Every response is/i, /entire response/i]) {
  if (pattern.test(prompt)) fail(`残留「整段回复即程序」措辞：${pattern}`);
}
const parser = createParser(eimuLibrary.toJSONSchema());
for (const [label, ex] of [["form", EXAMPLE_FORM], ["pick", EXAMPLE_PICK]] as const) {
  const r = parser.parse(ex);
  if (!r.root || r.meta.errors.length || r.meta.incomplete) {
    fail(`示例 ${label} 解析失败：${JSON.stringify(r.meta.errors)}`);
  }
}
if (prompt.length > MAX_CHARS) fail(`提示词 ${prompt.length} 字符 > ${MAX_CHARS}`);

if (process.argv.includes("--check")) {
  const current = readFileSync(outFile, "utf8");
  if (current !== prompt) fail(`${outFile} 不是最新：请跑 npx tsx tools/gen-openui-prompt.mts`);
  console.log(`openui prompt up to date (${prompt.length} chars)`);
} else {
  writeFileSync(outFile, prompt, "utf8");
  console.log(`openui prompt written: ${outFile}`);
  console.log(`chars: ${prompt.length}  approx tokens: ${Math.ceil(prompt.length / 2.2)}`);
  console.log(`components: ${OPENUI_COMPONENTS.length}  examples: 2 (parsed, 0 errors)`);
}
