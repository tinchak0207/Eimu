// POST /api/harness/expert/deliverable/validate —— 交付契约校验（给 MCP 外部 agent 的确定性自检面）。
//
// 定位：对 Expert 交付物做**契约栏位层**的确定性校验，共四类：
//   ① 型别/expertId 合法；② kind 非空、payload 非空对象；③ evidence 至少一项可核验指针；
//   ④ qc 签章与内容相符；⑤ **该域契约 requiredFields 每一栏在 payload 中存在且值非空**。
//   **这不是品质评分**：这里没有模型、没有审美、没有主观判断，只有型别/白名单/哈希。
//   通过（ok:true）只代表「契约形状合格」，不代表成品可用（成品品质请走 /api/harness/media/quality）。
//
// 契约真源＝静态 import 的 src/lib/mcp/expert-delivery-contracts.json。
//   **为何是这份而非 deploy-staging/ 的？** deploy-staging/ 同时被 .vercelignore（`/deploy-staging/`）
//   与 .gitignore（`/deploy-staging/*`）排除、且完全未被 git 追踪，所以它**永远上不了 Vercel**
//   （远端 webpack 会因静态 import 而 `Module not found` 直接炸 build；本地有档故 `next build` 验不出）。
//   因此把契约档镜像一份到 `src/lib/mcp/expert-delivery-contracts.json`（会被打包上传）。
//   权威真源仍是 `deploy-staging/expert-gateway/expert-delivery-contracts.json`（与 VPS 活本对齐的那份），
//   两份必须**逐位元组一致**，由 `src/lib/mcp/expert-delivery-contracts.test.ts` 的同步棘轮守住。
//   内部同名闸门 deploy-staging/gateway/delivery-gate.ts 的 checkDelivery 读同一份 deploy-staging 原档，
//   但**判据不同、不等价**：它是在交付**自由文本**里做「栏位名子字串命中」（其档头自承
//   lyrics:"" 也算命中、不验值）；本 route 的输入是**结构化物件**，因此做更强检查——
//   requiredFields 每一栏必须在 payload 里存在**且值非空**（undefined／null／空串／空白串／
//   空数组／空对象都算缺）。两者读同一契约，但一个验「名字在不在」，一个验「有值没有」。
//
// qc_signature 口径：computeQcSignature = sha256("expertId|kind|payload稳定JSON")。
//   这是**确定性校验和（sha256，无密钥、无秘密）**——回传它不构成泄密，且与内部同一口径；
//   呼叫方据此自我修正或比对。回包恒带 qc_signature（对映射后输入重算的**期望值**）。
//
// 为什么在 `/api/harness/**` 而不是 `/api/v1/**`：后者被 next.config.mjs 的 beforeFiles
//   整包代理给控制面（`/image-control/api/v1/**`），控面没有本 route ⇒ 直打 404。harness
//   前缀未被代理，由本部署直接服务；MCP 工具目标路由漂移由 tools.test.ts 守门。
//
// 栏位层 / evidence / qc 签名的规则真源＝`src/lib/expert-contract.ts` 的
//   `validateExpertDeliverable` 与 `computeQcSignature`（本路由只做 HTTP 包装、body 白名单
//   与契约必填栏检查，**绝不重写它已有的规则**）。本档不呼叫任何模型、不呼叫任何付费上游、
//   不扣费、不写账本。
//
// 惯例逐项照抄既有 /api/v1 route（本专案 B 端 API 的通行形状）：biz-key 鉴权
//   （authenticateBizApiKey）、OpenAI 风格错误信封（error:{message,type,code,param,trace_id}）、
//   runtime/preferredRegion、traceId 走 getOrCreateTraceId/withTraceId。成功回包＝
//   `{ ok, errors[], qc_signature }`。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import {
  EXPERT_IDS,
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
  type ExpertId,
  type ExpertTaskContract,
} from "@/lib/expert-contract";

// 契约真源（resolveJsonModule 静态载入）。`src/lib/mcp/expert-delivery-contracts.json` 是为能被
// 建置打包而放在 src/ 的**镜像**；`deploy-staging/expert-gateway/expert-delivery-contracts.json`
// 才是与 VPS 活本对齐的那一份，两者必须逐位元组一致（有同步测试守住）。
import contractSource from "@/lib/mcp/expert-delivery-contracts.json";

/** 单域契约形状（与 delivery-gate.ts 的 ExpertDeliveryContract 同形）。 */
interface ExpertDeliveryContract {
  requiredFields: string[];
  qcSignatureRequired: boolean;
}

const DELIVERY_CONTRACTS = contractSource as unknown as Record<string, ExpertDeliveryContract>;

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error";

/** OpenAI 风格错误体（与 /v1/images/generations 同一形状，只多带 trace_id）。 */
function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
  headers?: Record<string, string>,
) {
  const response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status, ...(headers ? { headers } : {}) },
  );
  return withTraceId(response, traceId);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * evidence 键名相容层（**只做键名映射，不放宽任何验证**）。
 *
 * 为何存在：对外 MCP inputSchema（tools.ts 的 check_delivery_contract）宣告的 evidence
 * 指针是 **snake_case**（`artifact_path` / `duration_sec`），因为交付物 payload 本身用的是
 * snake_case 字段（见契约档 requiredFields）；但底层规则真源 `ExpertDeliverable.evidence`
 * （src/lib/expert-contract.ts:80）是 **camelCase**（`artifactPath` / `durationSec`）。
 * 若不在这一层映射，外部 agent 照工具说明书只给 `{"duration_sec": 12}` 会**必然失败**——
 * 2026-10-03 生产实测错误原文：
 *   `evidence 至少需要一项可核验指针：url（可访问地址）、artifactPath（档案路径）、bytes（字节数）或 durationSec（时长秒）任一非空。`
 * （真源只读 evidence.url / evidence.artifactPath / evidence.bytes / evidence.durationSec，
 *  snake_case 键对它是空气。）
 *
 * 优先序：camelCase 键原样通过；仅给 snake_case 键时映射为 camelCase；**两者同时给时以
 * camelCase 为准**（以「camelCase 为 undefined 才取 snake_case」实现，不看值真假——故
 * camelCase 给了 0／空值也算「已给」，不会被 snake_case 覆盖）。
 * `url` / `bytes` 本就同名，原样保留。
 *
 * 边界：非物件（undefined／null／非 object）由调用端维持原行为（交空物件，由
 * validateExpertDeliverable 回它原本的错误）；本函数**不新增拒绝逻辑、不改动其任何判据**，
 * 这是键名相容层，不是放行层。
 */
function normalizeEvidenceKeys(v: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...v };
  if (normalized.artifactPath === undefined && v.artifact_path !== undefined) {
    normalized.artifactPath = v.artifact_path;
  }
  if (normalized.durationSec === undefined && v.duration_sec !== undefined) {
    normalized.durationSec = v.duration_sec;
  }
  // 移除 snake_case 别名：统一成底层型别的键形，避免同一指针以两个键并存。
  delete normalized.artifact_path;
  delete normalized.duration_sec;
  return normalized;
}

/**
 * 结构化必填栏的「空值」判据：undefined／null／空串／空白串／空数组／空对象 = 缺。
 * 其余（含 0、false、非空串/数组/对象）视为**有值**——本检查只判「有没有实质值」，
 * 不判值对不对（那是品质层，与本工具无关）。
 */
function isEmptyFieldValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * 按域契约必填栏的结构化检查（比内部自由文本闸门更强，见档头）。
 * 缺栏保持契约档顺序、去重；`qcSignatureRequired` 从契约档读，true 且 requiredFields 未列 qc 时补一栏。
 * 回该域的「缺栏清单」（空数组＝全齐）。
 */
function missingContractFields(expertId: string, payload: Record<string, unknown>): string[] | null {
  const contract = DELIVERY_CONTRACTS[expertId];
  // 合法 EXPERT_ID 但契约档缺该域 → 回 null 表示「无契约可判」，调用端 fail-closed。
  if (!contract || !Array.isArray(contract.requiredFields)) return null;
  const fields = contract.requiredFields.filter((f): f is string => typeof f === "string" && f.length > 0);
  if (contract.qcSignatureRequired === true && !fields.includes("qc")) fields.push("qc");
  const missing: string[] = [];
  for (const field of fields) {
    if (missing.includes(field)) continue;
    if (isEmptyFieldValue(payload[field])) missing.push(field);
  }
  return missing;
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: OpenAIErrorType =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(
      auth.status,
      auth.message,
      type,
      auth.code,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "请求体不是合法 JSON。", "invalid_request_error", "invalid_json", traceId);
  }
  if (!isPlainObject(body)) {
    return errorResponse(400, "请求体必须是 JSON 对象。", "invalid_request_error", "invalid_payload", traceId);
  }

  // body 白名单（snake_case）：expert_id 非字符串/未知 → 400；payload 非物件 → 400。
  const expertId = body.expert_id;
  if (typeof expertId !== "string" || !(EXPERT_IDS as readonly string[]).includes(expertId)) {
    return errorResponse(
      400,
      `expert_id 非法或缺失：只接受 ${EXPERT_IDS.map((id) => `"${id}"`).join("、")}。`,
      "invalid_request_error",
      "invalid_expert_id",
      traceId,
    );
  }
  const payload = body.payload;
  if (!isPlainObject(payload)) {
    return errorResponse(
      400,
      "payload 必须是物件（按域 schema 的交付物本体；以 expert_id 对应的契约必填栏为准）。",
      "invalid_request_error",
      "invalid_payload",
      traceId,
    );
  }

  // snake_case → ExpertDeliverable 映射（含 evidence 键名相容，见 normalizeEvidenceKeys 档注）；
  // 型别/evidence/签名的规则一律交给真源函数判，本档不重写。
  const rawKind = body.kind;
  const rawEvidence = body.evidence;
  const rawQcSignature = body.qc_signature;
  const rawContract = body.contract;
  // evidence：物件才走键名相容映射；非物件维持原行为（交空物件，由真源回它原本的错误）。
  const evidence: ExpertDeliverable["evidence"] = isPlainObject(rawEvidence)
    ? (normalizeEvidenceKeys(rawEvidence) as ExpertDeliverable["evidence"])
    : {};
  const deliverable = {
    expertId: expertId as ExpertId,
    kind: rawKind,
    payload,
    evidence,
    qcSignature: rawQcSignature,
    contract: rawContract,
  } as unknown as ExpertDeliverable;

  const validation = validateExpertDeliverable(deliverable);
  const errors = [...validation.errors];

  // 追加：该域契约 requiredFields 的结构化非空检查（真源＝契约档，判据见档头）。
  const missing = missingContractFields(expertId, payload);
  if (missing === null) {
    // 合法 EXPERT_ID 但契约档查无此域 → fail-closed，绝不静默放行（工具是给外部自检用的）。
    errors.push(
      `expert_id "${expertId}" 在契约档中查无对应交付契约：该域无契约可判，本工具不放行（不得视为通过）。`,
    );
  } else if (missing.length > 0) {
    errors.push(
      `缺少 ${expertId} 契约必填栏位：${missing.join("、")}（空字符串／空数组／null 一律算缺）。`,
    );
  }

  // qc_signature 恒回**期望值**（对映射后输入重算），让呼叫方能自我修正或比对。
  // 与 validateExpertDeliverable 内部重算口径逐字一致（kind 归一化同它）：确定性校验和，无秘密。
  const expectedQcSignature = computeQcSignature({
    expertId: expertId as ExpertId,
    kind: (rawKind ?? "") as string,
    payload,
    evidence,
    contract: rawContract as ExpertTaskContract,
  });

  return withTraceId(
    NextResponse.json({ ok: errors.length === 0, errors, qc_signature: expectedQcSignature }),
    traceId,
  );
}
