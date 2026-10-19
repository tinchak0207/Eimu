// POST /api/canvas/storyboard-qc —— 把站点分镜喂进 **本地** `storyboard_qc_17` 门禁（唯读、零上游）。
//
// 结构修因（病历 `tts-multiline-narration-p2-bug`／`2026-09-30-agnes-symdiff-b-class-gaps-landed`）：
// 门禁的 input 过去全靠 agent 手打 JSON；站点侧的桥不读节点 `audioAnchorId`，导致
// `audio_anchor_present`/`dialogue_alignment` 两门**实务上永远不可能过**。本路由是
// `storyboardQcGateArgs`（`src/lib/storyboard-contract.ts`）的**第一个生产呼叫端**——把
// 「专案节点 metadata（含逐镜配音回写的音轨锚）」→ 桥接栏位 → 本地门禁 接成一条唯读端点。
//
// body：`{ projectId: string; episode?: number; llmSemantic?: boolean }`
//   · `episode` 缺席＝全专案分镜（按镜号 numeric 排序）；给了＝只取该集（`CanvasEpisode.episodeNo`）。
//   · `llmSemantic` 缺席＝false（纯代码判定）。**true 一律具名拒（501）**——语义层需付费上游，
//     不在本端点范围；本路由**零上游、零付费**。
//
// ── 照抄的既有范式（同目录 `storyboard-voiceover/route.ts`）────────────────────
//   · 认证＝`requireVerifiedUser`＋`unauthorized`（`./storyboard-voiceover/route.ts:138-139`）。
//   · 错误信封＝`fail(status, message, code)` → `{ success:false, error, code }`
//     （逐字照 `./storyboard-voiceover/route.ts:61-64`）。
//   · 读专案＝`readCanvasProject(caller.user.id, projectId)`＋找不到回 404
//     （逐字照 `./storyboard-voiceover/route.ts:164-171`）。
//
// ── 诚实边界（不假成功）──────────────────────────────────────────────────
//   ① 集作用域：`readCanvasProject` 是**个人画布**轮子；团队画布（`scope:"team"`）如实 404。
//   ② 卡实体：`listCharacterCards` 是名称→id 解析与 `character_lock`/`scene_lock` 分流的唯一真源
//      （`character-card-store.ts:122`）。读卡失败时**如实退化成空清单**（不改口径、不假成功，
//      该 block 的门自然 block）。
//   ③ 本地判定：门禁是纯代码（`shortdrama-domain/index.ts:411` 的 `storyboardQc`），**不发任何
//      生成呼叫**；回传的 `gates`/`ready` 即门禁自身判定，不经上游、不受网路影响。

import { NextRequest, NextResponse } from "next/server";
import { listCharacterCards } from "@/lib/character-card-store";
import type { CharacterCard } from "@/lib/character-cards";
import { readCanvasProject } from "@/lib/canvas/project-store";
import { storyboardShotsOfEpisode } from "@/lib/canvas/storyboard-episode-batch";
import type { CanvasNode } from "@/lib/canvas/types";
import { runShortDramaTool } from "@/lib/shortdrama-domain";
import type { StoryboardQcOutput } from "@/lib/shortdrama-domain";
import {
  normalizeStoryboardShot,
  storyboardQcContextFromProject,
  storyboardQcGateArgs,
  type StoryboardScriptShot,
} from "@/lib/storyboard-contract";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  // 回应形状与同目录既有路由逐字同源（`storyboard-voiceover/route.ts:61-64`）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 节点 → 21 栏分镜（唯一真源 = `metadata.storyboardShot`；`shotNumber` 空者整包丢弃）。 */
function shotOf(node: CanvasNode): StoryboardScriptShot | null {
  return normalizeStoryboardShot(node?.metadata?.storyboardShot);
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }

  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");

  // episode 缺席＝全专案分镜；给了就必须是 ≥1 的整数（＝CanvasEpisode.episodeNo）。
  const episodeRaw = body?.episode;
  if (episodeRaw !== undefined && episodeRaw !== null && (!Number.isInteger(episodeRaw) || (episodeRaw as number) < 1)) {
    return fail(400, "episode 必须是 ≥1 的整数（对应 CanvasEpisode.episodeNo）。", "invalid_payload");
  }
  const episode = episodeRaw === undefined || episodeRaw === null ? undefined : (episodeRaw as number);

  // llmSemantic：本路由不做语义层（需付费上游）；true 具名拒，**不发任何呼叫**。
  if (body?.llmSemantic !== undefined && typeof body.llmSemantic !== "boolean") {
    return fail(400, "llmSemantic 必须是布尔值。", "invalid_payload");
  }
  if (body?.llmSemantic === true) {
    return fail(
      501,
      "本端点只做本地确定性门禁（storyboard_qc_17）；llmSemantic 语义层需付费上游，未实现，本次未发出任何调用。",
      "llm_semantic_unavailable",
    );
  }

  let project;
  try {
    project = await readCanvasProject(caller.user.id, projectId);
  } catch (error) {
    console.error("[canvas] storyboard-qc read project failed:", error);
    return fail(500, "读取画布失败，请稍后再试", "internal_error");
  }
  if (!project) return fail(404, "画布项目不存在", "project_not_found");

  // ── 专案 → 目标分镜（21 栏）──
  const nodes: CanvasNode[] = Array.isArray(project.nodes) ? project.nodes : [];
  let shots: StoryboardScriptShot[];
  if (episode !== undefined) {
    const match = (project.episodes ?? []).find((item) => item?.episodeNo === episode);
    if (!match) {
      return fail(404, `画布项目里没有第 ${episode} 集（CanvasEpisode.episodeNo 查无）；不退回全专案、不按节点序切段。`, "episode_not_found");
    }
    shots = storyboardShotsOfEpisode(nodes, match.id)
      .map(shotOf)
      .filter((shot): shot is StoryboardScriptShot => shot !== null);
  } else {
    shots = nodes
      .map(shotOf)
      .filter((shot): shot is StoryboardScriptShot => shot !== null)
      .sort((a, b) => a.shotNumber.localeCompare(b.shotNumber, undefined, { numeric: true }));
  }

  // 卡实体（名称→id 解析 + character_lock/scene_lock 分流的唯一真源）。读取失败＝如实退化。
  let cards: CharacterCard[];
  try {
    cards = await listCharacterCards(caller.user.id);
  } catch (error) {
    console.error("[canvas] storyboard-qc list cards failed:", error);
    cards = [];
  }

  // ── 专案上下文 → 桥接栏位 → 门禁 args（`productionFieldsFromContext` 在 `storyboardQcGateArgs` 内）──
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(project, { cards });
  const args = storyboardQcGateArgs(shots, context);

  // ── 本地门禁判定（纯代码、零上游）──
  const result = runShortDramaTool<StoryboardQcOutput>("storyboard_qc_17", args.input);
  const gates = result.gates;
  const gatesPassed = gates.filter((gate) => gate.passed).length;

  return NextResponse.json(
    {
      ok: result.status === "succeeded",
      gates,
      gates_passed: gatesPassed,
      ready: result.output.ready,
      shotCount: result.output.shotCount,
      // 诚实回报：桥接层缺项（缺输入 ≠ 门禁过了）与未解析卡 id。门禁自身判定在 `gates`。
      missing: args.missing,
      unresolvedCardIds,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}