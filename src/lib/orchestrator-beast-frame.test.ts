// Orchestrator 派工协议注入守卫测试（MOE 改革 Wave1-C 后半，2026-09-08）。
//
// 覆盖三组：
// 1. OFF 零回归：beast_mode 缺失/脏数据 → basePrompt 原样透传，不含派工协议文本。
// 2. ON 注入：playbook 关键句在帧内 + 注册表摘要含 director3d / music 两行、
//    provisioned 行标注「未启用」。
// 3. sanitizeAgentSettings 白名单含 beast_mode 往返（经缓存读写路径双拍清洗）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrchestratorFrame,
  buildExpertRegistryDigest,
  buildExpertLine,
  stripProvenanceHeader,
  BEAST_MODE_STATE_LINE,
  ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH,
  EXPERT_LINE_SKILL_PATHS_UNCONFIGURED,
  EXPERT_LINE_QC_REQUIRED,
  EXPERT_LINE_QC_OPTIONAL,
  EXPERT_LINE_NO_REQUIRED_FIELDS,
} from "./orchestrator-beast-frame.ts";
import type { ExpertDef } from "./expert-registry.ts";
import { EXPERT_REGISTRY } from "./expert-registry.ts";
import { BLENDER_DELIVERABLES } from "./blender-delegate.ts";
import { MUSIC_DELIVERABLES } from "./music-delegate.ts";
import { VIDEO_DELIVERABLES } from "./video-delegate.ts";
import { EDITOR_DELIVERABLES } from "./editor-delegate.ts";
import { SCREENWRITER_DELIVERABLES } from "./screenwriter-delegate.ts";
import { MOTION_DELIVERABLES } from "./motion-delegate.ts";
import { WEB3D_DELIVERABLES } from "./web3d-delegate.ts";
import {
  DEFAULT_AGENT_SETTINGS,
  readCachedAgentSettings,
  writeCachedAgentSettings,
} from "./agent-chat-client.ts";

/** playbook 关键句（派遣手册开头原文；文本真源 deploy-staging 稿，繁体原样）。 */
const PLAYBOOK_KEY_PHRASE = "你是 Orchestrator（导演）。你的职能是：定位目标、写 spec、派遣、收结果、验收";

// ── OFF：零回归 ──────────────────────────────────────────────

test("OFF：beast_mode 缺失/脏数据 → 主 prompt 原样透传，一个字不多", async () => {
  for (const settings of [undefined, {}, { beast_mode: false }, { beast_mode: "true" }, { beast_mode: 1 }]) {
    const base = "BASE ORCHESTRATOR PROMPT";
    const result = await buildOrchestratorFrame(base, settings);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.injected, false);
    assert.equal(result.frame, base, "OFF = 原样透传（零回归锚）");
    assert.ok(!result.frame.includes("Orchestrator（导演）"), "OFF 帧内不得出现派工协议文本");
    assert.ok(!result.frame.includes("Expert 注册表"), "OFF 帧内不得出现注册表摘要");
  }
});

// ── ON：playbook 注入 + 注册表摘要 ──────────────────────────

test("ON：playbook 关键句与注册表摘要注入帧内（协议在头、原文在后）", async () => {
  const base = "BASE ORCHESTRATOR PROMPT";
  const result = await buildOrchestratorFrame(base, { beast_mode: true });
  assert.ok(result.ok, `ON 且 playbook 在仓内必须可读：${!result.ok ? result.hint : ""}`);
  if (!result.ok) return;
  assert.equal(result.injected, true);
  assert.ok(result.frame.includes(PLAYBOOK_KEY_PHRASE), "派遣手册关键句必须在帧内");
  assert.ok(result.frame.includes("spec 七件套"), "spec 七件套硬约束必须在帧内");
  assert.ok(result.frame.includes("Expert 注册表"), "注册表摘要必须在帧内");
  // 格式照宪法注入范式：注入体在前，--- 分隔，原 prompt 在尾。
  assert.ok(result.frame.endsWith(base), "原 basePrompt 必须完整保留在帧尾");
  assert.ok(result.frame.includes("---"), "注入体与原文之间必须有 --- 分隔");
  assert.ok(result.estimated_tokens > 0);
});

test("ON：注册表摘要含 director3d 与 music 两行，行内容来自 EXPERT_REGISTRY 动态生成", () => {
  const digest = buildExpertRegistryDigest();
  const lines = digest.split("\n").filter((l) => l.startsWith("- "));
  const directorLine = lines.find((l) => l.includes("director3d"));
  const musicLine = lines.find((l) => l.includes("music"));
  assert.ok(directorLine, "director3d 行必须存在");
  assert.ok(musicLine, "music 行必须存在");
  assert.ok(directorLine!.includes("3D 导演"), "director3d 行带 label（来自 persona 常量）");
  assert.ok(directorLine!.includes("blender_exec"), "director3d 行带工具白名单");
  assert.ok(!directorLine!.includes("未启用"), "非 provisioned 行不得标注未启用");
  // music 行现状由 EXPERT_REGISTRY 驱动（并行片07 换血后 label=音乐导演 persona
  // 常量）：本断言只锁「label 出现在行内」与行形状，不锁具体枚举值防漂移。
  assert.ok(/- music（[^）]+）：任务类型 /.test(musicLine!), "music 行形状：id（label）：任务类型 …");
  assert.ok(/工具 .+/.test(musicLine!), "music 行带工具白名单");
  // 摘要由 EXPERT_REGISTRY 动态生成（禁止手抄漂移）：行数与注册表一致。
  // Wave2 收口后注册表 = 7 行全激活（director3d/music + 五域翻正式）。
  assert.equal(
    lines.length,
    Object.keys(EXPERT_REGISTRY).length,
    "摘要行数必须与 EXPERT_REGISTRY 行数一致",
  );
  assert.ok(lines.length >= 7, "Wave2 后至少 7 行（director3d/music + 五域激活）");
  const videoDirectorLine = lines.find((l) => l.includes("video-director"));
  assert.ok(videoDirectorLine, "video-director 激活行必须在摘要中");
  assert.ok(!videoDirectorLine!.includes("未启用"), "激活行不得标注未启用（Wave2 收口翻正）");
  // 09-15 翻正部署片：critic 行去「（未启用）」——round3b 实录（observations.md 观测 2）
  // 实锤这四个字在 digest 里就是 orchestrator 拒派 critic 的直接病源。
  const criticLine = lines.find((l) => l.startsWith("- critic（"));
  assert.ok(criticLine, "critic 激活行必须在摘要中（playbook 第 18 条强制派遣的路由前提）");
  assert.ok(!criticLine!.includes("未启用"), "critic 行翻正后不得再标注未启用（在场即路由解禁）");
  assert.ok(
    criticLine!.includes("任务类型 review / audit / critique / quality_gate"),
    `critic 可路由语义必须在场：${criticLine}`,
  );
  assert.ok(!digest.includes("未启用"), "翻正后整个摘要零「未启用」标注（注册表无 provisioned 行）");
});

test("provisioned 行标注机制：buildExpertLine 对 provisioned:true 行标「未启用」", () => {
  // registry 现状（并行片07 换血后）已无 provisioned 行，机制用合成 ExpertDef
  // 钉死（禁碰 registry 本体，type-only import）。
  const placeholder: ExpertDef = {
    id: "video",
    label: "视频",
    description: "占位",
    toolIds: ["video_gen"],
    skillPaths: [],
    taskTypes: ["video"],
    deliverableContract: { requiredFields: [], qcSignatureRequired: false },
    replyTokenCap: 500,
    provisioned: true,
  };
  const enabled: ExpertDef = { ...placeholder, id: "director3d", provisioned: undefined };
  assert.ok(buildExpertLine(placeholder).includes("（未启用）"), "provisioned 行必须标注未启用");
  assert.ok(!buildExpertLine(enabled).includes("未启用"), "非 provisioned 行不得标注");
});

// ── R4（2026-09-11）：配方库 + 交付契约进摘要 ─────────────

test("R4：每行含配方库与交付契约字段，requiredFields 逐字来自 delegate 常量", () => {
  const digest = buildExpertRegistryDigest();
  const lines = digest.split("\n").filter((l) => l.startsWith("- "));
  for (const line of lines) {
    assert.ok(line.includes("配方库 "), `每行必须含配方库字段：${line}`);
    assert.ok(line.includes("交付契约 "), `每行必须含交付契约字段：${line}`);
    assert.ok(
      new RegExp(`qcSignature：(${EXPERT_LINE_QC_REQUIRED}|${EXPERT_LINE_QC_OPTIONAL})`).test(line),
      `每行必须带 qcSignature 真假标注：${line}`,
    );
  }
  // 交付契约 requiredFields 逐字来自各 delegate 常量（import 真源，不硬编字符串）。
  const expected: Record<string, readonly string[]> = {
    director3d: BLENDER_DELIVERABLES,
    music: MUSIC_DELIVERABLES,
    "video-director": VIDEO_DELIVERABLES,
    editor: EDITOR_DELIVERABLES,
    screenwriter: SCREENWRITER_DELIVERABLES,
    "motion-director": MOTION_DELIVERABLES,
    "web3d-director": WEB3D_DELIVERABLES,
  };
  for (const [id, fields] of Object.entries(expected)) {
    const line = lines.find((l) => l.startsWith(`- ${id}（`));
    assert.ok(line, `${id} 行必须存在`);
    for (const field of fields) {
      assert.ok(line!.includes(field), `${id} 行必须逐字含契约字段 ${field}：${line}`);
    }
  }
  // registry 7 行 qcSignatureRequired 全 true → 摘要必须全部标「必需」。
  assert.equal(
    lines.filter((l) => l.includes(`qcSignature：${EXPERT_LINE_QC_REQUIRED}`)).length,
    lines.length,
    "7 个 Expert qcSignatureRequired 全 true，摘要必须全部标「必需」",
  );
});

test("R4：空 skillPaths 行照实写「未配置」（零编造路径）", () => {
  const digest = buildExpertRegistryDigest();
  // 真源现状（审计 §3；2026-09-27 剪辑域配方库落库后 editor 自空集移除）：
  // video-director/screenwriter 的 persona 常量为空数组。
  for (const id of ["video-director", "screenwriter"]) {
    const line = digest.split("\n").find((l) => l.startsWith(`- ${id}（`));
    assert.ok(line, `${id} 行必须存在`);
    assert.ok(
      line!.includes(`配方库 ${EXPERT_LINE_SKILL_PATHS_UNCONFIGURED}`),
      `${id} 空配方库必须写「未配置」：${line}`,
    );
  }
  // 非空行不得出现「未配置」（照 registry 现值为非空，逐字输出）。
  // editor 于 2026-09-27 配方库落库后进本列（skills/editor/ 域根+六子配方）。
  for (const id of ["director3d", "music", "motion-director", "web3d-director", "editor"]) {
    const line = digest.split("\n").find((l) => l.startsWith(`- ${id}（`));
    assert.ok(line, `${id} 行必须存在`);
    assert.ok(
      !line!.includes(EXPERT_LINE_SKILL_PATHS_UNCONFIGURED),
      `${id} 配方库非空行不得标「未配置」：${line}`,
    );
  }
});

test("R4：合成 ExpertDef 契约值逐字进摘要（路径/requiredFields/qcSignature 真假）", () => {
  const base: ExpertDef = {
    id: "synth",
    label: "合成",
    description: "合成",
    toolIds: ["t1"],
    skillPaths: [],
    taskTypes: ["x"],
    deliverableContract: { requiredFields: [], qcSignatureRequired: false },
    replyTokenCap: 1,
  };
  const empty = buildExpertLine(base);
  assert.ok(empty.includes(`配方库 ${EXPERT_LINE_SKILL_PATHS_UNCONFIGURED}`));
  assert.ok(empty.includes(`交付契约 ${EXPERT_LINE_NO_REQUIRED_FIELDS}`));
  assert.ok(empty.includes(`qcSignature：${EXPERT_LINE_QC_OPTIONAL}`));

  const filled = buildExpertLine({
    ...base,
    skillPaths: ["a/b.md", "c/"],
    deliverableContract: { requiredFields: ["f1", "f2"], qcSignatureRequired: true },
  });
  assert.ok(filled.includes("配方库 a/b.md, c/"), `多配方库逐字列出：${filled}`);
  assert.ok(filled.includes("交付契约 f1, f2"), `多契约字段逐字列出：${filled}`);
  assert.ok(filled.includes(`qcSignature：${EXPERT_LINE_QC_REQUIRED}`), filled);
});

test("playbook 单一真源在仓内（fs 注入的文本真源存在且非空）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  // 从本测试文件定位仓库根（测试在 src/lib/ 下，根在 ../../）。
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  assert.ok(raw.trim() !== "", "playbook 不得为空档");
  assert.ok(raw.includes("spec 七件套"), "playbook 内容必须含派遣硬约束");
});

// ── R7（2026-09-10）：注释头剥离＋状态声明 ──────────────────

test("stripProvenanceHeader：档头 HTML 注释剥离，正文一字不动", async () => {
  // 真源 playbook 现状：注入帧内不得出现 gate/version 元数据。
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const stripped = stripProvenanceHeader(raw);
  assert.ok(!stripped.includes("gate: 仅在 BEAST_MODE=ON"), "gate 声明不得出现在注入文本");
  assert.ok(!stripped.includes("version: 1."), "version 元数据不得出现在注入文本");
  assert.ok(stripped.includes("你是 Orchestrator（导演）"), "正文关键句保留");
  assert.ok(stripped.includes("职能边界"), "R7 职能边界裁决段保留");
  // 无注释头文本 = 原样。
  assert.equal(stripProvenanceHeader("纯正文"), "纯正文");
});

test("ON：帧以状态声明行开头，gate 元数据绝迹", async () => {
  const base = "BASE ORCHESTRATOR PROMPT";
  const result = await buildOrchestratorFrame(base, { beast_mode: true });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.frame.startsWith(BEAST_MODE_STATE_LINE), "帧首必须是野兽模式状态声明");
  assert.ok(!result.frame.includes("BEAST_MODE=OFF 本档完全不生效"), "gate 元数据不得进帧");
  assert.ok(result.frame.endsWith(base), "原 basePrompt 仍在帧尾");
});

// ── 09-15 验收制度片B：验收可算式化断言（纯增量，既有断言一字未删） ──

test("09-15：第二节含「验收的执行标准（可算式优先）」四条，且必带算式范例", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 新节标题与四条编号（11-15；11-14 为四条验收标准，15 为救济条款）。
  assert.ok(playbook.includes("验收的执行标准（可算式优先"), "新节标题必须在");
  for (const clause of [
    "凡交付物含数字，验收必须算，不能读",
    "spec 必带可验收断言",
    "交付契约对表",
    "跨档一致性抽查",
    "验收手段救济：你可以自己核算",
  ]) {
    assert.ok(playbook.includes(clause), `验收条款必须在：${clause}`);
  }
  // 算式范例必须可执行（教具算式逐字在场）。
  assert.ok(playbook.includes("60/146×4"), "拍点算式范例必须在场（可被直接照抄计算）");
  assert.ok(playbook.includes("没一段在拍上"), "算术错教具必须在场（禁止看起来对齐放行）");
  // 契约清单真源路径与 digest 兜底句（片A 未落地时的退路）。
  assert.ok(playbook.includes("expert-delivery-contracts.json"), "契约清单真源路径必须在场");
  assert.ok(playbook.includes("若该档尚未存在"), "digest 兜底条款必须在场");
  // 署名与 critic 指引（第一节末）。
  assert.ok(playbook.includes("验收由你本人署名负责"), "验收署名条款必须在场");
  assert.ok(playbook.includes("critic Expert"), "critic 独立审核指引必须在场");
});

test("09-15：既有第二节条款零删改（纯增量锚）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  for (const legacy of [
    "**常态保持 ≥3 路并发**",
    "**async 派遣 = 常态**",
    "收到完工通知（唤醒/同步返回）的动作顺序：验收 → 补派新片 → 再回报。",
    "**上层决策/下层执行分离**",
    "验收 = 读回报 + 抽查证据，不是自己重跑。",
    "**验尸先于重派**",
    "清场三验",
    "**派遣简报铁律（R2-0911）**",
    "**可用性事实铁律（R2-0911）**",
    "**存货复用条款（R2-0911）**",
  ]) {
    assert.ok(playbook.includes(legacy), `既有条款不得被删改：${legacy}`);
  }
  // 「不许内联动手」原句必须保留（救济条款是对它的解释，不是删除）。
  assert.ok(playbook.includes("你不许内联动手"), "第 4 条原句必须保留");
});

// ── 09-15 验收制度片E：16-19 硬条款＋L152 强制升级（纯增量锚） ──

test("09-15 片E：16-19 硬条款关键词在场，11-15 与 L152 原文锚点零删", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 新条 16-19 判据关键词（按落笔实际字串，缺一即软条款复辟）。
  for (const kw of [
    "【交付闸门",
    "全部跑通",
    'expert="critic"',
    "逐字抄",
    "重派后仍未达标",
    "违此条＝对用户说谎",
    "verdict/issues/evidence/qc",
    "未经独立审核",
    "首派即齐栏",
    "交付契约",
  ]) {
    assert.ok(playbook.includes(kw), `16-19 硬条款关键词必须在场：${kw}`);
  }
  // 条目编号 16-19 各自成条（行首匹配）。
  for (const no of ["16.", "17.", "18.", "19."]) {
    assert.ok(new RegExp(`^${no} `, "m").test(playbook), `必须存在编号条目 ${no}`);
  }
  // 既有条款 11-15 锚点零删（纯增，禁删任何既有条款）。
  for (const legacy of [
    "凡交付物含数字，验收必须算，不能读",
    "spec 必带可验收断言",
    "交付契约对表",
    "跨档一致性抽查",
    "验收手段救济：你可以自己核算",
  ]) {
    assert.ok(playbook.includes(legacy), `既有条款 11-15 锚点不得被删：${legacy}`);
  }
  // L152 软条款原文结构保留（强制句只能就地增补，不能替换原文）。
  // 2026-10-02：2026-09-19「机器化」改写了本段字面（critic 改由网关机器层兜底、署名责任收敛为
  // 「署名→按 verdict 采纳或驳回」），旧字面已不存在。改锚在改写后的同义句上，守护目标不变：
  // L152 条款与其强制升级句不得被删。
  for (const anchor of [
    "验收署名与独立审核（09-15；机器化声明 2026-09-19）",
    "验收由你本人署名负责",
    "critic 只审已存在的成品",
    "网关机器层设有 critic 兜底审核",
    "按 verdict 采纳或驳回",
  ]) {
    assert.ok(playbook.includes(anchor), `L152 原文/升级锚点不得被删：${anchor}`);
  }
  assert.ok(playbook.includes("critic 独立审核＝成品前提（强制，09-15 片E；升级第一节末软条款）"), "软条款升级句必须在场");
});

// ── 09-15 研究隔离片F（刀1）：第 20 条＋11-19/L152 原文锚点零删 ──

test("09-15 片F：第 20 条「研究是决策输入，不是创作素材」在场，11-19 与 L152 锚点零删", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 第 20 条判据关键词（按落笔实际字串，缺一即条款被弱化）。
  for (const kw of [
    "研究是决策输入，不是创作素材",
    "只准用于你自己的取舍判断",
    "以「你必须吸收的真实研究结论」",
    "以下是研究发现",
    "禁止跨 Expert 的字面同源",
    "规格参数",
    "即视为本条违反",
    "重写 spec 并重派受影响 Expert",
    "错位互补信息翻倍",
  ]) {
    assert.ok(playbook.includes(kw), `第 20 条关键词必须在场：${kw}`);
  }
  // 条目编号 20 自成条（行首匹配，接续 19 的最大号）。
  assert.ok(/^20\. /m.test(playbook), "必须存在编号条目 20.");
  // 编号连续性：19 之后即 20，中间不得插入其他序号。
  const no20 = playbook.indexOf("\n20. ");
  const no19 = playbook.indexOf("\n19. ");
  assert.ok(no19 > 0 && no20 > no19, "第 20 条必须在第 19 条之后");
  assert.ok(!/\n(2[1-9]|[3-9]\d)\. /m.test(playbook.slice(no19)), "19 之后不得跳号");

  // 既有 11-19 条锚点零删（纯增，禁删任何既有条款）。
  for (const legacy of [
    "凡交付物含数字，验收必须算，不能读",
    "spec 必带可验收断言",
    "交付契约对表",
    "跨档一致性抽查",
    "验收手段救济：你可以自己核算",
    "交付闸门标记禁止覆盖",
    "重派后仍未达标不得计入成品",
    "critic 独立审核＝成品前提",
    "契约栏逐字进 spec",
    "违此条＝对用户说谎",
  ]) {
    assert.ok(playbook.includes(legacy), `既有条款 11-19 锚点不得被删：${legacy}`);
  }
  // L152 软条款原文结构与升级句零删（本次为纯增，不得动它）。
  // 2026-10-02：2026-09-19「机器化」改写了本段的字面（critic 改由网关机器层兜底、署名责任收敛为
  // 「署名→按 verdict 采纳或驳回」），旧字面已不存在。以下改锚在改写后的同义句上，守护的仍是
  // 同一件事：L152 条款与其强制升级句不得被删。
  for (const anchor of [
    "验收署名与独立审核（09-15；机器化声明 2026-09-19）",
    "验收由你本人署名负责",
    "critic 只审已存在的成品",
    "网关机器层设有 critic 兜底审核",
    "按 verdict 采纳或驳回",
    "critic 独立审核＝成品前提（强制，09-15 片E；升级第一节末软条款）",
  ]) {
    assert.ok(playbook.includes(anchor), `L152 原文/升级锚点不得被删：${anchor}`);
  }
});

// ── sanitize 白名单：beast_mode 往返 ────────────────────────

/** node 环境没有 window：临时挂一个最小 localStorage 桩驱动缓存路径（同 agent-chat-client.test.ts）。 */
function withLocalStorage(fn: () => void): void {
  const store = new Map<string, string>();
  const stub = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  } as unknown as typeof globalThis & { localStorage: Storage };
  const prevWindow = globalThis.window;
  (globalThis as { window?: unknown }).window = stub;
  try {
    fn();
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
}

test("sanitizeAgentSettings 白名单含 beast_mode：true 往返、脏数据落默认 OFF", () => {
  withLocalStorage(() => {
    // 写 true → 读 true（往返第一拍）。
    writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, beast_mode: true });
    assert.equal(readCachedAgentSettings().beast_mode, true);
    // 关回 false → 读 false（toggle 可逆，往返第二拍）。
    writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, beast_mode: false });
    assert.equal(readCachedAgentSettings().beast_mode, false);
    // 脏数据（字符串 "true" / 数字 1）→ sanitize 落默认 OFF。
    writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, beast_mode: "true" as never });
    assert.equal(readCachedAgentSettings().beast_mode, false);
    writeCachedAgentSettings({ ...DEFAULT_AGENT_SETTINGS, beast_mode: 1 as never });
    assert.equal(readCachedAgentSettings().beast_mode, false);
    // 旧版缓存缺 beast_mode 字段 → 默认 OFF，不炸。
    globalThis.window!.localStorage.setItem(
      "agent-settings-v1",
      JSON.stringify({ interrupt_mode: "queue", persona: "thoughtful", cost_mode: "premium" }),
    );
    const legacy = readCachedAgentSettings();
    assert.equal(legacy.beast_mode, false);
    assert.equal(legacy.interrupt_mode, "queue", "其余字段白名单不受影响");
  });
});
