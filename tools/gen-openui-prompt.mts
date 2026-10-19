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
const { OPENUI_COMPONENTS, OPENUI_ACTIONS, OPENUI_TOOLS, OPENUI_REMOVED_COMPONENTS } = require("../src/lib/openui/catalog.ts") as {
  OPENUI_COMPONENTS: readonly string[];
  OPENUI_ACTIONS: readonly string[];
  OPENUI_TOOLS: readonly string[];
  OPENUI_REMOVED_COMPONENTS: readonly string[];
};
const { eimuArgOrder } = require("../src/lib/openui/eimu-library.ts") as { eimuArgOrder: Record<string, readonly string[]> };
const { repairOpenUISource } = require("../src/lib/openui/repair.ts") as {
  repairOpenUISource: (code: string, order: Record<string, readonly string[]>) => { changed: boolean; notes: unknown[] };
};
const { RICH_EXAMPLES, fillRichExample } = require("../src/lib/openui/rich-examples.ts") as {
  RICH_EXAMPLES: Array<{ key: string; title: string; code: string }>;
  fillRichExample: (code: string, ids: readonly string[]) => string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(repoRoot, "deploy-staging/gateway/openui-system-prompt.txt");
const MAX_CHARS = 25_000;

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
// 示范程序唯一真源：src/lib/openui/rich-examples.ts（演示页与单测共用）。
const PLACEHOLDER_IDS = ["TASK_ID_1", "TASK_ID_2", "TASK_ID_3", "TASK_ID_4"];
const EXAMPLES: Array<[string, string]> = RICH_EXAMPLES.map((ex, i) => [
  `示例 ${i + 1}：${ex.title}`,
  fillRichExample(ex.code, PLACEHOLDER_IDS),
]);

const QUERY_FIELDS =
  "found, kind(image/video/audio), title(歌名/片名), model(生成模型), size(生成尺寸参数), resolution(实测分辨率 如 1920×1080), duration(实测时长 m:ss), durationSec, cost(实际扣费 如「12 金币」), costCoins, trackNo(本会话曲序), mediaKind(film/video/music/audio), lyricStatus";

function buildPrompt(signatures: string[]): string {
  return [
    "## OpenUI 成品展示层（可选）",
    "OpenUI 只用于把本会话已经产出的真实成品排成一页好看的展示：交付卡、画廊、盲选、视频交付、单曲/专辑、A/B 对比、过程回顾。只有本轮或上下文里已有真实产物（工具结果或会话任务表里有 task_id）时，才在正常中文回复末尾附加一个 ```openui 围栏块；没有成品就不出 UI，照常用中文回复——不要为了「演示 UI」去生成媒体。",
    "",
    "### 产品边界（硬规则）",
    "- 参数、风格、比例、时长、分镜、设计全部由你自己决定；绝不输出参数表单、设置面板、创作控制台、仪表盘或流程步骤条，也不让用户填写任何字段。",
    "- 绝不编造状态、队列、进度、引擎、计费、价格、张数、时长、分辨率或任何数字。页面上出现的数字只能是 Query 读出的字段（见下），字面量数字会被前端删掉。",
    "- 用户要「复杂 UI」「渲染个界面」「能力演示」「做个 UI 看看」时：有已有产物就用它排富展示；没有产物 → 用一两句中文说明「OpenUI 是成品展示层，没有真实图片／视频／音乐就不能渲染」，可附「随便做一张图再展示」类 Buttons（非自动、最多 2 个 secondary），然后**立刻停下**（本轮零工具调用）。**禁止**：subagent_dispatch／派 web3d-director／video-director／music-director／blender_*／image_*／music_gen／workflow_write／开产线；禁止先「规划再派专家」；禁止列创作菜单；禁止「告诉我方向就开工」；禁止编造假控制台。",
    "- 成品组件只收 taskId：填本会话任务表/工具结果里的真实 task_id（没有 task_id 的产物填它的原 URL）；不许猜、不许造、不许用示例里的 TASK_ID 占位。查不到的产物前端会显示「产物未找到」。",
    "- 过程时间线（List timeline）只回顾本轮真实做过的步骤，不写没发生的环节、不写耗时数字。",
    "- Callout 只写本轮真实发生、且不含数字的事实（如「有一张生成失败，已自动退款」）；不写排队/进度/预计/引擎类状态。",
    "",
    "### 语法",
    "- 围栏外照常写简短中文说明（≤60字）。绝不在围栏外写 openui 语句；一次回复最多一个 openui 块。",
    "- 围栏内只能写本语言的赋值语句（不是 JSON、不是 JSX）：第一行必须是 `root = Card([...])`；每行一条语句 `名字 = 表达式`；参数严格按签名位置传，禁止 `key: value` 写法；可选参数不传时用 null 占位。禁止输出 JSON 组件树（例如 type/props/children 对象）。",
    "- 引用的名字都要定义；定义的名字都要能从 root 引用到，否则不渲染。数组里可以直接内联组件调用。",
    `- 只能使用以下组件（白名单，名字和大小写必须完全一致，不许自造）：${OPENUI_COMPONENTS.join(", ")}。动作只有 ${OPENUI_ACTIONS.map((a) => `@${a}`).join(" / ")}。`,
    "",
    "### 版式（像 ChatGPT 那样排成一页，而不是一列卡片）",
    "- 结构：CardHeader 定标题 → 一行 Badge 事实条 → 主成品（画廊/播放器/对比）→ 需要时用 Tabs 收纳次要视图（交付清单、曲目表、过程）→ 结尾可选 Buttons。",
    "- Row 放并排的小东西（Badge 事实条、两个按钮），事实条用 Row([...], 2, \"center\", \"start\", true) 允许换行；Grid 放 2-4 个等宽块（多个单曲、几张对比卡）；Box(tone soft/outline) 只用来把一组内容圈起来；Carousel 放备选/往期版本；Tabs 2-5 个签。",
    "- ImageGallery 版式：hero 首图大+缩略切换（交付主视觉）、masonry 瀑布流（风格不一的多张）、strip 横向胶片条（同系列）、grid 等宽网格。CompareView：blind 盲选、side 并排、slider 两张图前后滑块（修图前后、同构图两风格）。",
    "- AudioPlayer preview：lyrics 显示歌词片段（成曲）、waveform 显示波形（纯音乐/音效）；VideoPlayer posterAt：取成片里有代表性的一帧（秒）作封面。",
    "- Title 用于块标题（md）；Caption 写小字说明；TextContent 写一两句正文；别写大段散文。手机宽度约 360px 也要可读：一行 Badge 不超过 4 个，Grid 列数不超过 2（多了会自动降列）。",
    "",
    "### 真实元数据：Query（只读）",
    `- 写法：\`m = Query("artifact", {taskId: "真实task_id"})\` 读一件产物；\`arts = Query("artifacts", {kind: "audio"})\` 读本会话某类全部产物（kind 可省略），结果在 arts.rows，数量在 arts.count。只有这两个工具：${OPENUI_TOOLS.join(", ")}；不许写其他工具名，不许写 Mutation。`,
    `- 字段：${QUERY_FIELDS}。取不到的字段为空，组件会自动隐藏——不要写第三个默认值参数（会被删掉），也不要手写任何数字兜底。`,
    "- 引用字段：Badge(m.resolution)、Badge(m.duration, \"info\")、Caption(m.model)。数组字段可整列取：arts.rows.title、arts.rows.duration；也可 @Each(arts.rows, \"a\", ListItem(a.title, a.duration))（循环变量只在模板里用）、@Count(arts.rows)。",
    "- Table / Col / BarChart / LineChart / PieChart / Series 的数据只能是 Query 字段（如 Col(\"时长\", arts.rows.duration)、Series(\"时长（秒）\", arts.rows.durationSec)）；写字面量数组或数字的整件会被删掉。",
    "",
    "### 按钮",
    "- Buttons 仅用于真正有歧义时的一键快选（最多 4 个 secondary Button + @ToAssistant），或成品后的「再来一版」；自动模式下不出快选。@ToAssistant 只把一句话发回对话，不会直接生成媒体。",
    "- 不要用 Markdown 图片语法。",
    "",
    "### 组件签名（? 为可选参数，Node 指任意白名单组件）",
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
const BUILTIN_FNS = ["Query", "Each", "Count", "Sum"];
const allowed = new Set<string>([...OPENUI_COMPONENTS, ...OPENUI_ACTIONS, "Action", ...BUILTIN_FNS]);
const mentioned = new Set([...prompt.matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map((m) => m[1]));
const stray = [...mentioned].filter((n) => !allowed.has(n));
if (stray.length) fail(`提示词里出现白名单外的组件：${stray.join(", ")}`);
const removedRe = new RegExp(`\\b(${OPENUI_REMOVED_COMPONENTS.join("|")})\\(`);
for (const [label, ex] of EXAMPLES) {
  if (removedRe.test(ex)) fail(`示例 ${label} 里出现已移除的表单/控制台组件`);
  for (const m of ex.matchAll(/Query\("([^"]+)"/g)) if (!OPENUI_TOOLS.includes(m[1])) fail(`示例 ${label} 用了未注册工具 ${m[1]}`);
  // 示例必须是 repair 恒等（否则模型照抄后会被前端改写/删除）。
  const rep = repairOpenUISource(ex, eimuArgOrder);
  if (rep.changed) fail(`示例 ${label} 不是 repair 恒等：${JSON.stringify(rep.notes)}`);
  // 字面量数字只许出现在 posterAt / gap 这类版式参数，不许出现在字符串里。
  const strs = [...ex.replace(/TASK_ID_\d/g, "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (strs.some((t) => /[0-9０-９]/.test(t))) fail(`示例 ${label} 的字符串里有数字（会教模型编造数字）`);
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
