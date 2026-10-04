// POST /api/workflow-completion —— gateway 工作流「跑批完成」的推送接收端点。
//
// 为什么需要这条端点：工作流跑到 success/partial 之前只活在 gateway 进程记忆体
// （WorkflowRunState 从不落盘），站点无从得知，历史页看不到任何「一次工作流跑完」
// 的痕迹。Phase 1 已在 gateway 加了 pushWorkflowCompletion（见
// deploy-staging/gateway/workflow-gw.ts:190），本 route 是它的站点侧接收端。
//
// 流程：鉴权（Bearer，constant-time）→ 正规化 payload → 投影成 HistoryEntry →
// 非同步渲染 DAG 缩图并上传 Blob → 写入历史 → 202。
// 渲染失败不阻塞历史写入（缩图是锦上添花，记录本身才是交付物）。
//
// ── 鉴权方案（本片决策，含理由）────────────────────────────────────────────
// 读 `WORKFLOW_COMPLETION_KEY ?? HARNESS_API_KEY`，未配置任一 → 500（记 log）。
//
// 为什么要 fallback 到 HARNESS_API_KEY：Phase 1 的 gateway 送的就是
// HARNESS_API_KEY（workflow-gw.ts:224），而 HARNESS_API_KEY 在 VPS 是 harness
// 打站点 /agent/v1/* 的通用 Bearer 凭据。不 fallback 的话，本端点在没配
// WORKFLOW_COMPLETION_KEY 的环境会对 Phase 1 的推送回 401，整条链静默断掉。
//
// 为什么仍以 WORKFLOW_COMPLETION_KEY 为主：这是**写入**端点，HARNESS_API_KEY
// 是通用凭据（持有者可打任何 /agent/v1/*），让一个通用 key 能写入某个用户的历史
// 记录是过宽的授权。专属 key 是收窄路径；fallback 只为相容 Phase 1 已在跑的事实。
//
// 为什么不用 HMAC（memory-hmac 那套）：HMAC 需要 gateway 侧同时改签名逻辑，而
// Phase 1 已完工且验收过、本片不改 gateway（越界）。Bearer + constant-time 比较
// 是既有端点（/v1/compile 用 B key Bearer）的同款范式。
//
// ── user 归属方案（本片最大的不确定性，如实说明）──────────────────────────
// gateway payload 只有 sessionId，**没有任何 userId**，gateway 进程本身也不持有
// 用户身份（sessions core 的 SessionState 只有 sessionId/apiKey/providerState；
// identity 由站点侧 resolveAgentCaller 在代理层解析，见 agent-session-guard.ts）。
// 也就是说：**从 gateway payload 可靠解析出 «记录该归属哪个用户» 在现行资料形状下
// 做不到**（站点侧 process memory 没有 sessionId→userId 表，gateway 也没有；
// 任何「去 DB 反查」的路径都不存在，gateway 零 DB）。
//
// 本片采取的方案：**显式环境变数归属**。
//   env `WORKFLOW_COMPLETION_USER_ID` → 记录归该 userId；
//   未配置 → 400 + log，**不猜、不写 0、不写进任何人的历史**。
//
// 为什么是这个方案而不是「payload 加 user_id」：加栏位要改已验收的 Phase 1
// gateway（越界）且 gateway 手上没有这个值，得先让站点把 userId 带进建号请求并
// 由 gateway 存进 session（跨三档的改动）。在「本片是站点侧接收端」的边界内，
// 正解是把「归属」显式化为一项部署配置，而不是在站点侧编一个 userId。
//
// 风险（诚实列出）：
//   1. 单一归属：此 env 只能指向一个用户，多用户场景下所有工作流记录会落同一人。
//      这是「先让链路通、再把身份带上」的阶段性取舍，不是最终形态。
//   2. 配错 = 写错人：secret「配错一个数字」写进别人历史，是本设计唯一的真实
//      风险。缓解＝未配置就 400（不会默认落到 0/1 号用户），且后续要改成
//      gateway 带 user_id（建议的正解，见回报）。
//   3. 幂等键不含 userId：记录 id = `workflow-<workflowId>`，换 env 指向别的用户
//      不会覆盖旧记录，新用户会多出一条。可接受（不删不改别人的记录）。
//
// 附带：鉴权用掉的那把 key 顺便做 ownerKey 正典化（deriveMemoryOwnerKey）——它与
// gateway 注入记忆用的 ownerKey 同算法，让「这条记录是哪个 agent 身份跑出来的」
// 在归属不明时至少留下可对照的线索。这不参与写入决策。

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { renderWorkflowDagPng } from "@/lib/dag-png-server";
import { put } from "@/lib/blob-backend";
import { saveGeneratedHistoryEntry } from "@/lib/server-history-store";
import { sanitizeBlobSegment } from "@/lib/history-types";
import { ingestMemoryDocs } from "@/lib/agent-memory-store";
import { deriveMemoryOwnerKey } from "@/lib/agent-memory-injection";
import { extractWorkflowMemoryBody, shouldPersistWorkflow, WORKFLOW_MEMORY_BODY_MAX } from "@/lib/workflow-memory";
import {
  extractWorkflowRunConfig,
  projectWorkflowRunToHistory,
  workflowHistoryEntryId,
  type WorkflowRunPushPayload,
} from "@/lib/generation-workflow";
// sharp（DAG PNG）是原生模组，只能在 Node runtime；force-dynamic 因为这条端点
// 永远带 body、永远要写入，静态化毫无意义且有快取风险。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// DAG 渲染（sharp）+ Blob 上传留余裕。回应本身不等渲染（fire-and-forget），
// 这个上限是给「同步等渲染」的部署形态兜底。
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** payload 上限：整张 DAG 的节点/连线 + 各节点 content，1MB 足够且挡得住放大攻击。 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** 期望的 Bearer key：专属 key 优先，回退到 harness 通用 key（理由见档头）。 */
function expectedKey(): { key: string; source: "WORKFLOW_COMPLETION_KEY" | "HARNESS_API_KEY" | null } {
  const dedicated = process.env.WORKFLOW_COMPLETION_KEY?.trim();
  if (dedicated) return { key: dedicated, source: "WORKFLOW_COMPLETION_KEY" };
  const harness = process.env.HARNESS_API_KEY?.trim();
  if (harness) return { key: harness, source: "HARNESS_API_KEY" };
  return { key: "", source: null };
}

/**
 * constant-time Bearer 比较。
 * 长度不等先回 false（timingSafeEqual 对长度不等会抛错，且长度本身不是秘密）；
 * 长度相等时用 timingSafeEqual 避免逐字元短路比较泄漏前缀。
 */
function bearerMatches(header: string | null, expected: string): boolean {
  const raw = header?.trim() ?? "";
  const prefix = "bearer ";
  if (!raw.toLowerCase().startsWith(prefix)) return false;
  const received = Buffer.from(raw.slice(prefix.length).trim(), "utf8");
  const want = Buffer.from(expected, "utf8");
  return received.length === want.length && timingSafeEqual(received, want);
}

/**
 * 把这条跑批沉淀进个人记忆库（含 Jev 值不值得存的闸门）。
 *
 * 为什么在「历史写入成功之后」才做：记忆是历史的衍生物，记录都没落地就写记忆
 * 会出现「记忆里有、历史里没有」的鬼条目。
 *
 * 为什么 config 要从节点反推：gateway payload 没有单一 config 物件，参数摊在
 * 节点的 content（text 节点＝提示词）与 metadata（config 节点＝model/size/count）
 * 上，见 extractWorkflowRunConfig 的说明。
 *
 * 闸门分工（契约 §5 同构）：
 *   - `shouldPersistWorkflow`＝机器判定「这条值不值得存」（prompt 非空且 ≥2 槽）；
 *   - Jev 只当闸门（值不值得），**内容一律机器抽取**，不让 LLM 生成 body
 *     （避免每次写入语义漂移、且 Jev 挂掉时仍有机器判定兜底）。
 *
 * 失败只记 log：记忆是衍生物，写不进去不能让「历史已落地」的回应变成失败。
 */
async function persistWorkflowMemory(input: {
  authKey: string;
  templateId: string;
  workflowId: string;
  status: string;
  nodes: WorkflowRunPushPayload["nodes"];
  dagNodes: Parameters<typeof renderWorkflowDagPng>[0];
  dagConnections: Parameters<typeof renderWorkflowDagPng>[1];
  /** gateway 侧 Jev 门结论；`false`＝不沉淀。缺省＝照机器判定走。 */
  jevVerdict?: boolean;
  /** gateway 算好的 ownerKey hash（该用户的）。缺省＝回落旧推导路径。 */
  ownerKeyHash?: string;
}): Promise<{ written: boolean; reason?: string }> {
  try {
    // Jev 门（在 gateway 侧跑，这里只消费结论）：Jev 明说不值得存 → 直接跳过，
    // 连 config 抽取都省了。缺省（undefined）＝旧版 gateway 或 Jev 挂掉（fail-open），
    // 落到下面的机器判定兜底。
    if (input.jevVerdict === false) {
      return { written: false, reason: "jev_rejected" };
    }
    const config = extractWorkflowRunConfig(input.nodes);
    if (!shouldPersistWorkflow(config)) {
      return { written: false, reason: "not_worth_persisting" };
    }
    const ownerKey = input.ownerKeyHash?.trim() || (await deriveMemoryOwnerKey(input.authKey));
    if (!ownerKey) return { written: false, reason: "no_owner_key" };

    // slug 必须合 /^[a-z0-9-]{1,64}$/（isStructurallyValid 硬规则）：templateId 是
    // snake_case（novel_film），底线不在白名单 → 一律转连字号并截 64。
    const slug = input.templateId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!slug) return { written: false, reason: "invalid_slug" };

    const body = extractWorkflowMemoryBody({
      name: input.templateId,
      config,
      dagNodes: input.dagNodes,
      dagConnections: input.dagConnections,
    });

    const result = await ingestMemoryDocs({
      // batchId 是记忆库的去重/审计单位：用 workflowId 绑定，同一条工作流重推
      // 不会产生第二个批次。
      batchId: `workflow-${input.workflowId}`,
      docs: [
        {
          scope: "private",
          ownerKey,
          domain: "workflow",
          slug,
          // description 上限 120 字元（结构防线）：截断而非拒绝，这条描述是
          // 给索引行看的，不是内容载体。
          description: `工作流 ${input.templateId}（${input.status}）的参数与节点结构`.slice(0, 120),
          type: "workflow",
          body: body.slice(0, WORKFLOW_MEMORY_BODY_MAX),
          evidence: `工作流跑批完成推送：workflowId=${input.workflowId} status=${input.status}`.slice(0, 200),
          evidenceKind: "tool_result",
          // selfScore 3＝中性（契约 G6：私有库下限 3，低于此被闸门丢弃）。
          // 自动沉淀的内容不该自吹高分——分数是给品质翻转用的讯号，不是装饰。
          selfScore: 3,
        },
      ],
    });

    const accepted = result.accepted.length > 0;
    if (!accepted) {
      const reason = result.rejected[0]?.reason ?? "rejected";
      console.log(`[workflow-completion] 记忆未写入（${reason}） slug=${slug} wf=${input.workflowId}`);
      return { written: false, reason };
    }
    console.log(`[workflow-completion] 记忆已写入：slug=${slug} wf=${input.workflowId} body=${body.length}字`);
    return { written: true };
  } catch (error) {
    console.error("[workflow-completion] 记忆写入失败（不影响历史）。", error);
    return { written: false, reason: "error" };
  }
}

/** 非同步渲染 DAG 缩图并上传 Blob；任何失败回 null（呼叫端留空缩图栏位）。 */
async function renderAndUploadDag(
  userId: number,
  entryId: string,
  nodes: Parameters<typeof renderWorkflowDagPng>[0],
  connections: Parameters<typeof renderWorkflowDagPng>[1],
): Promise<string | null> {
  try {
    const png = await renderWorkflowDagPng(nodes, connections);
    if (png.byteLength === 0) {
      console.error(`[workflow-completion] DAG 渲染回空 buffer，跳过缩图 entry=${entryId}`);
      return null;
    }
    // 路径命名沿用 server-history-store.imageBlobPath 的惯例（history/{userId}/img/
    // {entry}-{provider}.png 同样吃到 sanitizeBlobSegment 的防穿越清洗）。
    const path = `history/${sanitizeBlobSegment(String(userId), "0")}/dag/${sanitizeBlobSegment(entryId, "entry")}.png`;
    const blob = await put(path, png, {
      access: "public",
      contentType: "image/png",
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    });
    return blob.url;
  } catch (error) {
    // 渲染失败不阻塞历史写入：记录先落地，缩图是锦上添花。
    console.error("[workflow-completion] DAG 缩图渲染/上传失败，记录仍写入。", error);
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { key, source } = expectedKey();
  if (!key) {
    // 写入端点绝不放行无鉴权请求（fail-open 会让任何人往任意用户历史写入）。
    console.error("[workflow-completion] WORKFLOW_COMPLETION_KEY 与 HARNESS_API_KEY 皆未配置，拒绝所有请求。");
    return fail(500, "workflow completion endpoint not configured", "endpoint_not_configured");
  }
  if (!bearerMatches(req.headers.get("authorization"), key)) {
    return fail(401, "unauthorized", "unauthorized");
  }

  // 归属：显式 env，未配置就拒（不猜、不默认，理由见档头）。
  const userIdRaw = process.env.WORKFLOW_COMPLETION_USER_ID?.trim() ?? "";
  const userId = Number(userIdRaw);
  if (!userIdRaw || !Number.isInteger(userId) || userId <= 0) {
    console.error("[workflow-completion] WORKFLOW_COMPLETION_USER_ID 未配置或非法，拒绝写入（无法确定记录归属）。");
    return fail(400, "workflow completion owner is not configured", "owner_not_configured");
  }

  // 取原始位元组先判体积，再解析：直接 req.json() 对超大 body 没有前置防线。
  const raw = await req.arrayBuffer();
  if (raw.byteLength === 0) return fail(400, "empty body", "invalid_payload");
  if (raw.byteLength > MAX_PAYLOAD_BYTES) {
    return fail(413, "payload too large", "payload_too_large");
  }

  let payload: WorkflowRunPushPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as WorkflowRunPushPayload;
  } catch {
    return fail(400, "request body must be JSON", "invalid_json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fail(400, "request body must be an object", "invalid_payload");
  }

  // 必要栏位宽松校验：workflowId/templateId/status/nodes。缺 connections 视为空阵列。
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId.trim() : "";
  if (!workflowId) return fail(400, "missing workflowId", "invalid_payload");
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  if (status !== "success" && status !== "partial") {
    // 只接受真交付出去的终态：其余状态（running/failed/paused）推过来会让站点
    // 把半成品当成品。gateway 侧已按此过滤，这里是第二道校验。
    return fail(400, "status must be success or partial", "invalid_status");
  }
  if (!Array.isArray(payload.nodes)) return fail(400, "missing nodes", "invalid_payload");

  const entryId = workflowHistoryEntryId(workflowId);
  const completedAt = typeof payload.completedAt === "string" ? Date.parse(payload.completedAt) : Number.NaN;
  const generatedAt = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : Date.now();

  const { workflow, dagNodes, dagConnections } = projectWorkflowRunToHistory(payload);

  const workflowLabel = workflow.templateId?.trim() || workflowId;
  const nodeCount = dagNodes.length;
  const prompt = `工作流 ${workflowLabel}（${nodeCount} 节点）`;

  // DAG 缩图：先渲染再写历史。刻意不是完全 fire-and-forget——若先写记录再补缩图，
  // 得为了「把 URL 补回去」再读一次索引、写第二次（多一次整份索引的读写与竞态）。
  // 而渲染失败已被 catch 成 null，最坏情况只是这条记录少一张缩图，不影响回应语义。
  const dagThumbnailUrl = await renderAndUploadDag(userId, entryId, dagNodes, dagConnections);
  if (dagThumbnailUrl) workflow.dagThumbnailUrl = dagThumbnailUrl;

  // results 留空：工作流的最终产物在 DAG 各节点里，把节点产物硬塞进 results 会让
  // 历史卡显示成「一次生成出 N 张图」。前端读 workflow.dagNodes / dagThumbnailUrl。
  //
  // 幂等语义（先读懂 saveGeneratedHistoryEntry 再调用）：它内部按 `item.id !==
  // normalized.id` 过滤后再前插，所以**同一个 id 重复推送只会留一条**——记录 id
  // 由 workflowId 派生（workflowHistoryEntryId），gateway 重推或手动触发
  // /internal/workflow/complete 都不会产生第二条。taskId 一并设成同值：它是
  // 跨源归并键（historyEntryKey 优先取 taskId），设了才不会被模糊归并吞掉。
  try {
    await saveGeneratedHistoryEntry({
      id: entryId,
      userId,
      prompt,
      generatedAt,
      results: [],
      entryKind: "workflow",
      workflow,
      taskId: entryId,
    });
  } catch (error) {
    console.error("[workflow-completion] 历史写入失败。", error);
    return fail(500, "failed to persist workflow history", "persist_failed");
  }

  // 记忆沉淀：历史落地后才做（记忆是历史的衍生物）。不 await 阻塞回应——
  // 写记忆会多一次 blob 读写（索引重建）＋可选的 Jev 判定，让 gateway 的
  // 5s 超时窗口去等它并不划算；失败也只影响记忆库，不影响已落地的历史。
  // 用 vault 的 key 推 ownerKey：这把 key 是 gateway 跑批的身份，与注入记忆
  // 用的 ownerKey 同算法，让这条记忆未来能被同一身份的 agent 召回到。
  void persistWorkflowMemory({
    authKey: key,
    templateId: workflow.templateId?.trim() || workflowId,
    workflowId,
    status,
    nodes: payload.nodes,
    dagNodes,
    dagConnections,
    jevVerdict:
      typeof payload.memoryWorthPersisting === "boolean" ? payload.memoryWorthPersisting : undefined,
    ownerKeyHash: payload.memoryOwnerKeyHash,
  }).then((memory) => {
    if (!memory.written) {
      console.log(`[workflow-completion] 记忆沉淀未写入（${memory.reason ?? "unknown"}） wf=${workflowId}`);
    }
  });

  // 202：记录已落地，缩图是随附的，缺了也算成功（用 dagThumbnailUrl 栏位表达）。
  return NextResponse.json(
    { ok: true, historyEntryId: entryId, ...(dagThumbnailUrl ? { dagThumbnailUrl } : {}), keySource: source },
    { status: 202 },
  );
}
