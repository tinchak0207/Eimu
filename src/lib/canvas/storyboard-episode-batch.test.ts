// 按集批次換模型＋批次重跑（P1-2 / D12）行為測試。
// 全部真函式斷言：真分組、真換模型、真產重跑計畫（純資料，不呼叫上游）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEpisodeModelSwitch,
  episodeIdMetadata,
  EPISODE_ID_MAX,
  planEpisodeBatchRerun,
  planEpisodeModelSwitch,
  shotEpisodeId,
  shotEpisodeIds,
  storyboardShotsOfEpisode,
  summarizeEpisodeShots,
} from "./storyboard-episode-batch";
import { addShotCandidate, selectShotCandidate, shotCandidatesMetadata } from "./storyboard-shots";
import { CanvasNodeType } from "./types";
import type { CanvasNode, CanvasNodeMetadata } from "./types";

function shotNode(id: string, shotNumber: string, metadata: CanvasNodeMetadata): CanvasNode {
  return {
    id,
    type: CanvasNodeType.Image,
    title: `镜头 ${shotNumber}`,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      ...metadata,
      storyboardShot: {
        shotNumber,
        scriptContent: "",
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
      },
    },
  };
}

function nonShotNode(id: string, metadata: CanvasNodeMetadata = {}): CanvasNode {
  return { id, type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 1, height: 1, metadata };
}

/** 一集三顆分鏡（含一顆抽過卡＋一顆沒有 prompt）＋另一集的分鏡 ＋ 一顆非分鏡節點。 */
const EP1_CANDIDATES = addShotCandidate(
  addShotCandidate(undefined, { id: "c1", prompt: "ep1 镜一，第一版" }).set,
  { id: "c2", prompt: "ep1 镜一，第二版", model: "seedance-2.0-900-特惠" },
).set;

const NODES: CanvasNode[] = [
  shotNode("n1", "001", { ...shotCandidatesMetadata(EP1_CANDIDATES), episodeId: "ep-1", model: "old-model" }),
  shotNode("n2", "002", { episodeId: "ep-1", prompt: "ep1 镜二 prompt", model: "old-model" }),
  shotNode("n3", "003", { episodeId: "ep-1", model: "old-model" }), // 沒有 prompt（誠實回報用）
  shotNode("n4", "010", { episodeId: "ep-2", model: "ep2-model" }),
  shotNode("n5", "011", { model: "no-episode-model" }), // 不歸任何一集
  nonShotNode("cfg", { episodeId: "ep-1", model: "config-model" }), // 非分鏡節點
];

// ─────────────────────────────────────────── ① 集維度

test("集歸屬：讀回、指針 patch、畫布上真的有分鏡的集清單", () => {
  assert.equal(shotEpisodeId(NODES[0]), "ep-1");
  assert.equal(shotEpisodeId(NODES[4]), undefined, "沒有 episodeId＝不歸任何一集（不猜）");
  assert.deepEqual(shotEpisodeIds(NODES), ["ep-1", "ep-2"], "非分鏡節點的集不算（cfg 被剔除）");
  assert.deepEqual(episodeIdMetadata("  ep-9  "), { episodeId: "ep-9" });
  assert.deepEqual(episodeIdMetadata(""), {}, "空值＝空 patch（不寫空殼鍵）");
  assert.equal(episodeIdMetadata("x".repeat(EPISODE_ID_MAX + 5)).episodeId?.length, EPISODE_ID_MAX);
});

test("集分鏡：只收該集的分鏡節點，且按鏡號 numeric 排序（001 < 002 < 010）", () => {
  const ep1 = storyboardShotsOfEpisode(NODES, "ep-1");
  assert.deepEqual(ep1.map((n) => n.id), ["n1", "n2", "n3"]);
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "ep-2").map((n) => n.id), ["n4"]);
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "ep-404"), [], "未知集＝空（不假裝成功）");
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "  "), []);

  const messy = [
    shotNode("m10", "10", { episodeId: "e" }),
    shotNode("m2", "2", { episodeId: "e" }),
    shotNode("m1", "1", { episodeId: "e" }),
  ];
  assert.deepEqual(storyboardShotsOfEpisode(messy, "e").map((n) => n.id), ["m1", "m2", "m10"], "未補零鏡號也不排成 10<2");
});

// ─────────────────────────────────────────── ② 按集批次換模型（D12）

test("按集換模型：計畫只涵蓋該集分鏡，其他集／非分鏡節點零改動", () => {
  const plan = planEpisodeModelSwitch(NODES, "ep-1", "seedance-2.5-900-特惠");
  assert.equal(plan.episodeId, "ep-1");
  assert.equal(plan.model, "seedance-2.5-900-特惠");
  assert.equal(plan.shotCount, 3);
  assert.deepEqual(plan.patches, [
    { nodeId: "n1", metadata: { model: "seedance-2.5-900-特惠" } },
    { nodeId: "n2", metadata: { model: "seedance-2.5-900-特惠" } },
    { nodeId: "n3", metadata: { model: "seedance-2.5-900-特惠" } },
  ]);
});

test("按集換模型：套用後該集三格全換、ep-2 與非分鏡節點原物件不動、輸入不被就地改寫", () => {
  const plan = planEpisodeModelSwitch(NODES, "ep-1", "new-model");
  const before = JSON.parse(JSON.stringify(NODES)) as CanvasNode[];
  const after = applyEpisodeModelSwitch(NODES, plan);

  assert.deepEqual(after.map((n) => n.metadata?.model), ["new-model", "new-model", "new-model", "ep2-model", "no-episode-model", "config-model"]);
  assert.equal(after[3], NODES[3], "其他集節點是同一個物件（零改動）");
  assert.equal(after[5], NODES[5], "非分鏡節點不動");
  assert.notEqual(after[0], NODES[0], "命中節點換新物件（參考比較不失效）");
  assert.equal(after[0].metadata?.storyboardShot?.shotNumber, "001", "換模型不動分鏡內容");
  assert.deepEqual(NODES, before, "輸入陣列與節點零改動");
  assert.deepEqual(after[0].metadata?.shotCandidates, EP1_CANDIDATES, "抽卡結果在換模型後原樣保留");
});

test("按集換模型：空模型／不存在的集＝空計畫（不製造無模型態、不假裝成功）", () => {
  assert.deepEqual(planEpisodeModelSwitch(NODES, "ep-1", "   ").patches, []);
  assert.equal(planEpisodeModelSwitch(NODES, "ep-1", "   ").shotCount, 0);
  assert.equal(planEpisodeModelSwitch(NODES, "ep-404", "m").shotCount, 0);
  assert.equal(planEpisodeModelSwitch(NODES, "", "m").shotCount, 0);
  assert.deepEqual(applyEpisodeModelSwitch(NODES, planEpisodeModelSwitch(NODES, "ep-404", "m")), NODES);
});

// ─────────────────────────────────────────── ③ 按集批次重跑

test("批次重跑：每格帶自己的 prompt（星標候選優先），模型換成新模型", () => {
  const plan = planEpisodeBatchRerun(NODES, "ep-1", "seedance-2.5-900-特惠");
  assert.equal(plan.model, "seedance-2.5-900-特惠");
  assert.deepEqual(plan.shots, [
    { nodeId: "n1", shotNumber: "001", prompt: "ep1 镜一，第一版", model: "seedance-2.5-900-特惠" },
    { nodeId: "n2", shotNumber: "002", prompt: "ep1 镜二 prompt", model: "seedance-2.5-900-特惠" },
  ]);
  assert.deepEqual(plan.missingPromptShotNumbers, ["003"], "沒 prompt 的格誠實列出，不編造 prompt 混進重跑清單");
});

test("批次重跑：星標換人後重跑用的是新的採用稿 prompt", () => {
  const starred = selectShotCandidate(EP1_CANDIDATES, "c2").set;
  const nodes = [
    shotNode("n1", "001", { ...shotCandidatesMetadata(starred), episodeId: "ep-1" }),
    ...NODES.slice(1),
  ];
  const plan = planEpisodeBatchRerun(nodes, "ep-1", "m");
  assert.equal(plan.shots[0]?.prompt, "ep1 镜一，第二版");
});

test("批次重跑：不給新模型時退回每格自己已用的模型（不把模型清空）", () => {
  const plan = planEpisodeBatchRerun(NODES, "ep-1", "");
  // n1 的星標是 c1（首條自動上星標，沒帶 model）⇒ 回退節點 metadata.model。
  assert.equal(plan.shots[0]?.model, "old-model", "星標候選沒帶 model 時回退節點 metadata.model");

  // 星標換到帶 model 的 c2 ⇒ 星標候選的 model 優先於節點舊模型。
  const starred = selectShotCandidate(EP1_CANDIDATES, "c2").set;
  const nodes = [shotNode("n1", "001", { ...shotCandidatesMetadata(starred), episodeId: "ep-1", model: "old-model" })];
  assert.equal(planEpisodeBatchRerun(nodes, "ep-1", "").shots[0]?.model, "seedance-2.0-900-特惠");
  assert.equal(planEpisodeBatchRerun(nodes, "ep-1", "forced-model").shots[0]?.model, "forced-model");
});

// ─────────────────────────────────────────── ④ 集分鏡摘要（UI/API 讀取端）

test("集摘要：鏡號／模型／星標／prompt 一次讀齊", () => {
  const summary = summarizeEpisodeShots(NODES, "ep-1");
  assert.equal(summary.length, 3);
  assert.deepEqual(summary[0], {
    nodeId: "n1",
    shotNumber: "001",
    title: "镜头 001",
    model: "old-model",
    prompt: "ep1 镜一，第一版",
    candidates: EP1_CANDIDATES,
    selectedCandidateId: "c1",
  });
  assert.equal(summary[2]?.prompt, null, "沒有 prompt＝null（不編造）");
  assert.equal(summary[2]?.candidates, null, "沒抽卡＝null（不製造空候選集）");
});