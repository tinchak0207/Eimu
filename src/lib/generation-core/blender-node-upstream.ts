/**
 * blender_bridge 適配層：supplier 派發 → blender-bridge /v1/execute（片AA，2026-09-06）。
 *
 * 職責（片Y staging 稿 §B-3）：modelId→engine 選型、單幀渲染腳本構造（復用
 * blender-tools.ts buildChunkRenderScript 存活配方——samples=1＋RT off，片F/片M 實錘）、
 * POST {supplier.baseUrl}/v1/execute、bridge 產物收斂成 SupplierGenerationOutput。
 * 上層（分揀/入庫/對帳）不感知節點差異（NODES-PLAN §3.5）。
 *
 * 契約真源：bridge/blender-bridge/README.md
 *   POST /v1/execute {script, timeout_ms} →
 *     200 {ok:true, artifacts:[{path,bytes,kind}], scene_summary, stdout_tail, duration_ms, queued, queue_position}
 *     500 {ok:false, error, stdout_tail} ／ 429 {ok:false, error:"queue_full"}
 *
 * 同步 adapter 鐵律（片Y §3.6）：請求-回應內完成渲染，無異步 task_id 語義——
 * worker-service protocolOfAdapter 不加映射、不進 provider-reconciliation（L345 的
 * protocol 標記只在 onProviderTaskSubmitted 回調觸發，本 adapter 永不調用）；429/
 * 連線抖動＝瞬態交 worker 既有重試（片K 契約）；deadline 由橋 timeout_ms＋worker
 * 雙層超時覆蓋。
 *
 * 產物回收（本機節點形態，片Y §3.5「回 path→本函數收斂」）：bridge artifacts 的
 * path 是相對 $BLENDER_WORK/out/ 的快照 diff 相對路徑（server.py scan_artifacts
 * os.path.relpath）。本機節點與 worker 同機 → 經 /v1/health 的 workdir 解析絕對
 * 路徑磁碟直讀首張 png → base64（上層 validateImageBuffer/Blob 通道零改動）。
 * 遠端節點（Modal，片X）回 bytes 的內嵌收斂歸片X 落位；png 缺席時保留 blend/glb
 * 站內路徑（/api/blender-artifact 既有讀取通道）。
 *
 * 錯誤鐵律：絕不拋原始 fetch 錯誤，一律包成 SupplierRequestError（429→rate_limited
 * 瞬態重試、5xx/連線→瞬態、橋結構化 500 的 error＋stdout_tail 原文透傳不吞）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildChunkRenderScript } from "../blender-tools";
import { SupplierRequestError } from "./failure-classifier";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

/** blender-render-eevee / blender-render-cycles → bridge 腳本 engine 名（片Y §B-3）。 */
export function blenderNodeEngine(modelId: string): "eevee" | "cycles" {
  if (modelId === "blender-render-cycles") return "cycles";
  if (modelId === "blender-render-eevee") return "eevee";
  throw new SupplierRequestError(`Blender node adapter does not serve model ${modelId}.`, 400);
}

/** 產物分揀（kind/path/bytes 形＝blender-delegate.ts BlenderArtifact 同款）。 */
interface BridgeArtifact {
  path: string;
  bytes: number;
  kind: string;
}

interface BridgeExecuteSuccess {
  ok: true;
  artifacts: BridgeArtifact[];
  scene_summary: string;
  stdout_tail: string;
  duration_ms: number;
  queued?: boolean;
  queue_position?: number;
}

interface BridgeHealth {
  ok: boolean;
  blender_version?: string;
  gpu?: "egl" | "cpu";
  workdir?: string;
  queue_depth?: number;
  concurrency?: number;
}

/** 橋自有 timeout 判定先行、客戶端其後＋寬限才中止（blender-tools.ts 同款口徑）。 */
const CLIENT_ABORT_GRACE_MS = 10_000;

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  return value.trim();
}

function isArtifact(a: unknown): a is BridgeArtifact {
  return (
    !!a &&
    typeof a === "object" &&
    typeof (a as BridgeArtifact).path === "string" &&
    (a as BridgeArtifact).path !== "" &&
    typeof (a as BridgeArtifact).kind === "string"
  );
}

/**
 * 單幀渲染腳本（存活配方真源 blender-tools.ts buildChunkRenderScript，零複本）：
 * chunkStart=null ＝ 渲染當前幀單張 still（單幀 job 安全單位，片L 實錘橋內多幀必
 * native 崩）；eevee 檔自動套 samples=1＋RT off 存活預設；sceneBlendPath 缺省渲
 * 染橋當前場景（factory-startup），由 job workflow.metadata.scene_blend_path 指定。
 */
export function buildBlenderNodeFrameScript(input: { modelId: string; sceneBlendPath?: string; outputDirName: string }): string {
  return buildChunkRenderScript({
    sceneBlendPath: input.sceneBlendPath,
    engine: blenderNodeEngine(input.modelId),
    turntable: false,
    chunkStart: null,
    chunkEnd: 0,
    fullStart: 0,
    fullEnd: 0,
    outputDirName: input.outputDirName,
  });
}

/** 橋 fetch 包裝：TimeoutError→408、連線失敗→503（SupplierRequestError 語義分類）。 */
async function bridgeFetch(supplier: SupplierRecord, pathName: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${cleanBaseUrl(supplier.baseUrl)}${pathName}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${readCredential(supplier)}` },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("Supplier request timed out.", 408);
    }
    throw new SupplierRequestError(
      `Blender bridge unreachable (${(error as Error)?.message ?? String(error)}).`,
      503,
    );
  }
  clearTimeout(timer);
  return response;
}

/**
 * GET /v1/health：fail-fast 橋不可達＋取 workdir（產物相對路徑根；blenderRenderTool
 * bridgeHealth 同構——health workdir 是唯一權威，不假設 process.cwd()）。
 */
async function bridgeHealth(supplier: SupplierRecord): Promise<BridgeHealth & { workdir: string }> {
  const response = await bridgeFetch(supplier, "/v1/health", { method: "GET" }, 10_000);
  const body = (await response.json().catch(() => null)) as BridgeHealth | null;
  if (!response.ok || !body || body.ok !== true || typeof body.workdir !== "string" || body.workdir === "") {
    throw new SupplierRequestError(
      `Blender bridge /v1/health response unexpected (HTTP ${response.status}${body?.ok === false ? `, error: ${String(body && (body as { error?: string }).error)}` : ""}).`,
      502,
    );
  }
  return body as BridgeHealth & { workdir: string };
}

/**
 * POST /v1/execute 同步調用。瞬態（429 queue_full／連線抖動）以 SupplierRequestError
 * 拋出交 worker 重試；橋結構化 500（error＋stdout_tail）原文透傳不吞。
 */
async function bridgeExecute(supplier: SupplierRecord, script: string, timeoutMs: number): Promise<BridgeExecuteSuccess> {
  const response = await bridgeFetch(supplier, "/v1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, timeout_ms: timeoutMs }),
  }, timeoutMs + CLIENT_ABORT_GRACE_MS);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const errorText = typeof body?.error === "string" && body.error ? body.error : `HTTP ${response.status}`;
    throw new SupplierRequestError(
      `Blender bridge execute failed: ${errorText}`,
      response.status,
      response.headers.get("retry-after"),
      typeof body?.stdout_tail === "string" ? body.stdout_tail.slice(0, 1000) : undefined,
    );
  }
  if (!body || body.ok !== true || !Array.isArray(body.artifacts)) {
    throw new SupplierRequestError(
      `Blender bridge response shape unexpected (HTTP ${response.status} but missing ok:true success body).`,
      502,
    );
  }
  return body as unknown as BridgeExecuteSuccess;
}

/** 產物 → base64：workdir/out 相對路徑解析＋traversal 守衛（只認橋工作目錄內檔案）。 */
async function readArtifactBase64(supplier: SupplierRecord, workdir: string, artifact: BridgeArtifact): Promise<string> {
  const outRoot = path.resolve(workdir, "out");
  const absolute = path.resolve(outRoot, artifact.path);
  if (!absolute.startsWith(outRoot + path.sep)) {
    throw new SupplierRequestError(`Bridge artifact path escapes workdir: ${artifact.path}`, 502);
  }
  try {
    const buffer = await readFile(absolute);
    if (!buffer.length) throw new Error("empty file");
    return buffer.toString("base64");
  } catch (error) {
    throw new SupplierRequestError(
      `Failed to read bridge artifact ${artifact.path}: ${(error as Error)?.message ?? String(error)}`,
      502,
    );
  }
}

/**
 * blender_bridge supplier → 單幀渲染 → SupplierGenerationOutput。
 * 分派入口：supplier-adapter.ts requestSupplier 的 blender_bridge 分支（片Y 稿 §B-2）。
 */
export async function generateWithBlenderNode(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  blenderNodeEngine(input.modelId); // 未知 modelId 直接 400，不虛跑
  const engine = blenderNodeEngine(input.modelId);
  // health 先行：fail-fast 橋不可達＋拿 workdir（產物解析根）＋gpu/queue 證據。
  const health = await bridgeHealth(supplier);
  // 按 attempt 隔離產物目錄（橋快照 diff 按 job 起點掃 out/，目錄名帶 attemptId
  // 讓 .blender-work/out/ 的每單產物可辨識；attemptId 是 DB uuid，只留安全字元）。
  const outputDirName = `node_${(input.attemptId || input.jobId || "job").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`;
  const sceneBlendPath =
    typeof input.workflow.metadata?.scene_blend_path === "string" && input.workflow.metadata.scene_blend_path.trim() !== ""
      ? input.workflow.metadata.scene_blend_path.trim()
      : undefined;
  const script = buildBlenderNodeFrameScript({ modelId: input.modelId, sceneBlendPath, outputDirName });
  const timeoutMs = Math.max(60_000, Number(process.env.BLENDER_NODE_EXECUTE_TIMEOUT_MS ?? 600_000));
  const result = await bridgeExecute(supplier, script, timeoutMs);

  const artifacts = result.artifacts.filter(isArtifact);
  // 橋側佇列事實（README 成功回應欄位）：queued=是否排過隊、queue_position=入隊
  // 瞬間 1-based 位次。health 輪詢與執行互搶 addon 幫浦（README 已知限制）採樣
  // 不可靠，橋自報欄位才是佇列計入的權威證據 → 進 evidence 供驗收對賬。
  const queued = result.queued === true;
  const queuePosition = Number(result.queue_position ?? 0);
  const queueEvidence = { queued, queuePosition };
  const png = artifacts.find((a) => a.kind === "png" && (a.bytes ?? 0) > 0);
  if (png) {
    const base64 = await readArtifactBase64(supplier, health.workdir, png);
    return {
      base64,
      url: null,
      providerRequestId: `blender:${supplier.id}:${input.attemptId}`,
      httpStatus: 200,
      endpointLabel: supplier.label,
      supplierModelId: input.modelId,
      evidence: {
        adapter: supplier.adapterType,
        supplierId: supplier.id,
        engine,
        artifactPath: png.path,
        artifactBytes: png.bytes,
        gpu: health.gpu,
        queueDepth: health.queue_depth,
        ...queueEvidence,
        sceneSummary: result.scene_summary,
        durationMs: result.duration_ms,
      },
    };
  }
  // png 缺席（只出了 blend/glb）：保留站內路徑走 /api/blender-artifact 既有通道。
  const fallback = artifacts.find((a) => a.kind === "blend") ?? artifacts.find((a) => a.kind === "glb");
  if (fallback) {
    return {
      base64: null,
      url: `/${fallback.path.replace(/^\/+/, "")}`,
      providerRequestId: `blender:${supplier.id}:${input.attemptId}`,
      httpStatus: 200,
      endpointLabel: supplier.label,
      supplierModelId: input.modelId,
      evidence: {
        adapter: supplier.adapterType,
        supplierId: supplier.id,
        engine,
        artifactPath: fallback.path,
        artifactBytes: fallback.bytes,
        gpu: health.gpu,
        sceneSummary: result.scene_summary,
        durationMs: result.duration_ms,
      },
    };
  }
  throw new SupplierRequestError(
    `Blender bridge returned no render artifacts (kinds: ${artifacts.map((a) => a.kind).join(",") || "none"}). stdout_tail: ${result.stdout_tail.slice(0, 300)}`,
    502,
    null,
    result.stdout_tail.slice(0, 1000),
  );
}
