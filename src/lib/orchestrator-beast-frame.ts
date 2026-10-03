/**
 * Orchestrator 派工協議注入（MOE 改革 Wave1-C 後半，2026-09-08）。
 *
 * 職能：野獸模式（beast_mode）ON 時，把「Orchestrator 派遣手冊」＋ Expert
 * 註冊表摘要組裝成主 agent（Orchestrator / 導演）的 system prompt 附加幀；
 * OFF 時返回原文一個字不多（零回歸）。Orchestrator 從「全能工匠」變「導演」：
 * 定位目標、寫 spec、派遣、收結果、驗收，本體不內聯動手。
 *
 * 注入範式（跟隨現場，不發明）：與 Wave1-A 憲法注入同構——
 * src/lib/blender-director-persona.ts composeDirectorDelegationPrompt 的
 * node:fs readFileSync + import.meta.url 相對定位 + readBeastMode 閘門 +
 * 檔不可讀時結構化報錯（拒絕裸奔注入，誠實鐵律）。本倉 prompt 注入的唯一
 * 既有範式就是它（DIRECTOR_EXPERT_CONSTITUTION_PATH 註釋明言「內容由
 * readFileSync 在組裝 prompt 時讀取」），故 playbook 走同款 fs 讀取而非
 * inline 常量，單一真源 =
 * deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md。
 * 與 persona 的唯一差異：fs 改靜態 import（本檔經 expert-registry →
 * blender-tools 鏈本就 server-only，動態 import 在 tsx CJS 本地測試運行時
 * 解構不穩；VPS bun ESM 兩態皆通）。
 *
 * 消費方：VPS /opt/agent-harness/gateway（Orchestrator 主 prompt 組裝真源，
 * 本地 repo 無活碼，記憶片J）在組裝 system prompt 時調 buildOrchestratorFrame；
 * 本檔先在本地交付契約 + 測試釘死形狀，VPS 落位走後續部署片。
 */

import { loadBundledOrchestratorPlaybook } from "./expert-gateway-assets";
import { EXPERT_REGISTRY, readBeastMode, type ExpertDef } from "./expert-registry";
import { estimateTokens } from "./blender-delegate";

/** playbook 單一真源（repo 相對路徑，聲明部署來源位置；內容經静态 import 的
 *  src/lib/expert-gateway-assets.json 鏡像讀取——Vercel 拿不到 deploy-staging/）。 */
export const ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH =
  "deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md" as const;

/**
 * 配方庫欄空值如實標記（R4 修復片，2026-09-11）：skillPaths 為空 = 該域尚無
 * 配方庫可載。禁止填任何猜測/近似路徑（引用不存在檔案 = 幻影檔事故鐵律）。
 */
export const EXPERT_LINE_SKILL_PATHS_UNCONFIGURED = "未配置" as const;

/** 交付契約 qcSignature 欄文案（布林 → 人話；true 才視為已交付）。 */
export const EXPERT_LINE_QC_REQUIRED = "必需" as const;
export const EXPERT_LINE_QC_OPTIONAL = "可选" as const;

/** requiredFields 為空時如實標記（禁止編造欄位名）。 */
export const EXPERT_LINE_NO_REQUIRED_FIELDS = "无" as const;

/**
 * Expert 註冊表摘要：每個 Expert 一行 id/label/taskTypes/toolIds +
 * 配方庫（skillPaths）+ 交付契約（requiredFields + qcSignatureRequired），
 * provisioned 行標「未启用」（野獸模式 ON 也不可路由，routeExpert 不返回）。
 * 由 EXPERT_REGISTRY 動態生成，零手抄——registry 加行摘要自動跟進。
 *
 * R4（2026-09-11）擴充理由：Orchestrator 寫派遣 spec 時手冊第一節要求它寫
 * 「驗收標準」，但驗收標準的唯一來源（deliverableContract）與「進 Expert 即載
 * 配方庫」（skillPaths）先前都不進 prompt → 無從得知。兩欄照 registry 現值逐字
 * 輸出，skillPaths 空數組照實寫「未配置」（零編造）。
 */
export function buildExpertLine(expert: ExpertDef): string {
  const provisioned = expert.provisioned ? "（未启用）" : "";
  const skillPaths =
    expert.skillPaths.length > 0
      ? expert.skillPaths.join(", ")
      : EXPERT_LINE_SKILL_PATHS_UNCONFIGURED;
  const requiredFields =
    expert.deliverableContract.requiredFields.length > 0
      ? expert.deliverableContract.requiredFields.join(", ")
      : EXPERT_LINE_NO_REQUIRED_FIELDS;
  const qcSignature = expert.deliverableContract.qcSignatureRequired
    ? EXPERT_LINE_QC_REQUIRED
    : EXPERT_LINE_QC_OPTIONAL;
  return (
    `- ${expert.id}（${expert.label}）${provisioned}` +
    `：任务类型 ${expert.taskTypes.join(" / ")}；工具 ${expert.toolIds.join(", ")}` +
    `；配方库 ${skillPaths}；交付契约 ${requiredFields}（qcSignature：${qcSignature}）`
  );
}

/**
 * 剝離檔頭開發者元數據（R7，2026-09-10）：playbook 頂部 HTML 註釋（version/
 * source/gate 聲明）是給維護者看的，原樣進 prompt 是毒——實錘模型思維鏈
 * 「That's gated on BEAST_MODE=ON. There's no explicit indication BEAST_MODE=ON」
 * → 合理懷疑 gate 未滿足 → 走保守路徑。注入前剝離，當前狀態聲明由本函數
 * 動態生成（不進檔案）。VPS gateway index.ts/subagent.ts 注入點同款邏輯。
 */
export function stripProvenanceHeader(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart();
}

/** 野獸模式當前狀態聲明（R7）：告知模型 gate 已滿足，堵死保守路徑藉口。 */
export const BEAST_MODE_STATE_LINE =
  "【野獸模式：已啟用】以下派遣手冊與 Expert 註冊表由系統注入，這是當前系統的真實狀態：BEAST_MODE 現在就是 ON，以下全部條款立即生效，無需質疑、無需再確認任何 gate 條件。";

export function buildExpertRegistryDigest(): string {
  const lines = Object.values(EXPERT_REGISTRY).map(buildExpertLine);
  return ["Expert 注册表（能力断路真源；域外工具不存在于该 Expert 的工具表）：", ...lines].join("\n");
}

/**
 * 組裝 Orchestrator 主 prompt 幀。
 *
 * - OFF / settings 髒數據（readBeastMode === false）：返回 { frame: basePrompt,
 *   injected: false }——basePrompt 原樣透傳，一個字不多（零回歸斷言錨）。
 * - ON 且 playbook 可讀：返回 { frame: playbook + 註冊表摘要 + basePrompt,
 *   injected: true }（派工協議在主 prompt 頭部，其後接原文，格式同憲法注入
 *   `head\n\n---\n\nbody` 範式）。
 * - ON 但 playbook 檔不可讀/空檔：返回 ok:false 結構化報錯（拒絕裸奔——
 *   派工協議缺席時把全能工匠 prompt 原樣放行 = 假 ON，誠實鐵律禁止）。
 */
export async function buildOrchestratorFrame(
  basePrompt: string,
  settings?: unknown,
): Promise<
  | { ok: true; frame: string; injected: boolean; estimated_tokens: number }
  | { ok: false; code: string; hint: string }
> {
  if (!readBeastMode(settings)) {
    return { ok: true, frame: basePrompt, injected: false, estimated_tokens: estimateTokens(basePrompt) };
  }

  // 野獸模式 ON：读静态 import 的 bundle 镜像（Vercel 拿不到 deploy-staging/，
  // 见 src/lib/expert-gateway-assets.ts 檔頭；死因留痕進 hint，不進 log——secret
  // 衛生鐵律）。空资产抛错由下 catch 转 playbook_unavailable。
  let playbook: string | undefined;
  let playbookError: string | undefined;
  try {
    const raw = loadBundledOrchestratorPlaybook();
    if (raw.trim() !== "") playbook = raw;
  } catch (err) {
    playbookError = err instanceof Error ? err.message : String(err);
  }
  if (playbook === undefined) {
    return {
      ok: false,
      code: "playbook_unavailable",
      hint: `野獸模式已開但派遣手冊不可讀（${ORCHESTRATOR_DISPATCH_PLAYBOOK_PATH}${playbookError ? `：${playbookError}` : "：檔案為空"}）：拒绝裸奔主 prompt，請修復 playbook 部署或暫時關閉 beast_mode。`,
    };
  }

  const frame = `${BEAST_MODE_STATE_LINE}\n\n${stripProvenanceHeader(playbook).trimEnd()}\n\n${buildExpertRegistryDigest()}\n\n---\n\n${basePrompt}`;
  return { ok: true, frame, injected: true, estimated_tokens: estimateTokens(frame) };
}
