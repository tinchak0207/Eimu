// POST /api/canvas/storyboard-voiceover —— 逐鏡配音（分鏡 → 台詞表 → 逐行既有 TTS → 回寫分鏡）。
//
// 結構修因（病歷 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s。缺的是
// 「逐鏡組台詞表」與「把結果寫回分鏡」這兩跳——本路由把站點服務層接成一條端點。
//
// body：`{ projectId: string; episode?: number; dryRun?: boolean }`
//   · `dryRun: true`  → **不發任何生成呼叫**，回行數／字數／預估幣（付費前的報備口徑）。
//   · `dryRun: false` → 逐行真 TTS → 整批成功才回寫雙音軌與錨；失敗整批拒寫、分鏡原樣。
//   · `dryRun` 缺席 ⇒ **視為 true**（安全預設：不經明確 opt-in 不花錢）。
//
// ── 照抄的既有範式（同目錄）────────────────────────────────────────────────
//   · 認證＝`requireVerifiedUser`（`./projects/route.ts:22`／`./nodes/restore/route.ts:21` 同款守衛）。
//   · 錯誤信封＝`fail(status, message, code)` → `{ success:false, error, code }`
//     （逐字照 `./video-frames/route.ts:27`）。成功回應用的是本端點凍結的 `ok` 形（見下）。
//   · 讀專案＝`readCanvasProject(caller.user.id, projectId)`＋找不到回 404
//     （逐字照 `./nodes/[id]/history/route.ts:29`）。落盤＝`mutateCanvasProject`
//     （逐字照 `./nodes/restore/route.ts:39`；只碰目標節點、走既有清洗白名單）。
//
// ── 誠實邊界（不假成功）──────────────────────────────────────────────────
//   ① **集作用域**：`readCanvasProject`/`mutateCanvasProject` 是**個人畫布**輪子（與同目錄
//      節點改動路由同一邊界）；團隊畫布（`scope:"team"`）不在本刀的檔界內，會如實 404。
//   ② **真跑需控制面**：逐行真 TTS 走站點既有生成管線（`submitGenerationCommand` kind=tts
//      ＋ job 輪詢＋產物 URL；與 `POST /api/v1/tts/generations` 的提交端、`GET /v1/tts/[id]`
//      的查詢端**同一條管線**）。控制面未配置（`GENERATION_CONTROL_PLANE_ENABLED` 未開或
//      無 DB）⇒ 503 具名拒，**不發任何生成呼叫**、不假成功。
//   ③ **時長**：站點側沒有 ffprobe（`music-tools.ts` 的 ffprobe 是 harness 沙箱工具；Next
//      服務端無 ffmpeg，見 `video-frames` 檔頭）⇒ 每行 `duration_ms` 一律 `null`，
//      由服務層如實帶進 `unmeasuredDurations`，**不估算冒充實測**。
//   ④ **時長上限**：逐行序列（禁並發）在 `maxDuration` 內跑；單行輪詢預算見常數，
//      行數很多時可能撞牆——撞牆即該行失敗、整批拒寫（不做半成品）。

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { usableAudioUrl } from "@/lib/agent-output-cards";
import { mutateCanvasProject, readCanvasProject } from "@/lib/canvas/project-store";
import {
  applyVoiceoverShotsToNodes,
  storyboardVoiceover,
  type StoryboardVoiceoverTtsClient,
} from "@/lib/canvas/storyboard-voiceover";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import {
  getGenerationJobForTenant,
  listCompletedGenerationArtifacts,
} from "@/lib/generation-core/job-repository";
import { resolveTaskCostCoins, taskStatus } from "@/lib/generation-core/task-response";
import { ttsQuotaForChars } from "@/lib/generation-model-catalog/tts-pricing";
import { TTS_1_MODEL_ID } from "@/lib/image-model-ids";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** 逐行真 TTS 的模型 id：與既有 `POST /api/v1/tts/generations` 的默認值同一字串（不另立）。 */
const VOICEOVER_TTS_MODEL_ID = TTS_1_MODEL_ID;
/** 單行任務的輪詢間隔與總預算（禁 retry＝只等待、不重送；逾時即該行失敗）。 */
const TTS_POLL_INTERVAL_MS = 2_000;
const TTS_POLL_BUDGET_MS = 60_000;

function fail(status: number, message: string, code: string): NextResponse {
  // 回應形狀與同目錄既有路由逐字同源（本目錄既有慣例）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 逐行 TTS client：走**站點既有生成管線**（不是新上游 client、不是 gateway）。
 *
 * 與 `POST /api/v1/tts/generations`（提交）＋ `GET /v1/tts/[id]`（查詢）同一條路：
 * `submitGenerationCommand`（kind tts、source web、租戶 `web:<userId>`、冪等鍵逐行）
 * → 輪詢 `getGenerationJobForTenant` → 成功取產物 `delivery_url`、花費 `resolveTaskCostCoins`。
 *
 * 紀律：**一次呼叫＝一次提交**（禁 retry、禁迴圈試探）；輪詢有界、不重送；
 * `duration_ms` 站點無真源 ⇒ 回 `null`（見路由檔頭 ③）。
 */
function createSiteTtsLineClient(options: {
  tenantId: string;
  billingUserId: number;
  projectId: string;
  runId: string;
}): StoryboardVoiceoverTtsClient {
  return async (line) => {
    try {
      const submitted = await submitGenerationCommand({
        tenantId: options.tenantId,
        billingUserId: options.billingUserId,
        source: "web",
        // 冪等鍵逐行、綁本次呼叫的 runId：同一次請求重送不重複建單；新的一次請求是新單。
        idempotencyKey: `canvas-voiceover:${options.runId}:${line.index}`,
        kind: "tts",
        modelId: VOICEOVER_TTS_MODEL_ID,
        prompt: line.text,
        workflow: {
          voice: line.voice,
          inputLength: line.text.length,
          canvas: { projectId: options.projectId, shotNumber: line.shotNumber, field: line.field },
        },
        responseFormat: "url",
        requestedCount: 1,
        // 逐字計價（0.001 幣/字，唯一真源＝generation-model-catalog/tts-pricing）：
        // 每行按**該行文本實際字數**推導帳本金額，與 /v1/tts/generations 同一條扣費路徑
        // （submitGenerationCommand → billing-ledger reserve；真 0 字才允許 0 額短路）。
        billingAmount: ttsQuotaForChars(line.text.length),
      });
      const jobId = submitted.job.id;

      const deadline = Date.now() + TTS_POLL_BUDGET_MS;
      for (;;) {
        const job = await getGenerationJobForTenant(jobId, options.tenantId);
        if (!job) return { audioUrl: null, error: `任务 ${jobId} 查不到（租户不符）。` };
        const status = taskStatus(job);
        if (status === "succeeded") {
          const artifacts = await listCompletedGenerationArtifacts(jobId);
          const artifactUrl = artifacts.map((artifact) => usableAudioUrl(artifact.url)).find((url) => !!url) ?? null;
          if (!artifactUrl) return { audioUrl: null, error: "任务成功但没有可用的音频产物 URL。" };
          const costCoins = await resolveTaskCostCoins(jobId).catch(() => null);
          return { audioUrl: artifactUrl, durationMs: null, costCoins };
        }
        if (status === "failed" || status === "cancelled" || status === "refunded" || status === "unknown") {
          const detail = job.failureDetail ? `：${job.failureDetail.slice(0, 200)}` : "";
          return { audioUrl: null, error: `任务终态 ${status}${detail}` };
        }
        if (Date.now() >= deadline) {
          return { audioUrl: null, error: `等待任务 ${jobId} 超时（${TTS_POLL_BUDGET_MS}ms）。` };
        }
        await sleep(TTS_POLL_INTERVAL_MS);
      }
    } catch (error) {
      return { audioUrl: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
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

  // dryRun 缺席 ⇒ true（安全預設：不經明確 opt-in 不發出任何生成呼叫）。
  if (body?.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return fail(400, "dryRun 必须是布尔值。", "invalid_payload");
  }
  const dryRun = body?.dryRun === undefined ? true : body.dryRun === true;

  let project;
  try {
    project = await readCanvasProject(caller.user.id, projectId);
  } catch (error) {
    console.error("[canvas] voiceover read project failed:", error);
    return fail(500, "读取画布失败，请稍后再试", "internal_error");
  }
  if (!project) return fail(404, "画布项目不存在", "project_not_found");

  // ── dryRun：不碰上游（付費前報備口徑；`ok` 恆 true，拒收原因放 `refused`）──
  //     真跑需控制面；未配置＝具名 503，**不發任何生成呼叫**。
  if (!dryRun && !generationControlPlaneEnabled()) {
    return fail(
      503,
      "站内 TTS 需要控制面（GENERATION_CONTROL_PLANE_ENABLED 未配置或缺少生成数据库）；本次未发出任何生成调用。",
      "tts_control_plane_unavailable",
    );
  }

  // dryRun 分支保證不呼叫 client（分派在服務層；這裡傳一個 tripwire 以示「本就不該被呼叫」）。
  const unusedClient: StoryboardVoiceoverTtsClient = async () => ({
    audioUrl: null,
    error: "dryRun 不应调用 TTS（内部错误）",
  });

  let outcome;
  try {
    outcome = await storyboardVoiceover(project, {
      dryRun,
      episode,
      client: dryRun
        ? unusedClient
        : createSiteTtsLineClient({
            tenantId: `web:${caller.user.id}`,
            billingUserId: caller.user.id,
            projectId,
            runId: randomUUID(),
          }),
    });
  } catch (error) {
    console.error("[canvas] voiceover failed:", error);
    return fail(502, "逐镜配音执行失败，请稍后再试。", "voiceover_failed");
  }

  if (outcome.kind === "dryRun") {
    const plan = outcome.plan;
    return NextResponse.json(
      {
        ok: true,
        dryRun: true,
        lines: plan.lines,
        totalChars: plan.totalChars,
        estimatedCoins: plan.estimatedCoins,
        ...(plan.refused ? { refused: plan.refused } : {}),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const execution = outcome.execution;
  const result = execution.result;
  if (!result.applied) {
    // 整批拒寫：分鏡原樣（服務層已保證未部分寫入）。409＝狀態衝突（回寫不可完成），
    // 但 body 仍帶完整拒收原因與（未執行的）行列資訊，供對帳。
    return NextResponse.json(
      {
        ok: result.ok,
        applied: result.applied,
        lines: result.lines,
        totalChars: result.totalChars,
        costCoins: result.costCoins,
        drift: result.drift,
        ...(result.refused ? { refused: result.refused } : {}),
        ...(result.unmeasuredDurations ? { unmeasuredDurations: result.unmeasuredDurations } : {}),
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  let wrote = false;
  try {
    const updated = await mutateCanvasProject(caller.user.id, projectId, (current) => {
      const merged = applyVoiceoverShotsToNodes(current.nodes, execution.entries, execution.shots);
      // 目標節點在讀取與落盤之間消失 ⇒ 整批不寫（不做部分寫入）。
      if (merged.missingNodeIds.length) return null;
      return { ...current, nodes: merged.nodes };
    });
    wrote = updated !== null;
  } catch (error) {
    console.error("[canvas] voiceover write-back failed:", error);
    return fail(500, "配音已生成但写回画布失败，请稍后再试。", "internal_error");
  }
  if (!wrote) {
    // 已生成但未落盤＝不可宣稱成功；如實回報（音檔已在帳本，重跑可復用同一路徑）。
    return fail(409, "写回时目标分镜节点已不存在（画布在本次执行期间被改动）；本次未写入任何音轨。", "write_conflict");
  }

  return NextResponse.json(
    {
      ok: result.ok,
      applied: result.applied,
      lines: result.lines,
      totalChars: result.totalChars,
      costCoins: result.costCoins,
      drift: result.drift,
      ...(result.refused ? { refused: result.refused } : {}),
      ...(result.unmeasuredDurations ? { unmeasuredDurations: result.unmeasuredDurations } : {}),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}