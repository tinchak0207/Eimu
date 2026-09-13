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
  // 真源现状（审计 §3）：video-director/editor/screenwriter 的 persona 常量为空数组。
  for (const id of ["video-director", "editor", "screenwriter"]) {
    const line = digest.split("\n").find((l) => l.startsWith(`- ${id}（`));
    assert.ok(line, `${id} 行必须存在`);
    assert.ok(
      line!.includes(`配方库 ${EXPERT_LINE_SKILL_PATHS_UNCONFIGURED}`),
      `${id} 空配方库必须写「未配置」：${line}`,
    );
  }
  // 非空行不得出现「未配置」（照 registry 现值为非空，逐字输出）。
  for (const id of ["director3d", "music", "motion-director", "web3d-director"]) {
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
