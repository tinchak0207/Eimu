// Orchestrator 派工協議注入守卫测试（MOE 改革 Wave1-C 后半，2026-09-08）。
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

/** playbook 关键句（派遣手冊開頭原文；文本真源 deploy-staging 稿，繁體原樣）。 */
const PLAYBOOK_KEY_PHRASE = "你是 Orchestrator（導演）。你的職能是：定位目標、寫 spec、派遣、收結果、驗收";

// ── OFF：零回归 ──────────────────────────────────────────────

test("OFF：beast_mode 缺失/脏数据 → 主 prompt 原样透传，一个字不多", async () => {
  for (const settings of [undefined, {}, { beast_mode: false }, { beast_mode: "true" }, { beast_mode: 1 }]) {
    const base = "BASE ORCHESTRATOR PROMPT";
    const result = await buildOrchestratorFrame(base, settings);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.injected, false);
    assert.equal(result.frame, base, "OFF = 原样透传（零回归锚）");
    assert.ok(!result.frame.includes("Orchestrator（導演）"), "OFF 帧内不得出现派工协议文本");
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
  assert.ok(directorLine!.includes("blender_exec"), "director3d 行带工具白名單");
  assert.ok(!directorLine!.includes("未启用"), "非 provisioned 行不得标注未启用");
  // music 行现状由 EXPERT_REGISTRY 驱动（并行片07 换血后 label=音乐导演 persona
  // 常量）：本断言只锁「label 出现在行内」与行形状，不锁具体枚举值防漂移。
  assert.ok(/- music（[^）]+）：任务类型 /.test(musicLine!), "music 行形状：id（label）：任务类型 …");
  assert.ok(/工具 .+/.test(musicLine!), "music 行带工具白名單");
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
  // 09-15 翻正部署片：critic 行去「（未启用）」——round3b 實錄（observations.md 观测 2）
  // 實錘這四個字在 digest 裡就是 orchestrator 拒派 critic 的直接病源。
  const criticLine = lines.find((l) => l.startsWith("- critic（"));
  assert.ok(criticLine, "critic 激活行必须在摘要中（playbook 第 18 条强制派遣的路由前提）");
  assert.ok(!criticLine!.includes("未启用"), "critic 行翻正后不得再标注未启用（在场即路由解禁）");
  assert.ok(
    criticLine!.includes("任务类型 review / audit / critique / quality_gate"),
    `critic 可路由语义必须在場：${criticLine}`,
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
  // 真源现状（审计 §3；2026-09-27 剪輯域配方庫落庫後 editor 自空集移除）：
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

// ── R7（2026-09-10）：註釋頭剝離＋狀態聲明 ──────────────────

test("stripProvenanceHeader：檔頭 HTML 註釋剝離，正文一字不動", async () => {
  // 真源 playbook 現狀：注入幀內不得出現 gate/version 元數據。
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const stripped = stripProvenanceHeader(raw);
  assert.ok(!stripped.includes("gate: 僅在 BEAST_MODE=ON"), "gate 聲明不得出現在注入文本");
  assert.ok(!stripped.includes("version: 1."), "version 元數據不得出現在注入文本");
  assert.ok(stripped.includes("你是 Orchestrator（導演）"), "正文關鍵句保留");
  assert.ok(stripped.includes("職能邊界"), "R7 職能邊界裁決段保留");
  // 無註釋頭文本 = 原樣。
  assert.equal(stripProvenanceHeader("純正文"), "純正文");
});

test("ON：幀以狀態聲明行開頭，gate 元數據絕跡", async () => {
  const base = "BASE ORCHESTRATOR PROMPT";
  const result = await buildOrchestratorFrame(base, { beast_mode: true });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.frame.startsWith(BEAST_MODE_STATE_LINE), "幀首必須是野獸模式狀態聲明");
  assert.ok(!result.frame.includes("BEAST_MODE=OFF 本檔完全不生效"), "gate 元數據不得進幀");
  assert.ok(result.frame.endsWith(base), "原 basePrompt 仍在幀尾");
});

// ── 09-15 驗收制度片B：驗收可算式化斷言（純增量，既有斷言一字未刪） ──

test("09-15：第二節含「驗收的執行標準（可算式優先）」四條，且必帶算式範例", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 新節標題與四條編號（11-15；11-14 為四條驗收標準，15 為救濟條款）。
  assert.ok(playbook.includes("驗收的執行標準（可算式優先"), "新節標題必須在");
  for (const clause of [
    "凡交付物含數字，驗收必須算，不能讀",
    "spec 必帶可驗收斷言",
    "交付契約對表",
    "跨檔一致性抽查",
    "驗收手段救濟：你可以自己核算",
  ]) {
    assert.ok(playbook.includes(clause), `驗收條款必須在：${clause}`);
  }
  // 算式範例必須可執行（教具算式逐字在場）。
  assert.ok(playbook.includes("60/146×4"), "拍點算式範例必須在場（可被直接照抄計算）");
  assert.ok(playbook.includes("沒一段在拍上"), "算術錯教具必須在場（禁止看起來對齊放行）");
  // 契約清單真源路徑與 digest 兜底句（片A 未落地時的退路）。
  assert.ok(playbook.includes("expert-delivery-contracts.json"), "契約清單真源路徑必須在場");
  assert.ok(playbook.includes("若該檔尚未存在"), "digest 兜底條款必須在場");
  // 署名與 critic 指引（第一節末）。
  assert.ok(playbook.includes("验收由你本人署名负责"), "驗收署名條款必須在場");
  assert.ok(playbook.includes("critic Expert"), "critic 獨立審核指引必須在場");
});

test("09-15：既有第二節條款零刪改（純增量錨）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  for (const legacy of [
    "**常態保持 ≥3 路並發**",
    "**async 派遣 = 常態**",
    "收到完工通知（喚醒/同步返回）的動作順序：驗收 → 補派新片 → 再回報。",
    "**上層決策/下層執行分離**",
    "驗收 = 讀回報 + 抽查證據，不是自己重跑。",
    "**驗屍先於重派**",
    "清場三驗",
    "**派遣簡報鐵律（R2-0911）**",
    "**可用性事實鐵律（R2-0911）**",
    "**存貨復用條款（R2-0911）**",
  ]) {
    assert.ok(playbook.includes(legacy), `既有條款不得被刪改：${legacy}`);
  }
  // 「不許內聯動手」原句必須保留（救濟條款是對它的解釋，不是刪除）。
  assert.ok(playbook.includes("你不許內聯動手"), "第 4 條原句必須保留");
});

// ── 09-15 驗收制度片E：16-19 硬條款＋L152 強制升級（純增量錨） ──

test("09-15 片E：16-19 硬條款關鍵詞在場，11-15 與 L152 原文錨點零刪", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 新條 16-19 判據關鍵詞（按落筆實際字串，缺一即軟條款復辟）。
  for (const kw of [
    "【交付閘門",
    "全部跑通",
    'expert="critic"',
    "逐字抄",
    "重派後仍未達標",
    "違此條＝對用戶說謊",
    "verdict/issues/evidence/qc",
    "未經獨立審核",
    "首派即齊欄",
    "交付契约",
  ]) {
    assert.ok(playbook.includes(kw), `16-19 硬條款關鍵詞必須在場：${kw}`);
  }
  // 條目編號 16-19 各自成條（行首匹配）。
  for (const no of ["16.", "17.", "18.", "19."]) {
    assert.ok(new RegExp(`^${no} `, "m").test(playbook), `必須存在編號條目 ${no}`);
  }
  // 既有条款 11-15 錨點零刪（純增，禁删任何既有条款）。
  for (const legacy of [
    "凡交付物含數字，驗收必須算，不能讀",
    "spec 必帶可驗收斷言",
    "交付契約對表",
    "跨檔一致性抽查",
    "驗收手段救濟：你可以自己核算",
  ]) {
    assert.ok(playbook.includes(legacy), `既有條款 11-15 錨點不得被刪：${legacy}`);
  }
  // L152 軟條款原文結構保留（強制句只能就地增補，不能替換原文）。
  for (const anchor of [
    "验收署名与独立审核（09-15）",
    "验收由你本人署名负责",
    "只审不产",
    "若 digest 无 critic 行则退回你自己署名验收",
    "critic 的判决仍由你署名采纳或驳回，独立审核不转移署名责任",
  ]) {
    assert.ok(playbook.includes(anchor), `L152 原文/升級錨點不得被刪：${anchor}`);
  }
  assert.ok(playbook.includes("由「可派」升級為「**必須派**」"), "軟條款升級句必須在場");
});

// ── 09-15 研究隔離片F（刀1）：第 20 條＋11-19/L152 原文錨點零刪 ──

test("09-15 片F：第 20 條「研究是决策输入，不是创作素材」在場，11-19 與 L152 錨點零刪", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = readFileSync(join(root, ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH), "utf8");
  const playbook = stripProvenanceHeader(raw);

  // 第 20 條判據關鍵詞（按落筆實際字串，缺一即條款被弱化）。
  for (const kw of [
    "研究是决策输入，不是创作素材",
    "只准用於你自己的取捨判斷",
    "以「你必須吸收的真實研究結論」",
    "以下是研究發現",
    "禁止跨 Expert 的字面同源",
    "規格參數",
    "即視為本條違反",
    "重寫 spec 並重派受影響 Expert",
    "錯位互補信息翻倍",
  ]) {
    assert.ok(playbook.includes(kw), `第 20 條關鍵詞必須在場：${kw}`);
  }
  // 條目編號 20 自成條（行首匹配，接續 19 的最大號）。
  assert.ok(/^20\. /m.test(playbook), "必須存在編號條目 20.");
  // 編號連續性：19 之後即 20，中間不得插入其他序號。
  const no20 = playbook.indexOf("\n20. ");
  const no19 = playbook.indexOf("\n19. ");
  assert.ok(no19 > 0 && no20 > no19, "第 20 條必須在第 19 條之後");
  assert.ok(!/\n(2[1-9]|[3-9]\d)\. /m.test(playbook.slice(no19)), "19 之後不得跳號");

  // 既有 11-19 條錨點零刪（純增，禁删任何既有条款）。
  for (const legacy of [
    "凡交付物含數字，驗收必須算，不能讀",
    "spec 必帶可驗收斷言",
    "交付契約對表",
    "跨檔一致性抽查",
    "驗收手段救濟：你可以自己核算",
    "交付閘門標記禁止覆蓋",
    "重派後仍未達標不得計入成品",
    "critic 獨立審核＝成品前提",
    "契約欄逐字進 spec",
    "違此條＝對用戶說謊",
  ]) {
    assert.ok(playbook.includes(legacy), `既有條款 11-19 錨點不得被刪：${legacy}`);
  }
  // L152 軟條款原文結構與升級句零刪（本次為純增，不得動它）。
  for (const anchor of [
    "验收署名与独立审核（09-15）",
    "验收由你本人署名负责",
    "只审不产",
    "若 digest 无 critic 行则退回你自己署名验收",
    "critic 的判决仍由你署名采纳或驳回，独立审核不转移署名责任",
    "由「可派」升級為「**必須派**」",
  ]) {
    assert.ok(playbook.includes(anchor), `L152 原文/升級錨點不得被刪：${anchor}`);
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
