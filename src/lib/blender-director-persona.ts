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
 *   ⑤ MOE Wave1-A Expert 框架接線：野獸模式（expert-registry.readBeastMode）
 *      ON 時委託單 prompt 注入 Expert 憲法頭部（deploy-staging/expert-gateway/
 *      expert-constitution.md 路徑常量，同 SKILL_PATH 單一真源範式）、回覆走
 *      交付物契約（blenderArtifactToEvidence → ExpertDeliverable →
 *      computeQcSignature → validateExpertDeliverable 閘門）並附契約摘要一行；
 *      OFF 時所有組裝與現狀逐欄位一致（零回歸）。registry 反向 import 有
 *      TDZ 模組環，readBeastMode 一律 call-time 動態 import。
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
  estimateTokens,
  sceneCardOpFromExecuteResult,
  type BlenderDelegation,
  type DelegationResult,
} from "./blender-delegate";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundledExpertConstitution } from "./expert-gateway-assets";
import { BLENDER_HARNESS_TOOL_IDS, type BlenderExecuteSuccess } from "./blender-tools";
import {
  blenderArtifactToEvidence,
  computeQcSignature,
  validateExpertDeliverable,
  type ExpertDeliverable,
} from "./expert-contract";

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
      /**
       * MOE Wave1-A：野獸模式 ON 時附的契約交付物（已過
       * validateExpertDeliverable 閘門）；OFF 時缺席 = 回覆鍵集合與現狀一致。
       */
      deliverable?: ExpertDeliverable;
    }
  | { ok: false; code: string; hint: string };

/** 回傳摘要 token 帽（隔離鐵律釘死值）。 */
export const DIRECTOR_REPLY_SUMMARY_TOKEN_CAP = 500 as const;

/**
 * 3D 導演回傳組裝（唯一出口）：bridge ExecuteResult → sceneCard →
 * canvas add_node op。兩端函數均 import 自 blender-delegate.ts，本檔只做
 * 序列（不新增校驗、不改 op 形狀）。
 *
 * MOE Wave1-A 野獸模式分支（assembleDirectorReplyOptions.settings 提供時生效）：
 *   ON（readBeastMode === true）→ 交付物契約路徑：sceneCard 六欄 payload 經
 *   blenderArtifactToEvidence 組 evidence、computeQcSignature 簽名、
 *   validateExpertDeliverable 校驗，不過 = 結構化報錯如實透傳（誠實鐵律，
 *   禁靜默回退現狀形）；回覆附契約摘要一行（expertId/kind/簽名前 8 位）。
 *   OFF / settings 缺省 → 現狀逐欄位一致（零回歸，reply 不帶 deliverable）。
 *   readBeastMode 經 readBeastModeSync（registry 動態 import 快取 + 同義
 *   內聯後備，見 primeExpertRegistry）讀取。
 */
export interface AssembleDirectorReplyOptions {
  /** 設定記錄（readBeastMode 消費 beast_mode 欄位；提供即啟用野獸分支）。 */
  settings?: unknown;
  /** 野獸模式 ON 時回填契約的原始委託單（materials 回指用，可缺省）。 */
  delegation?: BlenderDelegation;
}

export function assembleDirectorReply(
  result: BlenderExecuteSuccess,
  ctx: Parameters<typeof sceneCardOpFromExecuteResult>[1] = {},
  options?: AssembleDirectorReplyOptions,
): DirectorDelegationReply {
  const assembled = sceneCardOpFromExecuteResult(result, ctx);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, hint: assembled.hint };
  }
  const summary = typeof result.scene_summary === "string" ? result.scene_summary.trim() : "";
  const beastOn =
    options !== undefined &&
    "settings" in options &&
    readBeastModeSync(options.settings);
  if (!beastOn) {
    return {
      ok: true,
      scene_op: assembled.op,
      scene_summary: summary,
    };
  }

  // ── 野獸模式 ON：交付物契約路徑（Wave1-A）──
  const delegationRefs = options?.delegation?.reference_refs;
  const deliverable: ExpertDeliverable = {
    expertId: "director3d",
    kind: DIRECTOR_DELIVERABLE_KIND,
    payload: { sceneCard: assembled.op.node.metadata.sceneCard },
    evidence: blenderArtifactToEvidence(pickPrimaryArtifact(result.artifacts)),
    contract: {
      expertId: "director3d",
      intent:
        typeof ctx.title === "string" && ctx.title.trim() !== ""
          ? ctx.title.trim()
          : summary,
      materials: Array.isArray(delegationRefs) ? [...delegationRefs] : [],
      acceptance: [],
    },
    qcSignature: "",
  };
  deliverable.qcSignature = computeQcSignature(deliverable);
  const validation = validateExpertDeliverable(deliverable);
  if (!validation.ok) {
    return { ok: false, code: "deliverable_gate_failed", hint: validation.errors.join("；") };
  }
  return {
    ok: true,
    scene_op: assembled.op,
    scene_summary: capSceneSummaryWithLine(summary, buildDeliverableSummaryLine(deliverable)),
    deliverable,
  };
}

/** 交付物種類（scene_3d 節點域，與 buildScene3dCanvasOp 的 node.type 對齊）。 */
export const DIRECTOR_DELIVERABLE_KIND = "scene_3d" as const;

/**
 * 交付物主指針：優先 mp4（turntable 真身）、其次 png、否則首個產物
 * （collectSceneCardFromArtifacts 的 turntable 選取同序）。
 */
function pickPrimaryArtifact(artifacts: BlenderExecuteSuccess["artifacts"]): BlenderExecuteSuccess["artifacts"][number] {
  const list = Array.isArray(artifacts) ? artifacts : [];
  return list.find((a) => a.kind === "mp4") ?? list.find((a) => a.kind === "png") ?? list[0] ?? { path: "", bytes: 0, kind: "" };
}

/** 契約摘要一行（不超 DIRECTOR_REPLY_SUMMARY_TOKEN_CAP）：expertId/kind/簽名前 8 位。 */
export function buildDeliverableSummaryLine(d: ExpertDeliverable): string {
  const line = `deliverable expertId=${d.expertId} kind=${d.kind} qc=${d.qcSignature.slice(0, 8)}`;
  return estimateTokens(line) > DIRECTOR_REPLY_SUMMARY_TOKEN_CAP ? line.slice(0, DIRECTOR_REPLY_SUMMARY_TOKEN_CAP) : line;
}

/**
 * ON 模式摘要帽（僅野獸分支用；OFF 路徑零回歸不截斷）：契約行永不截除，
 * base 摘要從尾部對半收縮至 總長 ≤ DIRECTOR_REPLY_SUMMARY_TOKEN_CAP。
 */
function capSceneSummaryWithLine(base: string, line: string): string {
  let head = base;
  let out = head ? `${head}\n${line}` : line;
  while (head.length > 0 && estimateTokens(out) > DIRECTOR_REPLY_SUMMARY_TOKEN_CAP) {
    head = head.slice(0, Math.floor(head.length / 2));
    out = head ? `${head}\n${line}` : line;
  }
  return out;
}

/**
 * 主腦 → 3D 導演委託單構造（唯一入口）：直接透傳 composeDelegation
 * （import 輪子，零包裝邏輯）。persona 層不做第二套校驗。
 */
export const composeDirectorDelegation = composeDelegation;

/** 交付物白名單 re-export（契約釘死：與 Scene3dCardMetadata 六欄一一對應）。 */
export { BLENDER_DELIVERABLES };

// ─────────────────────────────────────────── ⑤ MOE Wave1-A：憲法注入 + settings 入口

/**
 * Expert 憲法檔路徑（repo 內相對路徑，單一真源 = deploy-staging/expert-gateway/
 * expert-constitution.md）。注入範式同 ③ 的 DIRECTOR_PERSONA_SKILL_PATH：
 * 本地只持有路徑與用途聲明，內容由 readFileSync 在組裝 prompt 時讀取
 * （測試端同款讀法，見 blender-director-persona.test.ts ③；服務端 runtime
 * 讀取走 composeDirectorDelegationForSettings 的 try/catch 後備 inline）。
 */
export const DIRECTOR_EXPERT_CONSTITUTION_PATH =
  "deploy-staging/expert-gateway/expert-constitution.md" as const;

/**
 * 交付前自檢節（誠實門禁，2026-09-08）：渲染後必須抽幀親眼看、逐項對照
 * 委託單、不符如實報、「全部完成」只在自檢全過後才許出現。憲法級行為——
 * 隨憲法注入走（ON 分支 prompt 憲法與委託單 JSON 之間），OFF 裸單契約
 * （serialized 原文一個字不多，blender-expert-frame.test.ts 釘死）不動。
 * 導出為單一真源常量：VPS persona 層（OFF 模式的提示面）日後引用同源文本。
 */
export const DIRECTOR_SELF_CHECK_SECTION = `## 交付前自檢（硬流程，跳過=事故）

渲染完成 ≠ 交付完成。以下四步一步不許跳，違反任何一步即為事故，不是建議。（鏡面立方體事故：宣稱「metallic 1.0 鏡面反光掃過、全部完成」，實際抽幀是啞光深灰＋構圖裁頂——話術編出的細節救不了畫面。）

1. **親眼看，才許開口。** 渲染完成後必須抽 ≥2 幀或讀 stills 逐張親眼看（用現場可用的讀圖通路）。沒有讀圖通路時必須明說「無法自檢，需暴君終驗」，禁止假裝看過，禁止拿 stdout／日誌腦補畫面。
2. **逐項對照委託單。** 材質關鍵詞（鏡面／金屬／啞光／透明…）在幀裡真的可見嗎？主體完整入框嗎（無裁頂裁邊）？機位構圖與委託一致嗎？
3. **不符就如實報。** 回覆寫「自檢未過：X 項不符（逐項列出）」：可修 → 修後重渲、重過自檢；不可修 → 明說未達委託單，禁止包裝。「全部完成」只在自檢全過後才許出現。
4. **自檢結果寫進回覆。** 末行附「自檢：材質✓ 構圖✓ 機位✓」（不符項標 ✗ 並寫死因），與交付物摘要行的 qc 簽名並列——只有 qc 沒有自檢行 = 視同未自檢 = 未交付。` as const;

/**
 * readBeastMode 的同域同步封裝：registry 為避 TDZ 模組環（registry 頂層
 * 解引用本檔常量）走 call-time 動態 import。primeExpertRegistry 先行預載
 * 失敗時，按 registry 同一判準（beast_mode 欄 === true）內聯後備，語義
 * 逐位元組一致；兩態皆記檔待查（誠實鐵律：靜默降級必留痕）。
 */
export type ExpertRegistryModule = {
  readBeastMode(settings: unknown): boolean;
};

let expertRegistryModule: ExpertRegistryModule | undefined;
let expertRegistryLoadFailureState: string | undefined;
/**
 * 測試注入的 loader（僅經 primeExpertRegistry 的可選參數設定）。生產呼叫端
 * 一律不傳參 → 恆走動態 import 真源；注入值在本模組生命週期內生效，使不傳
 * 參的生產呼叫端（如 composeDirectorDelegationPrompt）亦能覆現載入失敗路徑。
 */
let expertRegistryLoaderOverride: (() => Promise<unknown>) | undefined;

export async function primeExpertRegistry(
  loadExpertRegistry?: () => Promise<unknown>,
): Promise<boolean> {
  if (expertRegistryModule) return true;
  if (loadExpertRegistry !== undefined) expertRegistryLoaderOverride = loadExpertRegistry;
  const load = expertRegistryLoaderOverride ?? (() => import("./expert-registry"));
  try {
    expertRegistryModule = (await load()) as ExpertRegistryModule;
    expertRegistryLoadFailureState = undefined;
    return true;
  } catch (err) {
    expertRegistryLoadFailureState = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return false;
  }
}

/** 動態 import expert-registry 失敗的死因（成功／未 prime 時為 undefined）。誠實鐵律：兩態皆記檔待查，此為唯一出口。 */
export function getExpertRegistryLoadFailure(): string | undefined {
  return expertRegistryLoadFailureState;
}

/** 測試專用：清空 registry 動態 import 快取（野獸分支讀取路徑回退測試用）。 */
export function __resetExpertRegistryForTest(): void {
  expertRegistryModule = undefined;
  expertRegistryLoadFailureState = undefined;
  expertRegistryLoaderOverride = undefined;
}

function readBeastModeSync(settings: unknown): boolean {
  if (expertRegistryModule) return expertRegistryModule.readBeastMode(settings);
  // 後備路徑：判準與 expert-registry.readBeastMode 逐位元組同義（缺欄/非布林/false 一律 OFF）。
  if (typeof settings !== "object" || settings === null) return false;
  return (settings as Record<string, unknown>).beast_mode === true;
}

/**
 * 委託單 prompt 頭部組裝：OFF / 憲法檔讀取失敗（異常或空檔）時返回
 * serialized 原文（一個字都不多）；ON 時把憲法全文注入頭部，其後緊接
 * 交付前自檢節（DIRECTOR_SELF_CHECK_SECTION，誠實門禁 2026-09-08），再以
 * 分隔線接原委託單 JSON。ON 且憲法文本缺席 = 結構化報錯（不靜默裸奔，誠實鐵律）。
 */
export async function composeDirectorDelegationPrompt(
  input: unknown,
  settings?: unknown,
  opts: { constitutionPath?: string } = {},
): Promise<
  | {
      ok: true;
      prompt: string;
      constitutionInjected: boolean;
      estimated_tokens: number;
      /** 野獸分支 registry 動態 import 失敗死因（成功時缺席）；誠實鐵律唯一出口。 */
      registry_load_failure?: string;
    }
  | { ok: false; code: string; hint: string; fields?: string[] }
> {
  const composed = composeDelegation(input);
  if (!composed.ok) return composed;
  const on = readBeastModeSync(settings);
  if (!on) {
    return {
      ok: true,
      prompt: composed.serialized,
      constitutionInjected: false,
      estimated_tokens: composed.estimated_tokens,
    };
  }
  // 決策現場留痕（誠實鐵律）：接住 prime 結果，失敗時 additive 補死因出口。
  const primed = await primeExpertRegistry();
  let constitution: string | undefined;
  let constitutionError: string | undefined;
  try {
    // 顯式 override（opts.constitutionPath）仍走 fs 讀該檔（保留既有注入 seam 與
    // 測試：指向不存在／空檔時結構化拒絕）；未給才走靜態 import 的 bundle 鏡像
    // （Vercel 拿不到 deploy-staging/，見 src/lib/expert-gateway-assets.ts 檔頭）。
    const raw = opts.constitutionPath
      ? readFileSync(
          path.resolve(fileURLToPath(import.meta.url), "../../..", opts.constitutionPath),
          "utf8",
        )
      : loadBundledExpertConstitution();
    if (raw.trim() !== "") constitution = raw;
  } catch (err) {
    // 死因留痕（誠實鐵律）：讀取異常進結構化 hint，不進 log（secret 衛生鐵律）。
    constitutionError = err instanceof Error ? err.message : String(err);
  }
  if (constitution === undefined) {
    return {
      ok: false,
      code: "constitution_unavailable",
      hint: `野獸模式已開但 Expert 憲法檔不可讀（${DIRECTOR_EXPERT_CONSTITUTION_PATH}${constitutionError ? `：${constitutionError}` : "：檔案為空"}）：拒绝裸奔派單，請修復憲法檔部署或暫時關閉 beast_mode。`,
    };
  }
  // 自檢節隨憲法注入（憲法級：ON 必有；順序=憲法 → 自檢 → 分隔線 → 委託單 JSON）。
  const prompt = `${constitution.trimEnd()}\n\n${DIRECTOR_SELF_CHECK_SECTION}\n\n---\n\n${composed.serialized}`;
  return {
    ok: true,
    prompt,
    constitutionInjected: true,
    estimated_tokens: estimateTokens(prompt),
    ...(primed ? {} : { registry_load_failure: getExpertRegistryLoadFailure() ?? "unknown" }),
  };
}

/**
 * settings 入口（Wave1-A 接線面）：主腦調用方把 settings 記錄傳進來即可——
 * OFF 時返回值與 composeDirectorDelegation 逐欄位一致（ok/delegation/
 * serialized/estimated_tokens 四欄原樣），ON 時多出 prompt 頭部注入憲法。
 * （composeDelegation 為純函數，本包裝與 prompt 組裝各調一次，冪等零副作用。）
 */
export async function composeDirectorDelegationForSettings(
  input: unknown,
  settings?: unknown,
): Promise<
  | (Extract<DelegationResult, { ok: true }> & {
      constitutionInjected: boolean;
      prompt: string;
      /** 野獸分支 registry 動態 import 失敗死因（成功時缺席）；透傳自 prompt 組裝。 */
      registry_load_failure?: string;
    })
  | Extract<DelegationResult, { ok: false }>
  | { ok: false; code: "constitution_unavailable"; hint: string }
> {
  const promptResult = await composeDirectorDelegationPrompt(input, settings);
  if (!promptResult.ok) {
    if (promptResult.code === "constitution_unavailable") {
      return { ok: false, code: promptResult.code, hint: promptResult.hint };
    }
    return {
      ok: false,
      code: "invalid_delegation",
      hint: promptResult.hint,
      fields: promptResult.fields ?? [],
    };
  }  const composed = composeDelegation(input);
  if (!composed.ok) return composed;
  return {
    ...composed,
    constitutionInjected: promptResult.constitutionInjected,
    prompt: promptResult.prompt,
    ...(promptResult.registry_load_failure !== undefined
      ? { registry_load_failure: promptResult.registry_load_failure }
      : {}),
  };
}
