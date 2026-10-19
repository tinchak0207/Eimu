// 节点 metadata 白名单通道契约（2026-09-25）。
//
// 病灶（已实锤事故）：metadata 有**两个独立白名单清洗入口**——还原端 `layout.toNodeMetadata`
// 与上行端 `compactMetadataForAgent`——键集合各自手工维护。漏在其中一处放行一个键，
// 症状是「功能当下完全没反应」而不是报错（`emitsEntity` 实锤：一进前端就被剥，
// 整条自动落卡不可能触发）。
//
// 本档的断言全部是**真实行为断言**（真 `compactMetadataForAgent` → 真 `toNodeMetadata`
// 往复、真值比对），不靠源码字串。真源＝`./node-metadata-fields`。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_METADATA_FIELDS,
  AGENT_METADATA_FIELD_KEYS,
  DURABLE_METADATA_FIELDS,
  DURABLE_METADATA_FIELD_KEYS,
  type DurableFieldSpec,
} from "./node-metadata-fields";
// 审计/排除清单与截断预算已移出打包档（内部判定与档名:行号不进客户端 bundle）。
import {
  AGENT_EXCLUDED_METADATA_FIELDS,
  AGENT_EXCLUDED_METADATA_FIELD_KEYS,
  AGENT_TRUNCATION_BUDGETS,
  findAgentChannelGaps,
  findStaleAgentExclusions,
  type AgentExclusionVerdict,
} from "./node-metadata-audit";
import { toNodeMetadata } from "./layout";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import type { CanvasNodeMetadata } from "./types";

// ─────────────────────────────────────────── 样本（每个耐久键一份）

/** AID 21 栏全形样本（存活断言只要求 shotNumber 有值、其余逐栏字串）。 */
const SHOT = {
  shotNumber: "001",
  scriptContent: "正文",
  visualDescription: "画面",
  dialogue: "",
  actionState: "",
  narrativeFunction: "",
  timeOfDay: "",
  eraCoordinate: "",
  dateCoordinate: "",
  weather: "",
  referenceAssets: "",
  shotSize: "",
  cameraAngle: "",
  focalLength: "",
  cameraMovement: "",
  composition: "",
  atmosphere: "",
  colorTone: "",
  lighting: "",
  exposureBlur: "",
  soundEffect: "",
};

/** 3D 场景卡六栏全形样本。 */
const SCENE_CARD = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/still.png"],
  blend_path: "/api/scene-assets/a.blend",
  glb_path: "/api/scene-assets/a.glb",
  scene_summary: "废弃灯塔主场景",
  duration_ms: 8000,
};

/**
 * 每个耐久键的样本 metadata（**整包**输入，含分族所需的同伴键）。
 * 值一律取「清洗后仍等于原值」的形，存活断言才能用 deepEqual 直接比。
 */
const SAMPLE_METADATA_BY_KEY: Record<string, Record<string, unknown>> = {
  content: { content: "正文" },
  prompt: { prompt: "画一只猫" },
  negativePrompt: { negativePrompt: "水印" },
  model: { model: "flux-1.1-pro" },
  size: { size: "1024x1024" },
  quality: { quality: "high" },
  count: { count: 2 },
  kind: { kind: "image" },
  source_image: { source_image: "https://cdn.example.com/src.png" },
  status: { status: "success" },
  errorDetails: { errorDetails: "生成失败" },
  naturalWidth: { naturalWidth: 1024 },
  naturalHeight: { naturalHeight: 1024 },
  cost_coins: { cost_coins: 12 },
  cost_hint: { cost_hint: 8 },
  imageTaskId: { imageTaskId: "task-1" },
  startedAt: { startedAt: 1758700000000 },
  progress: { progress: 42 },
  referenceRole: { referenceRole: "character" },
  pipelineCard: { pipelineCard: "tool" },
  toolId: { pipelineCard: "tool", toolId: "image_edit" },
  toolInput: { pipelineCard: "tool", toolInput: "{}" },
  toolOutput: { pipelineCard: "tool", toolOutput: "ok" },
  requiredCapability: { pipelineCard: "tool", requiredCapability: "image_edit" },
  unsupported: { pipelineCard: "tool", unsupported: true },
  deliverable: { deliverable: "产出：分镜" },
  gate: { gate: "需人工批准" },
  directorSessionId: { pipelineCard: "director", directorSessionId: "sess-1" },
  planName: { pipelineCard: "director", planName: "方案A" },
  shotCount: { pipelineCard: "director", shotCount: 6 },
  healthOk: { pipelineCard: "director", healthOk: true },
  topViewSvg: { topViewSvg: "<svg/>" },
  cameraViewSvg: { cameraViewSvg: "<svg/>" },
  revision: { pipelineCard: "director", revision: 3 },
  sceneCard: { sceneCard: SCENE_CARD },
  // P1-1（2026-09-29）两键漏补样本：本档的契约是「新增耐久键必须同时补样本」，
  // 缺样本＝该键永远不被这条往复断言覆盖（守门件静默失明）。
  directorStageId: { directorStageId: "stage-1" },
  shotId: { shotId: "001" },
  storyboardShot: { storyboardShot: SHOT },
  // 2026-09-30 单镜旁白文本＋对白／旁白双音轨（介面冻结四键；audioAnchorId 是相容锚，
  // 其生产者规则＝dialogueAudioId || narrationAudioId，样本取单轨形故值取对白轨）。
  narration: { narration: "她推开门，雨声灌进走廊。" },
  dialogueAudioId: { dialogueAudioId: "https://cdn.example.com/line-007.mp3" },
  narrationAudioId: { narrationAudioId: "https://cdn.example.com/vo-007.mp3" },
  audioAnchorId: { audioAnchorId: "https://cdn.example.com/line-007.mp3" },
  storyboardScene: { storyboardScene: { sceneName: "旧宅", shotCount: 1 } },
  characterCardIds: { characterCardIds: ["card-a"] },
  sceneCardIds: { sceneCardIds: ["card-b"] },
  propCardIds: { propCardIds: ["card-c"] },
  entityCardId: { entityCardId: "card-a" },
  emitsEntity: { emitsEntity: { kind: "character" } },
  input: { input: "角色名" },
  characterName: { characterName: "备选名" },
  sceneName: { sceneName: "旧宅" },
  fontSize: { fontSize: 22 },
  gateConfirm: { gateConfirm: { request_id: "req-1", session_id: "sess-1", status: "pending" } },
  approval: { approval: { status: "approved" } },
  // 2026-09-29 P1-2：集归属 ＋ 分镜候选集（样本一律取「清洗后仍等于原值」的形）。
  episodeId: { episodeId: "ep-1" },
  shotCandidates: {
    shotCandidates: {
      items: [
        { id: "c1", prompt: "雨夜码头，中景，冷色" },
        {
          id: "c2",
          prompt: "雨夜码头，特写，眼神",
          model: "seedance-2.5-900-特惠",
          url: "https://cdn.example.com/c2.mp4",
          status: "success",
        },
      ],
      selectedId: "c2",
    },
  },
  // 2026-09-29 P1-9：任务版本史＋标签＋星标选中（样本取「清洗后仍等于原值」的形：
  // version 已正规化成 ISO 8601 UTC、时序升序、selectedVersion 是成员、tags 在值域内）。
  taskVersions: {
    taskVersions: {
      items: [
        { version: "2026-09-29T02:00:00.000Z", taskId: "task-1", status: "error", tags: ["main_image"] },
        {
          version: "2026-09-29T02:05:00.000Z",
          taskId: "task-2",
          status: "success",
          tags: ["main_image"],
          url: "https://cdn.example.com/a.png",
        },
      ],
      selectedVersion: "2026-09-29T02:05:00.000Z",
    },
  },
};

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** 真往复：真上行压缩 → 真还原端清洗。 */
function roundTrip(metadata: Record<string, unknown>): Record<string, unknown> {
  return toNodeMetadata(compactMetadataForAgent(metadata as unknown as CanvasNodeMetadata)) as Record<string, unknown>;
}

// ─────────────────────────────────────────── ① 往复合同（本档的主断言）

test("契约：每个耐久键经 toNodeMetadata(compactMetadataForAgent(m)) 后存活，或必须在显式排除清单且带理由", () => {
  const exclusionByKey = new Map(AGENT_EXCLUDED_METADATA_FIELDS.map((e) => [e.key, e]));
  const problems: string[] = [];
  const survived: string[] = [];

  for (const field of DURABLE_METADATA_FIELDS) {
    const sample = SAMPLE_METADATA_BY_KEY[field.key];
    if (!sample) {
      problems.push(`${field.key}：真源有键但测试无样本（新增耐久键必须同时补样本）`);
      continue;
    }
    const restored = roundTrip(sample);
    const exclusion = exclusionByKey.get(field.key);
    if (hasOwn(restored, field.key)) {
      survived.push(field.key);
      if (exclusion) problems.push(`${field.key}：排除清单谎报（实际存活）`);
      try {
        assert.deepEqual(restored[field.key], sample[field.key]);
      } catch {
        problems.push(`${field.key}：存活但值不等（清洗语义漂移）：${JSON.stringify(restored[field.key])}`);
      }
    } else if (!exclusion) {
      problems.push(`${field.key}：未存活且未列入显式排除清单（双白名单漏一端＝功能静默消失）`);
    } else if (exclusion.reason.trim().length < 8) {
      problems.push(`${field.key}：排除清单条目没有可读的理由`);
    }
  }

  assert.deepEqual(problems, [], `metadata 白名单通道契约破口：\n${problems.join("\n")}`);

  // 未存活集合必须逐字等于排除清单（不多不少）：防「把键全塞进排除清单」洗白。
  const notSurvived = DURABLE_METADATA_FIELDS.map((f) => f.key).filter((k) => !survived.includes(k));
  assert.deepEqual(
    [...notSurvived].sort(),
    [...AGENT_EXCLUDED_METADATA_FIELD_KEYS].sort(),
    "未存活的耐久键集合与显式排除清单必须逐字一致",
  );
});

test("排除清单：每条都有可读理由＋证据＋机器可读分类，且只登记耐久键", () => {
  const durableKeys = new Set(DURABLE_METADATA_FIELD_KEYS);
  const verdicts: readonly AgentExclusionVerdict[] = ["intentional", "suspected-gap", "dormant"];
  const problems: string[] = [];
  for (const exclusion of AGENT_EXCLUDED_METADATA_FIELDS) {
    if (!durableKeys.has(exclusion.key)) problems.push(`${exclusion.key}：不是耐久键（幽灵排除条目）`);
    if (exclusion.reason.trim().length < 8) problems.push(`${exclusion.key}：理由太短/为空`);
    if (!exclusion.evidence.trim()) problems.push(`${exclusion.key}：没有证据栏（无法覆核）`);
    if (!verdicts.includes(exclusion.verdict)) problems.push(`${exclusion.key}：分类 ${exclusion.verdict} 不在值域`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  // 本清单的分类分布（供报告引用；不作为通过条件，只保证非空）
  assert.ok(AGENT_EXCLUDED_METADATA_FIELDS.length > 0);
});

// ─────────────────────────────────────────── ② 缺键可检测（注入案例，不改源码）

test("缺键可检测：真源新增一个耐久键、B 未透传且未排除 → 契约检查器必须报 gap", () => {
  const injectedKey = "brandNewDurableField";
  const injected: readonly DurableFieldSpec[] = [
    ...DURABLE_METADATA_FIELDS,
    { key: injectedKey, cleaner: "string", note: "注入案例（模拟真源新增键）" },
  ];

  // ① 还原端是清单驱动的：注入清单后它真的放行该键（不是靠本档的键清单）
  const aOnly = toNodeMetadata({ [injectedKey]: "v" }, injected) as Record<string, unknown>;
  assert.equal(aOnly[injectedKey], "v", "还原端由真源清单导出：注入后放行");

  // ② 上行端（未改源码）不透传 → 往复真的丢失（破口是行为事实，不只是清单差集）
  const lost = toNodeMetadata(compactMetadataForAgent({ [injectedKey]: "v" } as unknown as CanvasNodeMetadata), injected);
  assert.equal(hasOwn(lost, injectedKey), false, "上行端未同步 → 往复后该键真的消失");

  // ③ 检查器必须把这个案例判成 gap（＝契约测试会红）
  const gaps = findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS);
  assert.deepEqual(
    gaps.map((g) => g.key),
    [injectedKey],
    "新增耐久键未同步时，检查器必须报出该键（否则契约测试是死的）",
  );

  // ④ 补进透传清单（模拟正确同步）→ 归零
  assert.deepEqual(findAgentChannelGaps(injected, [...AGENT_METADATA_FIELD_KEYS, injectedKey], AGENT_EXCLUDED_METADATA_FIELDS), []);
  // ⑤ 或列入排除清单（带理由）→ 归零
  assert.deepEqual(
    findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, [
      ...AGENT_EXCLUDED_METADATA_FIELDS,
      { key: injectedKey, reason: "刻意排除的理由", verdict: "intentional", evidence: "测试" },
    ]),
    [],
  );
  // ⑥ 排除但没理由 → 仍算破口（不许静默排除）
  const emptyReason = findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, [
    ...AGENT_EXCLUDED_METADATA_FIELDS,
    { key: injectedKey, reason: "   ", verdict: "intentional", evidence: "测试" },
  ]);
  assert.deepEqual(emptyReason.map((g) => g.key), [injectedKey]);
});

test("真源清单自身无破口：真清单喂检查器零 gap、零幽灵排除", () => {
  assert.deepEqual(
    findAgentChannelGaps(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS),
    [],
    "A 放行的键必须全部『被 B 透传』或『在排除清单且有理由』",
  );
  assert.deepEqual(
    findStaleAgentExclusions(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS),
    [],
    "排除清单不得含『其实已透传』或『非耐久键』的条目",
  );
});

test("单向守门：B 透传的每个键都必须是 A 的耐久键（B ⊄ A 也会造成往复丢失）", () => {
  const durable = new Set(DURABLE_METADATA_FIELD_KEYS);
  const orphan = AGENT_METADATA_FIELD_KEYS.filter((k) => !durable.has(k));
  assert.deepEqual(orphan, [], `上行端透传了还原端不放行的键（还原时必被剥）：${orphan.join(", ")}`);
});

// ─────────────────────────────────────────── ③ 真源清单 ↔ 实作的行为对齐

test("A 端输出键集＝真源耐久键清单（顺序亦同）：未注册清洗器的键会缺，此处即红", () => {
  // 全键样本（pipelineCard 的分族只影响 B；A 逐键独立放行）
  const fullSink: Record<string, unknown> = {};
  for (const field of DURABLE_METADATA_FIELDS) Object.assign(fullSink, SAMPLE_METADATA_BY_KEY[field.key]);
  fullSink.pipelineCard = "tool";
  assert.deepEqual(
    Object.keys(toNodeMetadata(fullSink)),
    [...DURABLE_METADATA_FIELD_KEYS],
    "真源清单与 toNodeMetadata 实际放行键（含键序）必须逐字一致",
  );
});

test("B 端输出键集＝真源透传键清单（工具卡族／导演台族各一次，含分族条件）", () => {
  const nonFamily = AGENT_METADATA_FIELDS.filter((f) => !f.requires);
  const base: Record<string, unknown> = {};
  for (const field of nonFamily) Object.assign(base, SAMPLE_METADATA_BY_KEY[field.key]);

  const toolSink = { ...base, ...SAMPLE_METADATA_BY_KEY.toolId, ...SAMPLE_METADATA_BY_KEY.toolInput, ...SAMPLE_METADATA_BY_KEY.toolOutput, ...SAMPLE_METADATA_BY_KEY.unsupported, ...SAMPLE_METADATA_BY_KEY.requiredCapability };
  const directorSink = { ...base, ...SAMPLE_METADATA_BY_KEY.directorSessionId, ...SAMPLE_METADATA_BY_KEY.planName, ...SAMPLE_METADATA_BY_KEY.shotCount, ...SAMPLE_METADATA_BY_KEY.healthOk, ...SAMPLE_METADATA_BY_KEY.revision };

  const expectedTool = AGENT_METADATA_FIELDS.filter((f) => !f.requires || f.requires.oneOf.includes("tool")).map((f) => f.key);
  const expectedDirector = AGENT_METADATA_FIELDS.filter((f) => !f.requires || f.requires.oneOf.includes("director")).map((f) => f.key);

  assert.deepEqual(Object.keys(compactMetadataForAgent(toolSink as unknown as CanvasNodeMetadata) ?? {}), expectedTool);
  assert.deepEqual(Object.keys(compactMetadataForAgent(directorSink as unknown as CanvasNodeMetadata) ?? {}), expectedDirector);
  // 两族联集＝完整透传键清单（没有哪个键两族都到不了）
  assert.deepEqual([...new Set([...expectedTool, ...expectedDirector])].sort(), [...AGENT_METADATA_FIELD_KEYS].sort());
});

// ─────────────────────────────────────────── ④ 截断预算（宣告 ↔ 行为）

test("截断预算：宣告的门槛/保留字数与实作行为逐项一致（content 240→120、prompt 120）", () => {
  const budgetedKeys = AGENT_METADATA_FIELDS.filter((f) => f.transform === "content" || f.transform === "prompt").map((f) => f.key);
  assert.deepEqual(
    AGENT_TRUNCATION_BUDGETS.map((b) => b.key).sort(),
    [...budgetedKeys].sort(),
    "每个带截断的键都必须有预算宣告（没有宣告＝漂移点）",
  );

  const contentBudget = AGENT_TRUNCATION_BUDGETS.find((b) => b.key === "content");
  assert.ok(contentBudget && contentBudget.triggerAt !== null);
  const atLimit = "字".repeat(contentBudget.triggerAt);
  const overLimit = "字".repeat(contentBudget.triggerAt + 1);
  assert.equal(compactMetadataForAgent({ content: atLimit })?.content, atLimit, "门槛内原样不截");
  const truncated = compactMetadataForAgent({ content: overLimit })?.content as string;
  assert.equal(truncated, `${"字".repeat(contentBudget.keepChars)}…`, "超门槛＝保留字数＋省略号");
  assert.equal(truncated.length, contentBudget.keepChars + 1);

  const promptBudget = AGENT_TRUNCATION_BUDGETS.find((b) => b.key === "prompt");
  assert.ok(promptBudget && promptBudget.triggerAt === null);
  const longPrompt = "字".repeat(promptBudget.keepChars + 50);
  assert.equal(compactMetadataForAgent({ prompt: longPrompt })?.prompt, "字".repeat(promptBudget.keepChars), "prompt 无条件截到保留字数");
});

test("分镜栏族走 storyboard-contract 的压缩（真值穿透：长栏被截但仍存活）", () => {
  const spec = AGENT_METADATA_FIELDS.find((f) => f.key === "storyboardShot");
  assert.ok(spec);
  assert.equal(spec.transform, "storyboardShot", "分镜栏族的压缩下放在 storyboard-contract（栏位清单只准一份）");
  const long = "字".repeat(12000);
  const restored = roundTrip({ storyboardShot: { ...SHOT, scriptContent: long } });
  const shot = restored.storyboardShot as Record<string, unknown> | undefined;
  assert.ok(shot, "分镜整族必须存活（漏一端＝刷新后空壳）");
  assert.equal(shot.shotNumber, "001");
  assert.ok(typeof shot.scriptContent === "string" && (shot.scriptContent as string).length < long.length, "长栏真的被压缩");
});

test("单镜旁白＋双音轨四键：真往复存活（漏一端＝刷新后音轨与锚消失，门禁 audio_anchor_present/dialogue_alignment 卡死）", () => {
  const restored = roundTrip({
    narration: "她推开门，雨声灌进走廊。",
    dialogueAudioId: "https://cdn.example.com/line-007.mp3",
    narrationAudioId: "https://cdn.example.com/vo-007.mp3",
    audioAnchorId: "https://cdn.example.com/line-007.mp3",
  });
  assert.equal(restored.narration, "她推开门，雨声灌进走廊。");
  assert.equal(restored.dialogueAudioId, "https://cdn.example.com/line-007.mp3");
  assert.equal(restored.narrationAudioId, "https://cdn.example.com/vo-007.mp3");
  assert.equal(restored.audioAnchorId, "https://cdn.example.com/line-007.mp3");
});

// ─────────────────────────────────────────── ⑤ 反向：排除清单不能吃掉活键

test("注入一个『已透传却被列进排除』的条目 → 检查器报幽灵（防排除清单洗白）", () => {
  const stale = findStaleAgentExclusions(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, [
    ...AGENT_EXCLUDED_METADATA_FIELDS,
    { key: "content", reason: "故意谎报：content 其实有透传", verdict: "intentional", evidence: "测试" },
    { key: "phantomField", reason: "根本不是耐久键", verdict: "intentional", evidence: "测试" },
  ]);
  assert.deepEqual(stale.map((e) => e.key), ["content", "phantomField"]);
});
