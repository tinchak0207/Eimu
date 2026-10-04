// POST /api/canvas/storyboard-voiceover —— 逐镜配音（分镜 → 台词表 → 逐行既有 TTS → 回写分镜）。
//
// 结构修因（病历 `tts-multiline-narration-p2-bug`）：60s 片旁白只合成一段 25s。缺的是
// 「逐镜组台词表」与「把结果写回分镜」这两跳——本路由把站点服务层接成一条端点。
//
// body：`{ projectId: string; episode?: number; dryRun?: boolean }`
//   · `dryRun: true`  → **不发任何生成呼叫**，回行数／字数／预估币（付费前的报备口径）。
//   · `dryRun: false` → 逐行真 TTS → 整批成功才回写双音轨与锚；失败整批拒写、分镜原样。
//   · `dryRun` 缺席 ⇒ **视为 true**（安全预设：不经明确 opt-in 不花钱）。
//
// ── 照抄的既有范式（同目录）────────────────────────────────────────────────
//   · 认证＝`requireVerifiedUser`（`./projects/route.ts:22`／`./nodes/restore/route.ts:21` 同款守卫）。
//   · 错误信封＝`fail(status, message, code)` → `{ success:false, error, code }`
//     （逐字照 `./video-frames/route.ts:27`）。成功回应用的是本端点冻结的 `ok` 形（见下）。
//   · 读专案＝`readCanvasProject(caller.user.id, projectId)`＋找不到回 404
//     （逐字照 `./nodes/[id]/history/route.ts:29`）。落盘＝`mutateCanvasProject`
//     （逐字照 `./nodes/restore/route.ts:39`；只碰目标节点、走既有清洗白名单）。
//
// ── 诚实边界（不假成功）──────────────────────────────────────────────────
//   ① **集作用域**：`readCanvasProject`/`mutateCanvasProject` 是**个人画布**轮子（与同目录
//      节点改动路由同一边界）；团队画布（`scope:"team"`）不在本刀的档界内，会如实 404。
//   ② **真跑需控制面**：逐行真 TTS 走站点既有生成管线（`submitGenerationCommand` kind=tts
//      ＋ job 轮询＋产物 URL；与 `POST /api/v1/tts/generations` 的提交端、`GET /v1/tts/[id]`
//      的查询端**同一条管线**）。控制面未配置（`GENERATION_CONTROL_PLANE_ENABLED` 未开或
//      无 DB）⇒ 503 具名拒，**不发任何生成呼叫**、不假成功。
//   ③ **时长**：站点侧没有 ffprobe（`music-tools.ts` 的 ffprobe 是 harness 沙箱工具；Next
//      服务端无 ffmpeg，见 `video-frames` 档头）⇒ 每行 `duration_ms` 一律 `null`，
//      由服务层如实带进 `unmeasuredDurations`，**不估算冒充实测**。
//   ④ **时长上限**：逐行序列（禁并发）在 `maxDuration` 内跑；单行轮询预算见常数，
//      行数很多时可能撞墙——撞墙即该行失败、整批拒写（不做半成品）。

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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 逐行真 TTS 的模型 id：与既有 `POST /api/v1/tts/generations` 的默认值同一字串（不另立）。 */
const VOICEOVER_TTS_MODEL_ID = TTS_1_MODEL_ID;
/** 单行任务的轮询间隔与总预算（禁 retry＝只等待、不重送；逾时即该行失败）。 */
const TTS_POLL_INTERVAL_MS = 2_000;
const TTS_POLL_BUDGET_MS = 60_000;

function fail(status: number, message: string, code: string): NextResponse {
  // 回应形状与同目录既有路由逐字同源（本目录既有惯例）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 逐行 TTS client：走**站点既有生成管线**（不是新上游 client、不是 gateway）。
 *
 * 与 `POST /api/v1/tts/generations`（提交）＋ `GET /v1/tts/[id]`（查询）同一条路：
 * `submitGenerationCommand`（kind tts、source web、租户 `web:<userId>`、幂等键逐行）
 * → 轮询 `getGenerationJobForTenant` → 成功取产物 `delivery_url`、花费 `resolveTaskCostCoins`。
 *
 * 纪律：**一次呼叫＝一次提交**（禁 retry、禁回圈试探）；轮询有界、不重送；
 * `duration_ms` 站点无真源 ⇒ 回 `null`（见路由档头 ③）。
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
        // 幂等键逐行、绑本次呼叫的 runId：同一次请求重送不重复建单；新的一次请求是新单。
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
        // 逐字计价（0.001 币/字，唯一真源＝generation-model-catalog/tts-pricing）：
        // 每行按**该行文本实际字数**推导帐本金额，与 /v1/tts/generations 同一条扣费路径
        // （submitGenerationCommand → billing-ledger reserve；真 0 字才允许 0 额短路）。
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

  // episode 缺席＝全专案分镜；给了就必须是 ≥1 的整数（＝CanvasEpisode.episodeNo）。
  const episodeRaw = body?.episode;
  if (episodeRaw !== undefined && episodeRaw !== null && (!Number.isInteger(episodeRaw) || (episodeRaw as number) < 1)) {
    return fail(400, "episode 必须是 ≥1 的整数（对应 CanvasEpisode.episodeNo）。", "invalid_payload");
  }
  const episode = episodeRaw === undefined || episodeRaw === null ? undefined : (episodeRaw as number);

  // dryRun 缺席 ⇒ true（安全预设：不经明确 opt-in 不发出任何生成呼叫）。
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

  // ── dryRun：不碰上游（付费前报备口径；`ok` 恒 true，拒收原因放 `refused`）──
  //     真跑需控制面；未配置＝具名 503，**不发任何生成呼叫**。
  if (!dryRun && !generationControlPlaneEnabled()) {
    return fail(
      503,
      "站内 TTS 需要控制面（GENERATION_CONTROL_PLANE_ENABLED 未配置或缺少生成数据库）；本次未发出任何生成调用。",
      "tts_control_plane_unavailable",
    );
  }

  // dryRun 分支保证不呼叫 client（分派在服务层；这里传一个 tripwire 以示「本就不该被呼叫」）。
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
    // 整批拒写：分镜原样（服务层已保证未部分写入）。409＝状态冲突（回写不可完成），
    // 但 body 仍带完整拒收原因与（未执行的）行列资讯，供对帐。
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
      // 目标节点在读取与落盘之间消失 ⇒ 整批不写（不做部分写入）。
      if (merged.missingNodeIds.length) return null;
      return { ...current, nodes: merged.nodes };
    });
    wrote = updated !== null;
  } catch (error) {
    console.error("[canvas] voiceover write-back failed:", error);
    return fail(500, "配音已生成但写回画布失败，请稍后再试。", "internal_error");
  }
  if (!wrote) {
    // 已生成但未落盘＝不可宣称成功；如实回报（音档已在帐本，重跑可复用同一路径）。
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