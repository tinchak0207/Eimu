// 節點 metadata 白名單通道契約（2026-09-25）。
//
// 病灶（已實錘事故）：metadata 有**兩個獨立白名單清洗入口**——還原端 `layout.toNodeMetadata`
// 與上行端 `compactMetadataForAgent`——鍵集合各自手工維護。漏在其中一處放行一個鍵，
// 症狀是「功能當下完全沒反應」而不是報錯（`emitsEntity` 實錘：一進前端就被剝，
// 整條自動落卡不可能觸發）。
//
// 本檔的斷言全部是**真實行為斷言**（真 `compactMetadataForAgent` → 真 `toNodeMetadata`
// 往復、真值比對），不靠源碼字串。真源＝`./node-metadata-fields`。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EXCLUDED_METADATA_FIELDS,
  AGENT_EXCLUDED_METADATA_FIELD_KEYS,
  AGENT_METADATA_FIELDS,
  AGENT_METADATA_FIELD_KEYS,
  AGENT_TRUNCATION_BUDGETS,
  DURABLE_METADATA_FIELDS,
  DURABLE_METADATA_FIELD_KEYS,
  findAgentChannelGaps,
  findStaleAgentExclusions,
  type AgentExclusionVerdict,
  type DurableFieldSpec,
} from "./node-metadata-fields";
import { toNodeMetadata } from "./layout";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import type { CanvasNodeMetadata } from "./types";

// ─────────────────────────────────────────── 樣本（每個耐久鍵一份）

/** AID 21 欄全形樣本（存活斷言只要求 shotNumber 有值、其餘逐欄字串）。 */
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

/** 3D 場景卡六欄全形樣本。 */
const SCENE_CARD = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/still.png"],
  blend_path: "/api/scene-assets/a.blend",
  glb_path: "/api/scene-assets/a.glb",
  scene_summary: "废弃灯塔主场景",
  duration_ms: 8000,
};

/**
 * 每個耐久鍵的樣本 metadata（**整包**輸入，含分族所需的同伴鍵）。
 * 值一律取「清洗後仍等於原值」的形，存活斷言才能用 deepEqual 直接比。
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
  // P1-1（2026-09-29）兩鍵漏補樣本：本檔的契約是「新增耐久鍵必須同時補樣本」，
  // 缺樣本＝該鍵永遠不被這條往復斷言覆蓋（守門件靜默失明）。
  directorStageId: { directorStageId: "stage-1" },
  shotId: { shotId: "001" },
  storyboardShot: { storyboardShot: SHOT },
  // 2026-09-30 單鏡旁白文本＋對白／旁白雙音軌（介面凍結四鍵；audioAnchorId 是相容錨，
  // 其生產者規則＝dialogueAudioId || narrationAudioId，樣本取單軌形故值取對白軌）。
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
  // 2026-09-29 P1-2：集歸屬 ＋ 分鏡候選集（樣本一律取「清洗後仍等於原值」的形）。
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
  // 2026-09-29 P1-9：任務版本史＋標籤＋星標選中（樣本取「清洗後仍等於原值」的形：
  // version 已正規化成 ISO 8601 UTC、時序升序、selectedVersion 是成員、tags 在值域內）。
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

/** 真往復：真上行壓縮 → 真還原端清洗。 */
function roundTrip(metadata: Record<string, unknown>): Record<string, unknown> {
  return toNodeMetadata(compactMetadataForAgent(metadata as unknown as CanvasNodeMetadata)) as Record<string, unknown>;
}

// ─────────────────────────────────────────── ① 往復合同（本檔的主斷言）

test("契約：每個耐久鍵經 toNodeMetadata(compactMetadataForAgent(m)) 後存活，或必須在顯式排除清單且帶理由", () => {
  const exclusionByKey = new Map(AGENT_EXCLUDED_METADATA_FIELDS.map((e) => [e.key, e]));
  const problems: string[] = [];
  const survived: string[] = [];

  for (const field of DURABLE_METADATA_FIELDS) {
    const sample = SAMPLE_METADATA_BY_KEY[field.key];
    if (!sample) {
      problems.push(`${field.key}：真源有鍵但測試無樣本（新增耐久鍵必須同時補樣本）`);
      continue;
    }
    const restored = roundTrip(sample);
    const exclusion = exclusionByKey.get(field.key);
    if (hasOwn(restored, field.key)) {
      survived.push(field.key);
      if (exclusion) problems.push(`${field.key}：排除清單謊報（實際存活）`);
      try {
        assert.deepEqual(restored[field.key], sample[field.key]);
      } catch {
        problems.push(`${field.key}：存活但值不等（清洗語義漂移）：${JSON.stringify(restored[field.key])}`);
      }
    } else if (!exclusion) {
      problems.push(`${field.key}：未存活且未列入顯式排除清單（雙白名單漏一端＝功能靜默消失）`);
    } else if (exclusion.reason.trim().length < 8) {
      problems.push(`${field.key}：排除清單條目沒有可讀的理由`);
    }
  }

  assert.deepEqual(problems, [], `metadata 白名單通道契約破口：\n${problems.join("\n")}`);

  // 未存活集合必須逐字等於排除清單（不多不少）：防「把鍵全塞進排除清單」洗白。
  const notSurvived = DURABLE_METADATA_FIELDS.map((f) => f.key).filter((k) => !survived.includes(k));
  assert.deepEqual(
    [...notSurvived].sort(),
    [...AGENT_EXCLUDED_METADATA_FIELD_KEYS].sort(),
    "未存活的耐久鍵集合與顯式排除清單必須逐字一致",
  );
});

test("排除清單：每條都有可讀理由＋證據＋機器可讀分類，且只登記耐久鍵", () => {
  const durableKeys = new Set(DURABLE_METADATA_FIELD_KEYS);
  const verdicts: readonly AgentExclusionVerdict[] = ["intentional", "suspected-gap", "dormant"];
  const problems: string[] = [];
  for (const exclusion of AGENT_EXCLUDED_METADATA_FIELDS) {
    if (!durableKeys.has(exclusion.key)) problems.push(`${exclusion.key}：不是耐久鍵（幽靈排除條目）`);
    if (exclusion.reason.trim().length < 8) problems.push(`${exclusion.key}：理由太短/為空`);
    if (!exclusion.evidence.trim()) problems.push(`${exclusion.key}：沒有證據欄（無法覆核）`);
    if (!verdicts.includes(exclusion.verdict)) problems.push(`${exclusion.key}：分類 ${exclusion.verdict} 不在值域`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  // 本清單的分類分布（供報告引用；不作為通過條件，只保證非空）
  assert.ok(AGENT_EXCLUDED_METADATA_FIELDS.length > 0);
});

// ─────────────────────────────────────────── ② 缺鍵可檢測（注入案例，不改源碼）

test("缺鍵可檢測：真源新增一個耐久鍵、B 未透傳且未排除 → 契約檢查器必須報 gap", () => {
  const injectedKey = "brandNewDurableField";
  const injected: readonly DurableFieldSpec[] = [
    ...DURABLE_METADATA_FIELDS,
    { key: injectedKey, cleaner: "string", note: "注入案例（模擬真源新增鍵）" },
  ];

  // ① 還原端是清單驅動的：注入清單後它真的放行該鍵（不是靠本檔的鍵清單）
  const aOnly = toNodeMetadata({ [injectedKey]: "v" }, injected) as Record<string, unknown>;
  assert.equal(aOnly[injectedKey], "v", "還原端由真源清單導出：注入後放行");

  // ② 上行端（未改源碼）不透傳 → 往復真的丟失（破口是行為事實，不只是清單差集）
  const lost = toNodeMetadata(compactMetadataForAgent({ [injectedKey]: "v" } as unknown as CanvasNodeMetadata), injected);
  assert.equal(hasOwn(lost, injectedKey), false, "上行端未同步 → 往復後該鍵真的消失");

  // ③ 檢查器必須把這個案例判成 gap（＝契約測試會紅）
  const gaps = findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS);
  assert.deepEqual(
    gaps.map((g) => g.key),
    [injectedKey],
    "新增耐久鍵未同步時，檢查器必須報出該鍵（否則契約測試是死的）",
  );

  // ④ 補進透傳清單（模擬正確同步）→ 歸零
  assert.deepEqual(findAgentChannelGaps(injected, [...AGENT_METADATA_FIELD_KEYS, injectedKey], AGENT_EXCLUDED_METADATA_FIELDS), []);
  // ⑤ 或列入排除清單（帶理由）→ 歸零
  assert.deepEqual(
    findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, [
      ...AGENT_EXCLUDED_METADATA_FIELDS,
      { key: injectedKey, reason: "刻意排除的理由", verdict: "intentional", evidence: "測試" },
    ]),
    [],
  );
  // ⑥ 排除但沒理由 → 仍算破口（不許靜默排除）
  const emptyReason = findAgentChannelGaps(injected, AGENT_METADATA_FIELD_KEYS, [
    ...AGENT_EXCLUDED_METADATA_FIELDS,
    { key: injectedKey, reason: "   ", verdict: "intentional", evidence: "測試" },
  ]);
  assert.deepEqual(emptyReason.map((g) => g.key), [injectedKey]);
});

test("真源清單自身無破口：真清單餵檢查器零 gap、零幽靈排除", () => {
  assert.deepEqual(
    findAgentChannelGaps(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS),
    [],
    "A 放行的鍵必須全部『被 B 透傳』或『在排除清單且有理由』",
  );
  assert.deepEqual(
    findStaleAgentExclusions(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, AGENT_EXCLUDED_METADATA_FIELDS),
    [],
    "排除清單不得含『其實已透傳』或『非耐久鍵』的條目",
  );
});

test("單向守門：B 透傳的每個鍵都必須是 A 的耐久鍵（B ⊄ A 也會造成往復丟失）", () => {
  const durable = new Set(DURABLE_METADATA_FIELD_KEYS);
  const orphan = AGENT_METADATA_FIELD_KEYS.filter((k) => !durable.has(k));
  assert.deepEqual(orphan, [], `上行端透傳了還原端不放行的鍵（還原時必被剝）：${orphan.join(", ")}`);
});

// ─────────────────────────────────────────── ③ 真源清單 ↔ 實作的行為對齊

test("A 端輸出鍵集＝真源耐久鍵清單（順序亦同）：未註冊清洗器的鍵會缺，此處即紅", () => {
  // 全鍵樣本（pipelineCard 的分族只影響 B；A 逐鍵獨立放行）
  const fullSink: Record<string, unknown> = {};
  for (const field of DURABLE_METADATA_FIELDS) Object.assign(fullSink, SAMPLE_METADATA_BY_KEY[field.key]);
  fullSink.pipelineCard = "tool";
  assert.deepEqual(
    Object.keys(toNodeMetadata(fullSink)),
    [...DURABLE_METADATA_FIELD_KEYS],
    "真源清單與 toNodeMetadata 實際放行鍵（含鍵序）必須逐字一致",
  );
});

test("B 端輸出鍵集＝真源透傳鍵清單（工具卡族／導演台族各一次，含分族條件）", () => {
  const nonFamily = AGENT_METADATA_FIELDS.filter((f) => !f.requires);
  const base: Record<string, unknown> = {};
  for (const field of nonFamily) Object.assign(base, SAMPLE_METADATA_BY_KEY[field.key]);

  const toolSink = { ...base, ...SAMPLE_METADATA_BY_KEY.toolId, ...SAMPLE_METADATA_BY_KEY.toolInput, ...SAMPLE_METADATA_BY_KEY.toolOutput, ...SAMPLE_METADATA_BY_KEY.unsupported, ...SAMPLE_METADATA_BY_KEY.requiredCapability };
  const directorSink = { ...base, ...SAMPLE_METADATA_BY_KEY.directorSessionId, ...SAMPLE_METADATA_BY_KEY.planName, ...SAMPLE_METADATA_BY_KEY.shotCount, ...SAMPLE_METADATA_BY_KEY.healthOk, ...SAMPLE_METADATA_BY_KEY.revision };

  const expectedTool = AGENT_METADATA_FIELDS.filter((f) => !f.requires || f.requires.oneOf.includes("tool")).map((f) => f.key);
  const expectedDirector = AGENT_METADATA_FIELDS.filter((f) => !f.requires || f.requires.oneOf.includes("director")).map((f) => f.key);

  assert.deepEqual(Object.keys(compactMetadataForAgent(toolSink as unknown as CanvasNodeMetadata) ?? {}), expectedTool);
  assert.deepEqual(Object.keys(compactMetadataForAgent(directorSink as unknown as CanvasNodeMetadata) ?? {}), expectedDirector);
  // 兩族聯集＝完整透傳鍵清單（沒有哪個鍵兩族都到不了）
  assert.deepEqual([...new Set([...expectedTool, ...expectedDirector])].sort(), [...AGENT_METADATA_FIELD_KEYS].sort());
});

// ─────────────────────────────────────────── ④ 截斷預算（宣告 ↔ 行為）

test("截斷預算：宣告的門檻/保留字數與實作行為逐項一致（content 240→120、prompt 120）", () => {
  const budgetedKeys = AGENT_METADATA_FIELDS.filter((f) => f.transform === "content" || f.transform === "prompt").map((f) => f.key);
  assert.deepEqual(
    AGENT_TRUNCATION_BUDGETS.map((b) => b.key).sort(),
    [...budgetedKeys].sort(),
    "每個帶截斷的鍵都必須有預算宣告（沒有宣告＝漂移點）",
  );

  const contentBudget = AGENT_TRUNCATION_BUDGETS.find((b) => b.key === "content");
  assert.ok(contentBudget && contentBudget.triggerAt !== null);
  const atLimit = "字".repeat(contentBudget.triggerAt);
  const overLimit = "字".repeat(contentBudget.triggerAt + 1);
  assert.equal(compactMetadataForAgent({ content: atLimit })?.content, atLimit, "門檻內原樣不截");
  const truncated = compactMetadataForAgent({ content: overLimit })?.content as string;
  assert.equal(truncated, `${"字".repeat(contentBudget.keepChars)}…`, "超門檻＝保留字數＋省略號");
  assert.equal(truncated.length, contentBudget.keepChars + 1);

  const promptBudget = AGENT_TRUNCATION_BUDGETS.find((b) => b.key === "prompt");
  assert.ok(promptBudget && promptBudget.triggerAt === null);
  const longPrompt = "字".repeat(promptBudget.keepChars + 50);
  assert.equal(compactMetadataForAgent({ prompt: longPrompt })?.prompt, "字".repeat(promptBudget.keepChars), "prompt 無條件截到保留字數");
});

test("分鏡欄族走 storyboard-contract 的壓縮（真值穿透：長欄被截但仍存活）", () => {
  const spec = AGENT_METADATA_FIELDS.find((f) => f.key === "storyboardShot");
  assert.ok(spec);
  assert.equal(spec.transform, "storyboardShot", "分鏡欄族的壓縮下放在 storyboard-contract（欄位清單只准一份）");
  const long = "字".repeat(12000);
  const restored = roundTrip({ storyboardShot: { ...SHOT, scriptContent: long } });
  const shot = restored.storyboardShot as Record<string, unknown> | undefined;
  assert.ok(shot, "分鏡整族必須存活（漏一端＝刷新後空殼）");
  assert.equal(shot.shotNumber, "001");
  assert.ok(typeof shot.scriptContent === "string" && (shot.scriptContent as string).length < long.length, "長欄真的被壓縮");
});

test("單鏡旁白＋雙音軌四鍵：真往復存活（漏一端＝刷新後音軌與錨消失，門禁 audio_anchor_present/dialogue_alignment 卡死）", () => {
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

// ─────────────────────────────────────────── ⑤ 反向：排除清單不能吃掉活鍵

test("注入一個『已透傳卻被列進排除』的條目 → 檢查器報幽靈（防排除清單洗白）", () => {
  const stale = findStaleAgentExclusions(DURABLE_METADATA_FIELDS, AGENT_METADATA_FIELD_KEYS, [
    ...AGENT_EXCLUDED_METADATA_FIELDS,
    { key: "content", reason: "故意謊報：content 其實有透傳", verdict: "intentional", evidence: "測試" },
    { key: "phantomField", reason: "根本不是耐久鍵", verdict: "intentional", evidence: "測試" },
  ]);
  assert.deepEqual(stale.map((e) => e.key), ["content", "phantomField"]);
});
