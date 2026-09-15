/**
 * Expert 交付契約層（MOE 改革波 0-C，2026-09-08）。
 *
 * 憲法依據：docs/expert-constitution-draft.md 卷三「交付物閘門」落點——
 * Expert 幹完活必須回「契約形狀的交付物」，缺欄位 / 缺 QC 簽名 = 組裝閘門
 * 不過 = 視為未交付。本檔只做契約類型層 + 校驗函數，不接任何調用方；
 * 禁止 import expert-registry.ts（並行施工中），波 2 各片向 ExpertId /
 * EXPERT_IDS 追加聯合成員。
 *
 * 輪子對照（禁自造輪子鐵律）：
 *   - 類型擴展真源 = blender-delegate.ts（BlenderDelegationInput /
 *     BlenderDeliverable）：director3d 域的 payload 詞彙表從它 import
 *     擴展（Director3dDeliverablePayload），禁止重複定義同構類型；
 *     blender-delegate.ts 本體一行不動（只 import）。
 *   - 產物 → evidence 映射復用 bridge 回傳形 BlenderArtifact
 *     （src/lib/blender-tools.ts 真源），不自造第二份 artifacts 形狀。
 *   - 契約 + 測試寫法範式 = agent-tool-contract.ts（純類型層 + 聯合
 *     白名單 + node:test 斷言）。
 *   - 文案簡體（記憶 agent-gateway-copy-rules）。
 *
 * QC 簽名口徑（釘死）：sha256("expertId|kind|payload穩定JSON")，
 * node:crypto 實現；穩定 JSON = 遞迴按 key 排序、陣列保序，同內容
 * 不同 key 插入序必同簽名。
 */

import { createHash } from "node:crypto";
import type { BlenderDeliverable, BlenderDelegationInput } from "./blender-delegate";
import type { BlenderArtifact } from "./blender-tools";
import type { LyriaMusicContract } from "./music-lyria";
import type { ShotlistEntry } from "./screenwriter-delegate";

// ─────────────────────────────────────────── 契約類型（欄位釘死）

/** Expert 身份聯合（波 2 各片負責追加；追加時同步 EXPERT_IDS）。 */
export type ExpertId =
  | "director3d"
  | "music"
  // ↓ Wave2a 五域佔位（provisioned 不可路由，persona 片驗證後轉正）
  | "video-director"
  | "editor"
  | "screenwriter"
  | "motion-director"
  | "web3d-director"
  // ↓ 09-15 評測補課片：獨立審核 Expert（critic-delegate 換掛翻正追加）
  | "critic";

/** ExpertId 的運行時白名單（校驗與 registry 接線共用，勿在別處散抄）。 */
export const EXPERT_IDS = [
  "director3d",
  "music",
  "video-director",
  "editor",
  "screenwriter",
  "motion-director",
  "web3d-director",
  "critic",
] as const satisfies readonly ExpertId[];

/** Orchestrator → Expert 派工契約。 */
export interface ExpertTaskContract {
  expertId: ExpertId;
  /** 意圖。 */
  intent: string;
  /** 素材指針。 */
  materials: string[];
  /** 驗收標準。 */
  acceptance: string[];
  budgetCoins?: number;
  timeBudgetMinutes?: number;
}

/** Expert → Orchestrator 交付物（缺欄位 / 缺 QC 簽名 = 組裝閘門不過）。 */
export interface ExpertDeliverable {
  expertId: ExpertId;
  /** 交付物種類，如 "scene_3d" | "music_track"。 */
  kind: string;
  /** 交付物本體（按域 schema）。 */
  payload: Record<string, unknown>;
  /** 可核驗指針，至少一項。 */
  evidence: { url?: string; bytes?: number; durationSec?: number; artifactPath?: string };
  /** QC 簽名（computeQcSignature 產出）。 */
  qcSignature: string;
  /** 回指派工契約（可追溯）。 */
  contract: ExpertTaskContract;
}

export type ExpertDeliverableValidation = { ok: boolean; errors: string[] };

// ─────────────────────────────────────────── QC 簽名

/** 穩定 JSON：遞迴按 key 排序、陣列保序（JSON 兼容值逐值等價）。 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * QC 簽名 = sha256("expertId|kind|payload穩定JSON")（口徑釘死，hex）。
 * 同輸入兩次必同值；payload 內容任一變化必變值（篡改可檢）。
 */
export function computeQcSignature(d: Omit<ExpertDeliverable, "qcSignature">): string {
  return createHash("sha256")
    .update(`${d.expertId}|${d.kind}|${stableJsonStringify(d.payload)}`, "utf8")
    .digest("hex");
}

// ─────────────────────────────────────────── 組裝閘門校驗

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function positiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 交付物閘門：缺欄位 / 缺 QC 簽名 / 簽名被篡改 = ok:false，errors 逐條人話
 * （Expert 與 Orchestrator 都能直接照著補交）。純函數零副作用，絕不 throw
 * （對齊 blender-delegate.ts 錯誤鐵律）。
 */
export function validateExpertDeliverable(d: ExpertDeliverable): ExpertDeliverableValidation {
  const errors: string[] = [];
  const v = (d ?? {}) as unknown as Record<string, unknown>;

  const expertId = v.expertId;
  if (!(typeof expertId === "string" && (EXPERT_IDS as readonly string[]).includes(expertId))) {
    errors.push(
      `expertId 非法或缺失（收到 ${JSON.stringify(expertId) ?? "undefined"}）：只接受 ${EXPERT_IDS.map((id) => `"${id}"`).join("、")}，拼錯視為未交付。`,
    );
  }

  if (!nonEmptyString(v.kind)) {
    errors.push(`kind 缺失或為空：交付物種類必填（如 "scene_3d"、"music_track"）。`);
  }

  if (!isPlainObject(v.payload) || Object.keys(v.payload).length === 0) {
    errors.push("payload 缺失或為空對象：交付物本體必須至少攜帶一個按域 schema 的欄位，空殼交付視為未交付。");
  }

  const evidence = (isPlainObject(v.evidence) ? v.evidence : {}) as Record<string, unknown>;
  const hasEvidence =
    nonEmptyString(evidence.url) ||
    nonEmptyString(evidence.artifactPath) ||
    positiveNumber(evidence.bytes) ||
    positiveNumber(evidence.durationSec);
  if (!hasEvidence) {
    errors.push("evidence 至少需要一項可核驗指針：url（可訪問地址）、artifactPath（檔案路徑）、bytes（字節數）或 durationSec（時長秒）任一非空。");
  }

  const qcSignature = v.qcSignature;
  if (!nonEmptyString(qcSignature)) {
    errors.push("qcSignature 缺失：交付物必須附 QC 簽名（computeQcSignature 產出），缺簽名 = 組裝閘門不過。");
  } else {
    const expected = computeQcSignature({
      expertId: v.expertId as ExpertId,
      kind: (v.kind ?? "") as string,
      payload: (isPlainObject(v.payload) ? v.payload : {}) as Record<string, unknown>,
      evidence: evidence as ExpertDeliverable["evidence"],
      contract: v.contract as ExpertTaskContract,
    });
    if (qcSignature !== expected) {
      errors.push("qcSignature 與交付物內容不符（簽名被篡改或計算口徑不一致）：請用 computeQcSignature 對 expertId/kind/payload 原文重算後重交。");
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────── director3d 域擴展（輪子 import 範）

/**
 * director3d 域的 payload 詞彙表（從 blender-delegate.ts import 擴展，
 * 禁重複定義同構類型）：delegation 回執原始委託單、deliverables 復用
 * blender 交付物白名單。波 1「3D 導演掛 registry」按此填 payload。
 */
export type Director3dDeliverablePayload = {
  delegation?: BlenderDelegationInput;
  deliverables?: BlenderDeliverable[];
  scene_summary?: string;
  [key: string]: unknown;
};

/**
 * music 域的 payload 詞彙表（從 music-lyria.ts import 情緒契約形擴展，
 * 禁重複定義同構類型）：六欄與 registry music 行 requiredFields 同源
 * （MUSIC_DELIVERABLES，src/lib/music-delegate.ts）。波 1「音樂 Expert 掛
 * registry」按此填 payload；melody_notation（人聲主旋律音高序列）為導演文案
 * 側交付欄，music_gen 工具回執路徑不產、由導演正文回填。
 */
export type MusicDeliverablePayload = {
  emotion_contract?: LyriaMusicContract;
  lyrics?: string;
  melody_notation?: string;
  audio_url?: string;
  duration_source?: string;
  qc?: string;
  [key: string]: unknown;
};

/**
 * video-director 域的 payload 詞彙表（從 video-delegate.ts import 形狀擴展，
 * 禁重複定義同構類型）：四欄與 registry video-director 行 requiredFields 同源
 * （VIDEO_DELIVERABLES，src/lib/video-delegate.ts）。波 2「視頻導演掛
 * registry」按此填 payload；成片 URL 走 evidence.url。
 */
export type VideoDirectorDeliverablePayload = {
  shots?: string[];
  duration_sec?: number;
  model_hint?: string;
  qc?: string;
  [key: string]: unknown;
};

/**
 * editor 域的 payload 詞彙表（從 editor-delegate.ts import 形狀擴展，
 * 禁重複定義同構類型）：三欄與 registry editor 行 requiredFields 同源
 * （EDITOR_DELIVERABLES，src/lib/editor-delegate.ts）。成片 URL 走
 * evidence.url。
 */
export type EditorDeliverablePayload = {
  timeline_ops?: string[];
  duration_sec?: number;
  qc?: string;
  [key: string]: unknown;
};

/**
 * screenwriter 域的 payload 詞彙表（從 screenwriter-delegate.ts import
 * ShotlistEntry 擴展，禁重複定義同構類型）：三欄與 registry screenwriter 行
 * requiredFields 同源（SCREENWRITER_DELIVERABLES，src/lib/
 * screenwriter-delegate.ts）。
 */
export type ScreenwriterDeliverablePayload = {
  beats?: string[];
  shotlist?: ShotlistEntry[];
  qc?: string;
  [key: string]: unknown;
};

/**
 * bridge 產物 → 契約 evidence 指針（復用 BlenderArtifact 真源形，不自造
 * 第二份 artifacts 形狀）。path → artifactPath，bytes > 0 時透傳。
 */
export function blenderArtifactToEvidence(a: BlenderArtifact): ExpertDeliverable["evidence"] {
  const evidence: ExpertDeliverable["evidence"] = { artifactPath: a.path };
  if (positiveNumber(a.bytes)) evidence.bytes = Math.round(a.bytes);
  return evidence;
}
