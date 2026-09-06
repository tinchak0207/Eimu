/**
 * 3D 導演 persona 契約真源（Astra 3D 導演工作站 P1-4，片 J，2026-09-06）。
 *
 * 本檔是「3D 導演（文案簡體「3D 导演」）」persona 的單一契約定義檔：
 *   ① 名稱/文案（簡體，記憶 agent-gateway-copy-rules）
 *   ② 工具白名單（blender_exec / blender_render / blender_export_gltf / image_quote）
 *   ③ SKILL 掛載引用（repo 內 skills/blender-director/SKILL.md 的語義定位；
 *      VPS 側經 opencode.json agent 條目的 prompt 段引用該路徑，見
 *      deploy-staging/blender-director-persona/ 三落位稿）
 *   ④ 委託單入參契約（composeDelegation schema）+ 回傳契約
 *      （bridge ExecuteResult → collectSceneCardFromArtifacts →
 *      buildScene3dCanvasOp）——全部 import 型別，零重定義。
 *
 * 為什麼是「契約檔」而非運行時：persona 的運行時真源（模型綁定
 * agent-models.json bindings、subagent 派遣 gateway/subagent.ts、agent prompt
 * / AGENTS.md）都在 VPS /opt/agent-harness（記憶 agent-persona-bound-model-
 * reasoning、subagent-ui-menu-gateway-reasoning-filter），本地 repo 無 gateway
 * 真源可改（.tmp-home/subagent.ts 是 08-31 派遣用鏡像非活碼）。本檔釘死契約
 * 四要素並被委託單/回傳兩端 import，Astra 真模型上線日只換
 * VPS agent-models.json 的 bindings.persona.director 一個 id。
 *
 * 隔離鐵律：3D 導演回傳只含資產引用 + 場景樹摘要（sceneCard 六欄 +
 * scene_summary ≤500 token），過程（stdout/腳本/多輪痕跡）不出 subagent——
 * 對應 gateway subagent.ts 既有隔離語義（subagent.delta 只透 text、
 * summary 截 600 字、子會話用後即刪），本檔不新增通道。
 */

import {
  BLENDER_DELIVERABLES,
  buildScene3dCanvasOp,
  composeDelegation,
  sceneCardOpFromExecuteResult,
  type BlenderDelegation,
  type DelegationResult,
} from "./blender-delegate";
import { BLENDER_HARNESS_TOOL_IDS, type BlenderExecuteSuccess } from "./blender-tools";

// ─────────────────────────────────────────── ① persona 身份與文案

/** persona 鍵名（gateway bindings / 設定 UI / 日誌統一用此 id）。 */
export const DIRECTOR_PERSONA_ID = "director" as const;

/** 展示名（簡體文案；選單/卡片/日誌統一取此值）。 */
export const DIRECTOR_PERSONA_LABEL = "3D 导演" as const;

/** persona 一句話定位（設定頁/選單描述用）。 */
export const DIRECTOR_PERSONA_DESCRIPTION =
  "专属 3D 导演：接委托单自主驱动 Blender 产出骨架动画与场景资产，只回资产引用与场景摘要，过程不出子代理。" as const;

// ─────────────────────────────────────────── ② 工具白名單

/**
 * 3D 導演可調用的工具白名單（PRD P1-4 釘死；禁給全工具面——3D 導演
 * 不需要畫視頻/寫 workflow）。
 *
 * - blender_exec / blender_render / blender_export_gltf：直接取
 *   blender-tools.ts 的 BLENDER_HARNESS_TOOL_IDS（禁止手抄 id 字串面）。
 * - image_quote：報價查詢（harness 既有 id，harness-tool-registry 登記在案）。
 */
export const DIRECTOR_PERSONA_TOOL_IDS = [
  ...BLENDER_HARNESS_TOOL_IDS, // blender_exec / blender_render / blender_export_gltf
  "image_quote",
] as const;

export type DirectorPersonaToolId = (typeof DIRECTOR_PERSONA_TOOL_IDS)[number];

// ─────────────────────────────────────────── ③ SKILL 掛載引用

/**
 * SKILL 掛載點：repo 內 3D 導演配方庫（片B 交付，五階段管線 + 12 份上游配方）。
 * VPS 側 opencode.json 的 director agent 條目 prompt 段引用同內容路徑
 * （AGENTS.md 路由：Blender/bpy 委託一律先讀該 SKILL 再動手）。
 * 本地只持有路徑與用途聲明，不複製內容（單一真源防漂移）。
 */
export const DIRECTOR_PERSONA_SKILL_PATH = "skills/blender-director/SKILL.md" as const;

// ─────────────────────────────────────────── ④ 委託單 + 回傳契約（import，零重定義）

/**
 * 委託單入參契約 = blender-delegate.ts composeDelegation 的 schema。
 * 型別全 import（BlenderDelegation / DelegationResult），此處零重定義。
 */
export type { BlenderDelegation, DelegationResult };

/** bridge 成功體回傳契約（blender-tools.ts 原型 import）。 */
export type { BlenderExecuteSuccess };

/** 委託單回傳（隔離鐵律形）：資產引用 + 場景摘要，≤500 token。 */
export type DirectorDelegationReply =
  | {
      ok: true;
      /** 畫布節點寫入 op（scene_3d add_node；gateway 經 canvas.ops SSE 下發）。 */
      scene_op: ReturnType<typeof buildScene3dCanvasOp>;
      /** 場景樹摘要（≤500 token，隔離鐵律：過程不出 subagent）。 */
      scene_summary: string;
    }
  | { ok: false; code: string; hint: string };

/** 回傳摘要 token 帽（隔離鐵律釘死值）。 */
export const DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 3D 導演回傳組裝（唯一出口）：bridge ExecuteResult → sceneCard →
 * canvas add_node op。兩端函數均 import 自 blender-delegate.ts，本檔只做
 * 序列（不新增校驗、不改 op 形狀）。
 */
export function assembleDirectorReply(
  result: BlenderExecuteSuccess,
  ctx: Parameters<typeof sceneCardOpFromExecuteResult>[1] = {},
): DirectorDelegationReply {
  const assembled = sceneCardOpFromExecuteResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  const summary = typeof result.scene_summary === "string" ? result.scene_summary.trim() : "";
  return {
    ok: true,
    scene_op: assembled.op,
    scene_summary: summary,
  };
}

/**
 * 主腦 → 3D 導演委託單構造（唯一入口）：直接透傳 composeDelegation
 * （import 輪子，零包裝邏輯）。persona 層不做第二套校驗。
 */
export const composeDirectorDelegation = composeDelegation;

/** 交付物白名單 re-export（契約釘死：與 Scene3dCardMetadata 六欄一一對應）。 */
export { BLENDER_DELIVERABLES };
