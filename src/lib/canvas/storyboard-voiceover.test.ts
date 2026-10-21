// 逐镜配音服务层行为测试。
//
// 全部是**真函式行为断言**：真投影、真组行、真分批、真逐行序列、真停手、真回写、真漂移。
// **零上游**：TTS 由注入的假 client 提供，测试里没有任何网路/DB 呼叫。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStoryboardShot } from "@/lib/storyboard-contract";
import { CanvasNodeType, type CanvasNode, type CanvasProject } from "./types";
import {
  applyVoiceoverShotsToNodes,
  estimateVoiceoverCoins,
  planVoiceoverBatches,
  projectStoryboardShots,
  resolveVoiceoverVoice,
  runStoryboardVoiceover,
  storyboardVoiceover,
  type StoryboardVoiceoverLineRequest,
  type StoryboardVoiceoverTtsClient,
} from "./storyboard-voiceover";

type VoiceoverProject = Pick<CanvasProject, "nodes" | "episodes" | "scriptType" | "narrationVoice">;

const MP3 = (n: number) => `https://store.tinchak0207.xyz/tts/line-${n}.mp3`;

function shotNode(
  shotNumber: string,
  opts: {
    narration?: string;
    dialogue?: string;
    episodeId?: string;
    dialogueAudioId?: string;
    narrationAudioId?: string;
  } = {},
): CanvasNode {
  const storyboardShot = normalizeStoryboardShot({ shotNumber, dialogue: opts.dialogue ?? "" });
  const metadata: Record<string, unknown> = {};
  if (storyboardShot) metadata.storyboardShot = storyboardShot;
  if (opts.narration) metadata.narration = opts.narration;
  if (opts.episodeId) metadata.episodeId = opts.episodeId;
  if (opts.dialogueAudioId) metadata.dialogueAudioId = opts.dialogueAudioId;
  if (opts.narrationAudioId) metadata.narrationAudioId = opts.narrationAudioId;
  return {
    id: `node-${shotNumber}`,
    type: CanvasNodeType.Image,
    title: `镜 ${shotNumber}`,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: metadata as CanvasNode["metadata"],
  };
}

/** 六镜各有一段旁白（P2 病灶的长相：旁白贯穿镜 1-6，必须得到 6 行而非 1 行）。 */
function sixNarrationNodes(): CanvasNode[] {
  return [1, 2, 3, 4, 5, 6].map((n) => shotNode(`00${n}`, { narration: `第 ${n} 镜的旁白台词` }));
}

function project(nodes: CanvasNode[], extra: Partial<VoiceoverProject> = {}): VoiceoverProject {
  return { nodes, ...extra };
}

function fakeClient(
  handler?: (request: StoryboardVoiceoverLineRequest) => { audioUrl?: string | null; durationMs?: number | null; costCoins?: number | null; error?: string },
): StoryboardVoiceoverTtsClient & { calls: StoryboardVoiceoverLineRequest[] } {
  const calls: StoryboardVoiceoverLineRequest[] = [];
  const client = (async (request: StoryboardVoiceoverLineRequest) => {
    calls.push(request);
    return handler ? handler(request) : { audioUrl: MP3(request.index + 1), durationMs: 10_000, costCoins: 0.001 };
  }) as StoryboardVoiceoverTtsClient & { calls: StoryboardVoiceoverLineRequest[] };
  client.calls = calls;
  return client;
}

// ─────────────────────────────────────────── dryRun（付费前报备）

test("dryRun：6 镜旁白 → 6 行（不折成 1 行），estimatedCoins = totalChars × 0.001", async () => {
  const outcome = await storyboardVoiceover(project(sixNarrationNodes()), { dryRun: true, client: fakeClient() });
  assert.equal(outcome.kind, "dryRun");
  if (outcome.kind !== "dryRun") return;
  const plan = outcome.plan;
  assert.equal(plan.refused, undefined);
  assert.equal(plan.lines.length, 6);
  assert.deepEqual(
    plan.lines.map((line) => line.shotNumber),
    ["001", "002", "003", "004", "005", "006"],
  );
  assert.deepEqual(plan.lines.map((line) => line.field), ["narration", "narration", "narration", "narration", "narration", "narration"]);
  assert.ok(plan.totalChars > 0);
  assert.equal(plan.estimatedCoins, plan.totalChars * 0.001);
  assert.equal(plan.estimatedCoins, estimateVoiceoverCoins(plan.totalChars));
  // 字数＝逐行字数和（不重复计、不漏行）。
  assert.equal(plan.totalChars, plan.lines.reduce((sum, line) => sum + line.chars, 0));
});

test("dryRun 零呼叫：tripwire client 一次都不被呼叫（真跑前不花钱）", async () => {
  let calls = 0;
  const tripwire: StoryboardVoiceoverTtsClient = async () => {
    calls += 1;
    return { audioUrl: null, error: "dryRun 不得呼叫 TTS" };
  };
  const outcome = await storyboardVoiceover(project(sixNarrationNodes()), { dryRun: true, client: tripwire });
  assert.equal(outcome.kind, "dryRun");
  assert.equal(calls, 0);
});

test("dryRun：51 行 → 具名拒 too_many_lines（不截断、不静默少做）", async () => {
  const nodes = Array.from({ length: 51 }, (_, i) => shotNode(String(i + 1).padStart(3, "0"), { narration: `第 ${i + 1} 句` }));
  let calls = 0;
  const tripwire: StoryboardVoiceoverTtsClient = async () => {
    calls += 1;
    return { audioUrl: MP3(1) };
  };
  const outcome = await storyboardVoiceover(project(nodes), { dryRun: true, client: tripwire });
  assert.equal(outcome.kind, "dryRun");
  if (outcome.kind !== "dryRun") return;
  assert.ok(outcome.plan.refused);
  assert.equal(outcome.plan.refused?.code, "too_many_lines");
  assert.equal(calls, 0);
});

test("max_lines 陷阱：25 行不被默认值 20 静默截断，逐行显式带 maxLines ≥ 21", async () => {
  const nodes = Array.from({ length: 25 }, (_, i) => shotNode(String(i + 1).padStart(3, "0"), { narration: `第 ${i + 1} 句` }));
  const client = fakeClient();
  const execution = await runStoryboardVoiceover(project(nodes), { client });
  assert.equal(execution.result.applied, true);
  assert.equal(execution.result.lines.length, 25);
  assert.equal(client.calls.length, 25);
  // 每一行请求都显式覆盖了上游默认值 20（≥21），且 ≥ 本批行数。
  assert.ok(client.calls.every((call) => call.maxLines >= 21 && call.maxLines >= execution.result.lines.length));
  assert.ok(client.calls.every((call) => call.batchCount >= 1));
});

test("分批计画具名：maxLinesPerBatch 超硬上限 50 → 具名拒；指定 10 → 25 行切 3 批", () => {
  const overLimit = planVoiceoverBatches(25, 51);
  assert.ok("refused" in overLimit);
  if ("refused" in overLimit) assert.equal(overLimit.refused.code, "batch_size_over_tool_max_lines");

  const plan = planVoiceoverBatches(25, 10);
  assert.ok(!("refused" in plan));
  if ("refused" in plan) return;
  assert.deepEqual(
    plan.batches.map((batch) => [batch.fromLine, batch.toLine, batch.lineCount]),
    [
      [0, 10, 10],
      [10, 20, 10],
      [20, 25, 5],
    ],
  );
});

// ─────────────────────────────────────────── 真跑

test("真跑：6 行全成 → 每镜 narrationAudioId／audioAnchorId 生效，drift 逐镜可查", async () => {
  const nodes = sixNarrationNodes();
  const client = fakeClient();
  const execution = await runStoryboardVoiceover(project(nodes), { client });

  assert.equal(execution.result.ok, true);
  assert.equal(execution.result.applied, true);
  assert.equal(execution.result.refused, undefined);
  assert.equal(client.calls.length, 6);
  // 序列呼叫（禁并发）：每次呼叫 index 依序 0..5。
  assert.deepEqual(client.calls.map((call) => call.index), [0, 1, 2, 3, 4, 5]);

  const merged = applyVoiceoverShotsToNodes(nodes, execution.entries, execution.shots);
  assert.deepEqual(merged.missingNodeIds, []);
  for (let i = 0; i < 6; i++) {
    const node = merged.nodes[i];
    assert.equal(node.metadata?.narrationAudioId, MP3(i + 1));
    // 无对白轨 ⇒ 锚 = narrationAudioId。
    assert.equal(node.metadata?.audioAnchorId, MP3(i + 1));
    // 旁白文本不被覆盖。
    assert.equal(node.metadata?.narration, `第 ${i + 1} 镜的旁白台词`);
  }
  // 输入不被就地改写。
  assert.equal(nodes[0].metadata?.narrationAudioId, undefined);

  // 时长漂移逐镜可查（站点无计画秒数 ⇒ plannedSec null，仍逐镜回报实测值）。
  assert.equal(execution.result.drift.length, 6);
  assert.deepEqual(
    execution.result.drift.map((entry) => entry.shotNumber),
    ["001", "002", "003", "004", "005", "006"],
  );
  for (const entry of execution.result.drift) {
    assert.equal(entry.plannedSec, null);
    assert.equal(entry.actualSec, 10);
    assert.equal(entry.deltaSec, null);
    assert.equal(entry.overThreshold, false);
  }
  assert.deepEqual(execution.result.unmeasuredDurations, []);
  assert.equal(execution.result.costCoins, 0.006);
});

test("真跑：某行 TTS 失败 → 立即停手、整批拒写、分镜原样", async () => {
  const nodes = sixNarrationNodes();
  const client = fakeClient((request) =>
    request.index === 2 ? { error: "上游 503" } : { audioUrl: MP3(request.index + 1), durationMs: 10_000 },
  );
  const execution = await runStoryboardVoiceover(project(nodes), { client });

  assert.equal(execution.result.ok, false);
  assert.equal(execution.result.applied, false);
  assert.equal(execution.result.refused?.code, "tts_line_failed");
  assert.match(execution.result.refused?.note ?? "", /第 3 行/);
  // 立即停手：失败行之后的行一次都没送（不续花钱）。
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls.map((call) => call.index), [0, 1, 2]);
  // 分镜原样（未部分写入）。
  assert.deepEqual(execution.shots, projectStoryboardShots(project(nodes)).entries.map((entry) => entry.shot));
  const merged = applyVoiceoverShotsToNodes(nodes, execution.entries, execution.shots);
  assert.ok(merged.nodes.every((node) => node.metadata?.narrationAudioId === undefined));
});

test("真跑：任务成功但回不可用音频 URL（图 URL）→ 整批拒写", async () => {
  const nodes = sixNarrationNodes();
  const client = fakeClient(() => ({ audioUrl: "https://store.tinchak0207.xyz/cover.png", durationMs: 1000 }));
  const execution = await runStoryboardVoiceover(project(nodes), { client });
  assert.equal(execution.result.applied, false);
  assert.equal(execution.result.refused?.code, "tts_line_failed");
});

test("真跑：duration_ms 站点无真源（null）→ 不阻挡写入，但逐镜进 unmeasuredDurations", async () => {
  const nodes = sixNarrationNodes();
  const client = fakeClient((request) => ({ audioUrl: MP3(request.index + 1), durationMs: null, costCoins: null }));
  const execution = await runStoryboardVoiceover(project(nodes), { client });
  assert.equal(execution.result.applied, true);
  assert.deepEqual(execution.result.unmeasuredDurations, ["001", "002", "003", "004", "005", "006"]);
  // 无法实测 ⇒ actualSec 全为 null，不冒充。
  assert.ok(execution.result.drift.every((entry) => entry.actualSec === null && entry.deltaSec === null));
  // 有行执行但任一花费未知 ⇒ costCoins null（不填 0 假装免费）。
  assert.equal(execution.result.costCoins, null);
});

test("真跑：专案无任何台词 → 具名拒 no_lines（不假装写入空集）", async () => {
  const nodes = [shotNode("001"), shotNode("002")];
  const client = fakeClient();
  const execution = await runStoryboardVoiceover(project(nodes), { client });
  assert.equal(execution.result.applied, false);
  assert.equal(execution.result.refused?.code, "no_lines");
  assert.equal(client.calls.length, 0);
});

// ─────────────────────────────────────────── 投影与回写细节

test("投影：对白＋旁白各一行；既有对白轨一起投影，缺对白文本时锚仍对白优先", async () => {
  const nodes = [
    // 镜 001：有对白文本 ⇒ 对白行会被重新合成（覆盖旧的对白轨）。
    shotNode("001", { dialogue: "[A]：「你来了」", narration: "旁白一", dialogueAudioId: MP3(99) }),
    // 镜 002：有既存对白轨但**没有对白文本** ⇒ 本轮不重合成对白，锚必须仍指那支既存对白轨。
    shotNode("002", { narration: "旁白二", dialogueAudioId: MP3(99) }),
  ];
  const projection = projectStoryboardShots(project(nodes));
  assert.equal(projection.entries.length, 2);
  // 既有对白轨被投影进扁平分镜（否则回写时锚会漏掉对白优先序）。
  assert.equal(projection.entries[0].shot.dialogueAudioId, MP3(99));
  assert.equal(projection.entries[1].shot.dialogueAudioId, MP3(99));

  const client = fakeClient();
  const execution = await runStoryboardVoiceover(project(nodes), { client });
  assert.equal(execution.result.applied, true);
  // 镜 001：对白 + 旁白 = 2 行；镜 002：1 行 ⇒ 共 3 行（识别既有对白文本，才重组对白）。
  assert.deepEqual(execution.result.lines.map((line) => `${line.shotNumber}:${line.field}`), [
    "001:dialogue",
    "001:narration",
    "002:narration",
  ]);

  const merged = applyVoiceoverShotsToNodes(nodes, execution.entries, execution.shots);
  const first = merged.nodes[0];
  // 有对白文本 ⇒ 本轮的逐镜配音重合成对白，两支轨都被新音档覆盖。
  assert.equal(first.metadata?.dialogueAudioId, MP3(1));
  assert.equal(first.metadata?.narrationAudioId, MP3(2));
  assert.equal(first.metadata?.audioAnchorId, MP3(1)); // 锚对白优先。
  // 无对白文本 ⇒ 只补旁白，既存对白轨保持优先。
  assert.equal(merged.nodes[1].metadata?.dialogueAudioId, MP3(99));
  assert.equal(merged.nodes[1].metadata?.narrationAudioId, MP3(3));
  assert.equal(merged.nodes[1].metadata?.audioAnchorId, MP3(99));
});

test("投影：episode 指定 → 只取该集；集不存在 → 具名拒 episode_not_found", () => {
  const nodes = [
    shotNode("001", { narration: "一", episodeId: "ep-1" }),
    shotNode("002", { narration: "二", episodeId: "ep-2" }),
    shotNode("003", { narration: "三" }),
  ];
  const proj = project(nodes, {
    episodes: [
      { id: "ep-1", episodeNo: 1, title: "第一集", status: "draft", createdAt: "x", updatedAt: "x" },
      { id: "ep-2", episodeNo: 2, title: "第二集", status: "draft", createdAt: "x", updatedAt: "x" },
    ],
  });
  const first = projectStoryboardShots(proj, 1);
  assert.deepEqual(first.entries.map((entry) => entry.shot.shotNumber), ["001"]);
  assert.equal(first.episodeId, "ep-1");

  const missing = projectStoryboardShots(proj, 9);
  assert.equal(missing.refused?.code, "episode_not_found");
  assert.equal(missing.entries.length, 0);
});

test("回写：目标节点在落盘前消失 → missingNodeIds 非空（调用端据此整批拒写）", () => {
  const nodes = sixNarrationNodes();
  const projection = projectStoryboardShots(project(nodes));
  const applied = projection.entries.map((entry) => ({ ...entry.shot, narrationAudioId: MP3(1), audioAnchorId: MP3(1) }));
  const shrunk = nodes.slice(0, 5);
  const merged = applyVoiceoverShotsToNodes(shrunk, projection.entries, applied);
  assert.deepEqual(merged.missingNodeIds, ["node-006"]);
  assert.ok(merged.nodes.every((node) => node.metadata?.narrationAudioId === undefined));
});

test("音色：非解说剧／未绑定 ⇒ 既有默认音色；解说剧绑定 ⇒ 用绑定值", () => {
  assert.equal(resolveVoiceoverVoice({ scriptType: undefined, narrationVoice: "zh-CN-YunxiNeural" }), "zh-CN-XiaoxiaoNeural");
  assert.equal(resolveVoiceoverVoice({ scriptType: "plot", narrationVoice: "zh-CN-YunxiNeural" }), "zh-CN-XiaoxiaoNeural");
  assert.equal(resolveVoiceoverVoice({ scriptType: "monologue", narrationVoice: "zh-CN-YunxiNeural" }), "zh-CN-YunxiNeural");
  assert.equal(resolveVoiceoverVoice({ scriptType: "monologue", narrationVoice: "不是音色" }), "zh-CN-XiaoxiaoNeural");
});