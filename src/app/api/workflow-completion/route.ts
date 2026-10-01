// POST /api/workflow-completion —— gateway 工作流「跑批完成」的推送接收端點。
//
// 為什麼需要這條端點：工作流跑到 success/partial 之前只活在 gateway 進程記憶體
// （WorkflowRunState 從不落盤），站點無從得知，歷史頁看不到任何「一次工作流跑完」
// 的痕跡。Phase 1 已在 gateway 加了 pushWorkflowCompletion（見
// deploy-staging/gateway/workflow-gw.ts:190），本 route 是它的站點側接收端。
//
// 流程：鑑權（Bearer，constant-time）→ 正規化 payload → 投影成 HistoryEntry →
// 非同步渲染 DAG 縮圖並上傳 Blob → 寫入歷史 → 202。
// 渲染失敗不阻塞歷史寫入（縮圖是錦上添花，記錄本身才是交付物）。
//
// ── 鑑權方案（本片決策，含理由）────────────────────────────────────────────
// 讀 `WORKFLOW_COMPLETION_KEY ?? HARNESS_API_KEY`，未配置任一 → 500（記 log）。
//
// 為什麼要 fallback 到 HARNESS_API_KEY：Phase 1 的 gateway 送的就是
// HARNESS_API_KEY（workflow-gw.ts:224），而 HARNESS_API_KEY 在 VPS 是 harness
// 打站點 /agent/v1/* 的通用 Bearer 憑據。不 fallback 的話，本端點在沒配
// WORKFLOW_COMPLETION_KEY 的環境會對 Phase 1 的推送回 401，整條鏈靜默斷掉。
//
// 為什麼仍以 WORKFLOW_COMPLETION_KEY 為主：這是**寫入**端點，HARNESS_API_KEY
// 是通用憑據（持有者可打任何 /agent/v1/*），讓一個通用 key 能寫入某個用戶的歷史
// 記錄是過寬的授權。專屬 key 是收窄路徑；fallback 只為相容 Phase 1 已在跑的事實。
//
// 為什麼不用 HMAC（memory-hmac 那套）：HMAC 需要 gateway 側同時改簽名邏輯，而
// Phase 1 已完工且驗收過、本片不改 gateway（越界）。Bearer + constant-time 比較
// 是既有端點（/v1/compile 用 B key Bearer）的同款範式。
//
// ── user 歸屬方案（本片最大的不確定性，如實說明）──────────────────────────
// gateway payload 只有 sessionId，**沒有任何 userId**，gateway 進程本身也不持有
// 用戶身份（sessions core 的 SessionState 只有 sessionId/apiKey/providerState；
// identity 由站點側 resolveAgentCaller 在代理層解析，見 agent-session-guard.ts）。
// 也就是說：**從 gateway payload 可靠解析出 «記錄該歸屬哪個用戶» 在現行資料形狀下
// 做不到**（站點側 process memory 沒有 sessionId→userId 表，gateway 也沒有；
// 任何「去 DB 反查」的路徑都不存在，gateway 零 DB）。
//
// 本片採取的方案：**顯式環境變數歸屬**。
//   env `WORKFLOW_COMPLETION_USER_ID` → 記錄歸該 userId；
//   未配置 → 400 + log，**不猜、不寫 0、不寫進任何人的歷史**。
//
// 為什麼是這個方案而不是「payload 加 user_id」：加欄位要改已驗收的 Phase 1
// gateway（越界）且 gateway 手上沒有這個值，得先讓站點把 userId 帶進建號請求並
// 由 gateway 存進 session（跨三檔的改動）。在「本片是站點側接收端」的邊界內，
// 正解是把「歸屬」顯式化為一項部署配置，而不是在站點側編一個 userId。
//
// 風險（誠實列出）：
//   1. 單一歸屬：此 env 只能指向一個用戶，多用戶場景下所有工作流記錄會落同一人。
//      這是「先讓鏈路通、再把身份帶上」的階段性取捨，不是最終形態。
//   2. 配錯 = 寫錯人：secret「配錯一個數字」寫進別人歷史，是本設計唯一的真實
//      風險。緩解＝未配置就 400（不會默認落到 0/1 號用戶），且後續要改成
//      gateway 帶 user_id（建議的正解，見回報）。
//   3. 冪等鍵不含 userId：記錄 id = `workflow-<workflowId>`，換 env 指向別的用戶
//      不會覆蓋舊記錄，新用戶會多出一條。可接受（不刪不改別人的記錄）。
//
// 附帶：鑑權用掉的那把 key 順便做 ownerKey 正典化（deriveMemoryOwnerKey）——它與
// gateway 注入記憶用的 ownerKey 同算法，讓「這條記錄是哪個 agent 身份跑出來的」
// 在歸屬不明時至少留下可對照的線索。這不參與寫入決策。

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
// sharp（DAG PNG）是原生模組，只能在 Node runtime；force-dynamic 因為這條端點
// 永遠帶 body、永遠要寫入，靜態化毫無意義且有快取風險。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// DAG 渲染（sharp）+ Blob 上傳留餘裕。回應本身不等渲染（fire-and-forget），
// 這個上限是給「同步等渲染」的部署形態兜底。
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** payload 上限：整張 DAG 的節點/連線 + 各節點 content，1MB 足夠且擋得住放大攻擊。 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** 期望的 Bearer key：專屬 key 優先，回退到 harness 通用 key（理由見檔頭）。 */
function expectedKey(): { key: string; source: "WORKFLOW_COMPLETION_KEY" | "HARNESS_API_KEY" | null } {
  const dedicated = process.env.WORKFLOW_COMPLETION_KEY?.trim();
  if (dedicated) return { key: dedicated, source: "WORKFLOW_COMPLETION_KEY" };
  const harness = process.env.HARNESS_API_KEY?.trim();
  if (harness) return { key: harness, source: "HARNESS_API_KEY" };
  return { key: "", source: null };
}

/**
 * constant-time Bearer 比較。
 * 長度不等先回 false（timingSafeEqual 對長度不等會拋錯，且長度本身不是秘密）；
 * 長度相等時用 timingSafeEqual 避免逐字元短路比較洩漏前綴。
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
 * 把這條跑批沉澱進個人記憶庫（含 Jev 值不值得存的閘門）。
 *
 * 為什麼在「歷史寫入成功之後」才做：記憶是歷史的衍生物，記錄都沒落地就寫記憶
 * 會出現「記憶裡有、歷史裡沒有」的鬼條目。
 *
 * 為什麼 config 要從節點反推：gateway payload 沒有單一 config 物件，參數攤在
 * 節點的 content（text 節點＝提示詞）與 metadata（config 節點＝model/size/count）
 * 上，見 extractWorkflowRunConfig 的說明。
 *
 * 閘門分工（契約 §5 同構）：
 *   - `shouldPersistWorkflow`＝機器判定「這條值不值得存」（prompt 非空且 ≥2 槽）；
 *   - Jev 只當閘門（值不值得），**內容一律機器抽取**，不讓 LLM 生成 body
 *     （避免每次寫入語義漂移、且 Jev 掛掉時仍有機器判定兜底）。
 *
 * 失敗只記 log：記憶是衍生物，寫不進去不能讓「歷史已落地」的回應變成失敗。
 */
async function persistWorkflowMemory(input: {
  authKey: string;
  templateId: string;
  workflowId: string;
  status: string;
  nodes: WorkflowRunPushPayload["nodes"];
  dagNodes: Parameters<typeof renderWorkflowDagPng>[0];
  dagConnections: Parameters<typeof renderWorkflowDagPng>[1];
  /** gateway 側 Jev 門結論；`false`＝不沉澱。缺省＝照機器判定走。 */
  jevVerdict?: boolean;
  /** gateway 算好的 ownerKey hash（該用戶的）。缺省＝回落舊推導路徑。 */
  ownerKeyHash?: string;
}): Promise<{ written: boolean; reason?: string }> {
  try {
    // Jev 門（在 gateway 側跑，這裡只消費結論）：Jev 明說不值得存 → 直接跳過，
    // 連 config 抽取都省了。缺省（undefined）＝舊版 gateway 或 Jev 掛掉（fail-open），
    // 落到下面的機器判定兜底。
    if (input.jevVerdict === false) {
      return { written: false, reason: "jev_rejected" };
    }
    const config = extractWorkflowRunConfig(input.nodes);
    if (!shouldPersistWorkflow(config)) {
      return { written: false, reason: "not_worth_persisting" };
    }
    const ownerKey = input.ownerKeyHash?.trim() || (await deriveMemoryOwnerKey(input.authKey));
    if (!ownerKey) return { written: false, reason: "no_owner_key" };

    // slug 必須合 /^[a-z0-9-]{1,64}$/（isStructurallyValid 硬規則）：templateId 是
    // snake_case（novel_film），底線不在白名單 → 一律轉連字號並截 64。
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
      // batchId 是記憶庫的去重/審計單位：用 workflowId 綁定，同一條工作流重推
      // 不會產生第二個批次。
      batchId: `workflow-${input.workflowId}`,
      docs: [
        {
          scope: "private",
          ownerKey,
          domain: "workflow",
          slug,
          // description 上限 120 字元（結構防線）：截斷而非拒絕，這條描述是
          // 給索引行看的，不是內容載體。
          description: `工作流 ${input.templateId}（${input.status}）的參數與節點結構`.slice(0, 120),
          type: "workflow",
          body: body.slice(0, WORKFLOW_MEMORY_BODY_MAX),
          evidence: `工作流跑批完成推送：workflowId=${input.workflowId} status=${input.status}`.slice(0, 200),
          evidenceKind: "tool_result",
          // selfScore 3＝中性（契約 G6：私有庫下限 3，低於此被閘門丟棄）。
          // 自動沉澱的內容不該自吹高分——分數是給品質翻轉用的訊號，不是裝飾。
          selfScore: 3,
        },
      ],
    });

    const accepted = result.accepted.length > 0;
    if (!accepted) {
      const reason = result.rejected[0]?.reason ?? "rejected";
      console.log(`[workflow-completion] 記憶未寫入（${reason}） slug=${slug} wf=${input.workflowId}`);
      return { written: false, reason };
    }
    console.log(`[workflow-completion] 記憶已寫入：slug=${slug} wf=${input.workflowId} body=${body.length}字`);
    return { written: true };
  } catch (error) {
    console.error("[workflow-completion] 記憶寫入失敗（不影響歷史）。", error);
    return { written: false, reason: "error" };
  }
}

/** 非同步渲染 DAG 縮圖並上傳 Blob；任何失敗回 null（呼叫端留空縮圖欄位）。 */
async function renderAndUploadDag(
  userId: number,
  entryId: string,
  nodes: Parameters<typeof renderWorkflowDagPng>[0],
  connections: Parameters<typeof renderWorkflowDagPng>[1],
): Promise<string | null> {
  try {
    const png = await renderWorkflowDagPng(nodes, connections);
    if (png.byteLength === 0) {
      console.error(`[workflow-completion] DAG 渲染回空 buffer，跳過縮圖 entry=${entryId}`);
      return null;
    }
    // 路徑命名沿用 server-history-store.imageBlobPath 的慣例（history/{userId}/img/
    // {entry}-{provider}.png 同樣吃到 sanitizeBlobSegment 的防穿越清洗）。
    const path = `history/${sanitizeBlobSegment(String(userId), "0")}/dag/${sanitizeBlobSegment(entryId, "entry")}.png`;
    const blob = await put(path, png, {
      access: "public",
      contentType: "image/png",
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    });
    return blob.url;
  } catch (error) {
    // 渲染失敗不阻塞歷史寫入：記錄先落地，縮圖是錦上添花。
    console.error("[workflow-completion] DAG 縮圖渲染/上傳失敗，記錄仍寫入。", error);
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { key, source } = expectedKey();
  if (!key) {
    // 寫入端點絕不放行無鑑權請求（fail-open 會讓任何人往任意用戶歷史寫入）。
    console.error("[workflow-completion] WORKFLOW_COMPLETION_KEY 與 HARNESS_API_KEY 皆未配置，拒絕所有請求。");
    return fail(500, "workflow completion endpoint not configured", "endpoint_not_configured");
  }
  if (!bearerMatches(req.headers.get("authorization"), key)) {
    return fail(401, "unauthorized", "unauthorized");
  }

  // 歸屬：顯式 env，未配置就拒（不猜、不默認，理由見檔頭）。
  const userIdRaw = process.env.WORKFLOW_COMPLETION_USER_ID?.trim() ?? "";
  const userId = Number(userIdRaw);
  if (!userIdRaw || !Number.isInteger(userId) || userId <= 0) {
    console.error("[workflow-completion] WORKFLOW_COMPLETION_USER_ID 未配置或非法，拒絕寫入（無法確定記錄歸屬）。");
    return fail(400, "workflow completion owner is not configured", "owner_not_configured");
  }

  // 取原始位元組先判體積，再解析：直接 req.json() 對超大 body 沒有前置防線。
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

  // 必要欄位寬鬆校驗：workflowId/templateId/status/nodes。缺 connections 視為空陣列。
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId.trim() : "";
  if (!workflowId) return fail(400, "missing workflowId", "invalid_payload");
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  if (status !== "success" && status !== "partial") {
    // 只接受真交付出去的終態：其餘狀態（running/failed/paused）推過來會讓站點
    // 把半成品當成品。gateway 側已按此過濾，這裡是第二道校驗。
    return fail(400, "status must be success or partial", "invalid_status");
  }
  if (!Array.isArray(payload.nodes)) return fail(400, "missing nodes", "invalid_payload");

  const entryId = workflowHistoryEntryId(workflowId);
  const completedAt = typeof payload.completedAt === "string" ? Date.parse(payload.completedAt) : Number.NaN;
  const generatedAt = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : Date.now();

  const { workflow, dagNodes, dagConnections } = projectWorkflowRunToHistory(payload);

  const workflowLabel = workflow.templateId?.trim() || workflowId;
  const nodeCount = dagNodes.length;
  const prompt = `工作流 ${workflowLabel}（${nodeCount} 節點）`;

  // DAG 縮圖：先渲染再寫歷史。刻意不是完全 fire-and-forget——若先寫記錄再補縮圖，
  // 得為了「把 URL 補回去」再讀一次索引、寫第二次（多一次整份索引的讀寫與競態）。
  // 而渲染失敗已被 catch 成 null，最壞情況只是這條記錄少一張縮圖，不影響回應語義。
  const dagThumbnailUrl = await renderAndUploadDag(userId, entryId, dagNodes, dagConnections);
  if (dagThumbnailUrl) workflow.dagThumbnailUrl = dagThumbnailUrl;

  // results 留空：工作流的最終產物在 DAG 各節點裡，把節點產物硬塞進 results 會讓
  // 歷史卡顯示成「一次生成出 N 張圖」。前端讀 workflow.dagNodes / dagThumbnailUrl。
  //
  // 冪等語義（先讀懂 saveGeneratedHistoryEntry 再調用）：它內部按 `item.id !==
  // normalized.id` 過濾後再前插，所以**同一個 id 重複推送只會留一條**——記錄 id
  // 由 workflowId 派生（workflowHistoryEntryId），gateway 重推或手動觸發
  // /internal/workflow/complete 都不會產生第二條。taskId 一併設成同值：它是
  // 跨源歸并鍵（historyEntryKey 優先取 taskId），設了才不會被模糊歸并吞掉。
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
    console.error("[workflow-completion] 歷史寫入失敗。", error);
    return fail(500, "failed to persist workflow history", "persist_failed");
  }

  // 記憶沉澱：歷史落地後才做（記憶是歷史的衍生物）。不 await 阻塞回應——
  // 寫記憶會多一次 blob 讀寫（索引重建）＋可選的 Jev 判定，讓 gateway 的
  // 5s 超時窗口去等它並不划算；失敗也只影響記憶庫，不影響已落地的歷史。
  // 用 vault 的 key 推 ownerKey：這把 key 是 gateway 跑批的身份，與注入記憶
  // 用的 ownerKey 同算法，讓這條記憶未來能被同一身份的 agent 召回到。
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
      console.log(`[workflow-completion] 記憶沉澱未寫入（${memory.reason ?? "unknown"}） wf=${workflowId}`);
    }
  });

  // 202：記錄已落地，縮圖是隨附的，缺了也算成功（用 dagThumbnailUrl 欄位表達）。
  return NextResponse.json(
    { ok: true, historyEntryId: entryId, ...(dagThumbnailUrl ? { dagThumbnailUrl } : {}), keySource: source },
    { status: 202 },
  );
}
