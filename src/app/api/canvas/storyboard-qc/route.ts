// POST /api/canvas/storyboard-qc —— 把站點分鏡餵進 **本地** `storyboard_qc_17` 門禁（唯讀、零上游）。
//
// 結構修因（病歷 `tts-multiline-narration-p2-bug`／`2026-09-30-agnes-symdiff-b-class-gaps-landed`）：
// 門禁的 input 過去全靠 agent 手打 JSON；站點側的橋不讀節點 `audioAnchorId`，導致
// `audio_anchor_present`/`dialogue_alignment` 兩門**實務上永遠不可能過**。本路由是
// `storyboardQcGateArgs`（`src/lib/storyboard-contract.ts`）的**第一個生產呼叫端**——把
// 「專案節點 metadata（含逐鏡配音回寫的音軌錨）」→ 橋接欄位 → 本地門禁 接成一條唯讀端點。
//
// body：`{ projectId: string; episode?: number; llmSemantic?: boolean }`
//   · `episode` 缺席＝全專案分鏡（按鏡號 numeric 排序）；給了＝只取該集（`CanvasEpisode.episodeNo`）。
//   · `llmSemantic` 缺席＝false（純代碼判定）。**true 一律具名拒（501）**——語義層需付費上游，
//     不在本端點範圍；本路由**零上游、零付費**。
//
// ── 照抄的既有範式（同目錄 `storyboard-voiceover/route.ts`）────────────────────
//   · 認證＝`requireVerifiedUser`＋`unauthorized`（`./storyboard-voiceover/route.ts:138-139`）。
//   · 錯誤信封＝`fail(status, message, code)` → `{ success:false, error, code }`
//     （逐字照 `./storyboard-voiceover/route.ts:61-64`）。
//   · 讀專案＝`readCanvasProject(caller.user.id, projectId)`＋找不到回 404
//     （逐字照 `./storyboard-voiceover/route.ts:164-171`）。
//
// ── 誠實邊界（不假成功）──────────────────────────────────────────────────
//   ① 集作用域：`readCanvasProject` 是**個人畫布**輪子；團隊畫布（`scope:"team"`）如實 404。
//   ② 卡實體：`listCharacterCards` 是名稱→id 解析與 `character_lock`/`scene_lock` 分流的唯一真源
//      （`character-card-store.ts:122`）。讀卡失敗時**如實退化成空清單**（不改口徑、不假成功，
//      該 block 的門自然 block）。
//   ③ 本地判定：門禁是純代碼（`shortdrama-domain/index.ts:411` 的 `storyboardQc`），**不發任何
//      生成呼叫**；回傳的 `gates`/`ready` 即門禁自身判定，不經上游、不受網路影響。

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
  // 回應形狀與同目錄既有路由逐字同源（`storyboard-voiceover/route.ts:61-64`）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 節點 → 21 欄分鏡（唯一真源 = `metadata.storyboardShot`；`shotNumber` 空者整包丟棄）。 */
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

  // episode 缺席＝全專案分鏡；給了就必須是 ≥1 的整數（＝CanvasEpisode.episodeNo）。
  const episodeRaw = body?.episode;
  if (episodeRaw !== undefined && episodeRaw !== null && (!Number.isInteger(episodeRaw) || (episodeRaw as number) < 1)) {
    return fail(400, "episode 必须是 ≥1 的整数（对应 CanvasEpisode.episodeNo）。", "invalid_payload");
  }
  const episode = episodeRaw === undefined || episodeRaw === null ? undefined : (episodeRaw as number);

  // llmSemantic：本路由不做語義層（需付費上游）；true 具名拒，**不發任何呼叫**。
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

  // ── 專案 → 目標分鏡（21 欄）──
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

  // 卡實體（名稱→id 解析 + character_lock/scene_lock 分流的唯一真源）。讀取失敗＝如實退化。
  let cards: CharacterCard[];
  try {
    cards = await listCharacterCards(caller.user.id);
  } catch (error) {
    console.error("[canvas] storyboard-qc list cards failed:", error);
    cards = [];
  }

  // ── 專案上下文 → 橋接欄位 → 門禁 args（`productionFieldsFromContext` 在 `storyboardQcGateArgs` 內）──
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(project, { cards });
  const args = storyboardQcGateArgs(shots, context);

  // ── 本地門禁判定（純代碼、零上游）──
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
      // 誠實回報：橋接層缺項（缺輸入 ≠ 門禁過了）與未解析卡 id。門禁自身判定在 `gates`。
      missing: args.missing,
      unresolvedCardIds,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}