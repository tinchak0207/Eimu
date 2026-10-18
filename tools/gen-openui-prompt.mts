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
 * 提示词里出现的每个 `Name(` 都在白名单内、全部示例都能被同一个 eimuLibrary
 * 解析且 0 错误；提示词不得出现已移除的表单/控制台组件调用。
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

// 示例里的 TASK_ID_x 只是占位：模型必须换成本会话任务表里的真实 task_id。
const EXAMPLE_BLIND = [
  "root = Card([hdr, pick])",
  'hdr = CardHeader("四版海报已出", "先盲选，再看参数")',
  'pick = CompareView(["TASK_ID_1", "TASK_ID_2", "TASK_ID_3", "TASK_ID_4"], "blind", "哪一版最接近你想要的？")',
].join("\n");

const EXAMPLE_VIDEO = [
  "root = Card([hdr, player, more])",
  'hdr = CardHeader("成片已交付", "30 秒竖屏短片")',
  'player = VideoPlayer("TASK_ID_1", "终版成片，已过独立评审")',
  'more = Buttons([Button("再来一版", @ToAssistant("同样要求再做一版成片"), "secondary")])',
].join("\n");

const EXAMPLE_ALBUM = [
  "root = Card([hdr, album])",
  'hdr = CardHeader("专辑已完成", "三首成曲")',
  'album = AlbumPlayer("专辑名", ["TASK_ID_1", "TASK_ID_2", "TASK_ID_3"], "点曲目可看滚动歌词")',
].join("\n");

const EXAMPLE_AB = [
  "root = Card([hdr, ab])",
  'hdr = CardHeader("A/B 对比", "同一需求两种风格")',
  'ab = CompareView(["TASK_ID_1", "TASK_ID_2"], "side")',
].join("\n");

const EXAMPLES: Array<[string, string]> = [
  ["示例 1：多图盲选", EXAMPLE_BLIND],
  ["示例 2：视频交付", EXAMPLE_VIDEO],
  ["示例 3：专辑播放器", EXAMPLE_ALBUM],
  ["示例 4：A/B 对比", EXAMPLE_AB],
];

function buildPrompt(signatures: string[]): string {
  return [
    "## OpenUI 成品展示层（可选）",
    "OpenUI 只用于展示本会话已经产出的真实成品：多图画廊/盲选、视频播放与交付、单曲/专辑播放、A/B 对比。只有本轮或上下文里已有真实产物（工具结果或会话任务表里有 task_id）时，才在正常中文回复末尾附加一个 ```openui 围栏块；没有成品就不出 UI，照常用中文回复。",
    "- 参数、风格、比例、时长、分镜、设计全部由你自己决定；绝不输出参数表单、设置面板、创作控制台、仪表盘或流程步骤条，也不让用户填写任何字段。",
    "- 绝不编造状态、队列、进度、引擎、计费、价格、张数或任何数字；文字里出现的事实与数字只能来自本轮工具结果。",
    "- 用户要「复杂 UI」「渲染个界面」「能力演示」时，用一句话说明 OpenUI 是成品展示层；有已有产物就用它展示，没有就先把成品做出来，不做假控制台。",
    "- 成品组件只收 taskId：填本会话任务表/工具结果里的真实 task_id（没有 task_id 的产物填它的原 URL）；不许猜、不许造、不许用示例里的 TASK_ID 占位。查不到的产物前端会显示「产物未找到」。",
    "- 围栏外照常写简短中文说明（≤60字）。绝不在围栏外写 openui 语句；一次回复最多一个 openui 块。",
    "- 围栏内第一行必须是 `root = Card([...])`；每行一条语句 `名字 = 表达式`；参数严格按签名位置传，禁止 `key: value` 写法。",
    "- 引用的名字都要定义；定义的名字都要能从 root 引用到，否则不渲染。",
    `- 只能使用以下组件（白名单，名字和大小写必须完全一致，不许自造）：${OPENUI_COMPONENTS.join(", ")}。动作只有 ${OPENUI_ACTIONS.map((a) => `@${a}`).join(" / ")}。`,
    "- Buttons 仅用于真正有歧义时的一键快选（最多 4 个 secondary Button + @ToAssistant），或成品后的「再来一版」；自动模式下不出快选。@ToAssistant 只把一句话发回对话，不会直接生成媒体。",
    "- Callout 只写本轮真实发生的事实（如某件产物失败已退款）；TextContent 写简短说明，不写假数据。",
    "- 不要用 Markdown 图片语法；布局要在手机宽度（约 360px）可读。",
    "",
    "### 组件签名（? 为可选参数）",
    ...signatures,
    "",
    ...EXAMPLES.flatMap(([title, ex]) => [`### ${title}`, "```openui", ex, "```", ""]),
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
for (const ex of EXAMPLES.map(([, e]) => e)) {
  if (/\b(Form|FormControl|Input|TextArea|Select|Slider|RadioGroup|CheckBoxGroup|OptionCards|Steps|Table|Tag)\(/.test(ex)) fail("示例里出现已移除的表单/控制台组件");
}
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
for (const [label, ex] of EXAMPLES) {
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
  console.log(`components: ${OPENUI_COMPONENTS.length}  examples: ${EXAMPLES.length} (parsed, 0 errors)`);
}
