// 按集批次换模型＋批次重跑（P1-2 / D12）行为测试。
// 全部真函式断言：真分组、真换模型、真产重跑计画（纯资料，不呼叫上游）。
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

/** 一集三颗分镜（含一颗抽过卡＋一颗没有 prompt）＋另一集的分镜 ＋ 一颗非分镜节点。 */
const EP1_CANDIDATES = addShotCandidate(
  addShotCandidate(undefined, { id: "c1", prompt: "ep1 镜一，第一版" }).set,
  { id: "c2", prompt: "ep1 镜一，第二版", model: "seedance-2.0-900-特惠" },
).set;

const NODES: CanvasNode[] = [
  shotNode("n1", "001", { ...shotCandidatesMetadata(EP1_CANDIDATES), episodeId: "ep-1", model: "old-model" }),
  shotNode("n2", "002", { episodeId: "ep-1", prompt: "ep1 镜二 prompt", model: "old-model" }),
  shotNode("n3", "003", { episodeId: "ep-1", model: "old-model" }), // 没有 prompt（诚实回报用）
  shotNode("n4", "010", { episodeId: "ep-2", model: "ep2-model" }),
  shotNode("n5", "011", { model: "no-episode-model" }), // 不归任何一集
  nonShotNode("cfg", { episodeId: "ep-1", model: "config-model" }), // 非分镜节点
];

// ─────────────────────────────────────────── ① 集维度

test("集归属：读回、指针 patch、画布上真的有分镜的集清单", () => {
  assert.equal(shotEpisodeId(NODES[0]), "ep-1");
  assert.equal(shotEpisodeId(NODES[4]), undefined, "没有 episodeId＝不归任何一集（不猜）");
  assert.deepEqual(shotEpisodeIds(NODES), ["ep-1", "ep-2"], "非分镜节点的集不算（cfg 被剔除）");
  assert.deepEqual(episodeIdMetadata("  ep-9  "), { episodeId: "ep-9" });
  assert.deepEqual(episodeIdMetadata(""), {}, "空值＝空 patch（不写空壳键）");
  assert.equal(episodeIdMetadata("x".repeat(EPISODE_ID_MAX + 5)).episodeId?.length, EPISODE_ID_MAX);
});

test("集分镜：只收该集的分镜节点，且按镜号 numeric 排序（001 < 002 < 010）", () => {
  const ep1 = storyboardShotsOfEpisode(NODES, "ep-1");
  assert.deepEqual(ep1.map((n) => n.id), ["n1", "n2", "n3"]);
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "ep-2").map((n) => n.id), ["n4"]);
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "ep-404"), [], "未知集＝空（不假装成功）");
  assert.deepEqual(storyboardShotsOfEpisode(NODES, "  "), []);

  const messy = [
    shotNode("m10", "10", { episodeId: "e" }),
    shotNode("m2", "2", { episodeId: "e" }),
    shotNode("m1", "1", { episodeId: "e" }),
  ];
  assert.deepEqual(storyboardShotsOfEpisode(messy, "e").map((n) => n.id), ["m1", "m2", "m10"], "未补零镜号也不排成 10<2");
});

// ─────────────────────────────────────────── ② 按集批次换模型（D12）

test("按集换模型：计画只涵盖该集分镜，其他集／非分镜节点零改动", () => {
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

test("按集换模型：套用后该集三格全换、ep-2 与非分镜节点原物件不动、输入不被就地改写", () => {
  const plan = planEpisodeModelSwitch(NODES, "ep-1", "new-model");
  const before = JSON.parse(JSON.stringify(NODES)) as CanvasNode[];
  const after = applyEpisodeModelSwitch(NODES, plan);

  assert.deepEqual(after.map((n) => n.metadata?.model), ["new-model", "new-model", "new-model", "ep2-model", "no-episode-model", "config-model"]);
  assert.equal(after[3], NODES[3], "其他集节点是同一个物件（零改动）");
  assert.equal(after[5], NODES[5], "非分镜节点不动");
  assert.notEqual(after[0], NODES[0], "命中节点换新物件（参考比较不失效）");
  assert.equal(after[0].metadata?.storyboardShot?.shotNumber, "001", "换模型不动分镜内容");
  assert.deepEqual(NODES, before, "输入阵列与节点零改动");
  assert.deepEqual(after[0].metadata?.shotCandidates, EP1_CANDIDATES, "抽卡结果在换模型后原样保留");
});

test("按集换模型：空模型／不存在的集＝空计画（不制造无模型态、不假装成功）", () => {
  assert.deepEqual(planEpisodeModelSwitch(NODES, "ep-1", "   ").patches, []);
  assert.equal(planEpisodeModelSwitch(NODES, "ep-1", "   ").shotCount, 0);
  assert.equal(planEpisodeModelSwitch(NODES, "ep-404", "m").shotCount, 0);
  assert.equal(planEpisodeModelSwitch(NODES, "", "m").shotCount, 0);
  assert.deepEqual(applyEpisodeModelSwitch(NODES, planEpisodeModelSwitch(NODES, "ep-404", "m")), NODES);
});

// ─────────────────────────────────────────── ③ 按集批次重跑

test("批次重跑：每格带自己的 prompt（星标候选优先），模型换成新模型", () => {
  const plan = planEpisodeBatchRerun(NODES, "ep-1", "seedance-2.5-900-特惠");
  assert.equal(plan.model, "seedance-2.5-900-特惠");
  assert.deepEqual(plan.shots, [
    { nodeId: "n1", shotNumber: "001", prompt: "ep1 镜一，第一版", model: "seedance-2.5-900-特惠" },
    { nodeId: "n2", shotNumber: "002", prompt: "ep1 镜二 prompt", model: "seedance-2.5-900-特惠" },
  ]);
  assert.deepEqual(plan.missingPromptShotNumbers, ["003"], "没 prompt 的格诚实列出，不编造 prompt 混进重跑清单");
});

test("批次重跑：星标换人后重跑用的是新的采用稿 prompt", () => {
  const starred = selectShotCandidate(EP1_CANDIDATES, "c2").set;
  const nodes = [
    shotNode("n1", "001", { ...shotCandidatesMetadata(starred), episodeId: "ep-1" }),
    ...NODES.slice(1),
  ];
  const plan = planEpisodeBatchRerun(nodes, "ep-1", "m");
  assert.equal(plan.shots[0]?.prompt, "ep1 镜一，第二版");
});

test("批次重跑：不给新模型时退回每格自己已用的模型（不把模型清空）", () => {
  const plan = planEpisodeBatchRerun(NODES, "ep-1", "");
  // n1 的星标是 c1（首条自动上星标，没带 model）⇒ 回退节点 metadata.model。
  assert.equal(plan.shots[0]?.model, "old-model", "星标候选没带 model 时回退节点 metadata.model");

  // 星标换到带 model 的 c2 ⇒ 星标候选的 model 优先于节点旧模型。
  const starred = selectShotCandidate(EP1_CANDIDATES, "c2").set;
  const nodes = [shotNode("n1", "001", { ...shotCandidatesMetadata(starred), episodeId: "ep-1", model: "old-model" })];
  assert.equal(planEpisodeBatchRerun(nodes, "ep-1", "").shots[0]?.model, "seedance-2.0-900-特惠");
  assert.equal(planEpisodeBatchRerun(nodes, "ep-1", "forced-model").shots[0]?.model, "forced-model");
});

// ─────────────────────────────────────────── ④ 集分镜摘要（UI/API 读取端）

test("集摘要：镜号／模型／星标／prompt 一次读齐", () => {
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
  assert.equal(summary[2]?.prompt, null, "没有 prompt＝null（不编造）");
  assert.equal(summary[2]?.candidates, null, "没抽卡＝null（不制造空候选集）");
});