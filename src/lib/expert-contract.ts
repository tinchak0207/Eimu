/**
 * Expert 交付契约层（MOE 改革波 0-C，2026-09-08）。
 *
 * 宪法依据：docs/expert-constitution-draft.md 卷三「交付物闸门」落点——
 * Expert 干完活必须回「契约形状的交付物」，缺栏位 / 缺 QC 签名 = 组装闸门
 * 不过 = 视为未交付。本档只做契约类型层 + 校验函数，不接任何调用方；
 * 禁止 import expert-registry.ts（并行施工中），波 2 各片向 ExpertId /
 * EXPERT_IDS 追加联合成员。
 *
 * 轮子对照（禁自造轮子铁律）：
 *   - 类型扩展真源 = blender-delegate.ts（BlenderDelegationInput /
 *     BlenderDeliverable）：director3d 域的 payload 词汇表从它 import
 *     扩展（Director3dDeliverablePayload），禁止重复定义同构类型；
 *     blender-delegate.ts 本体一行不动（只 import）。
 *   - 产物 → evidence 映射复用 bridge 回传形 BlenderArtifact
 *     （src/lib/blender-tools.ts 真源），不自造第二份 artifacts 形状。
 *   - 契约 + 测试写法范式 = agent-tool-contract.ts（纯类型层 + 联合
 *     白名单 + node:test 断言）。
 *   - 文案简体（记忆 agent-gateway-copy-rules）。
 *
 * QC 签名口径（钉死）：sha256("expertId|kind|payload稳定JSON")，
 * node:crypto 实现；稳定 JSON = 递回按 key 排序、阵列保序，同内容
 * 不同 key 插入序必同签名。
 */

import { createHash } from "node:crypto";
import type { BlenderDeliverable, BlenderDelegationInput } from "./blender-delegate";
import type { BlenderArtifact } from "./blender-tools";
import type { LyriaMusicContract } from "./music-lyria";
import type { ShotlistEntry } from "./screenwriter-delegate";

// ─────────────────────────────────────────── 契约类型（栏位钉死）

/** Expert 身份联合（波 2 各片负责追加；追加时同步 EXPERT_IDS）。 */
export type ExpertId =
  | "director3d"
  | "music"
  | "lyricist"
  // ↓ Wave2a 五域占位（provisioned 不可路由，persona 片验证后转正）
  | "video-director"
  | "editor"
  | "screenwriter"
  | "motion-director"
  | "web3d-director"
  // ↓ 09-15 评测补课片：独立审核 Expert（critic-delegate 换挂翻正追加）
  | "critic";

/** ExpertId 的运行时白名单（校验与 registry 接线共用，勿在别处散抄）。 */
export const EXPERT_IDS = [
  "director3d",
  "music",
  "lyricist",
  "video-director",
  "editor",
  "screenwriter",
  "motion-director",
  "web3d-director",
  "critic",
] as const satisfies readonly ExpertId[];

/** Orchestrator → Expert 派工契约。 */
export interface ExpertTaskContract {
  expertId: ExpertId;
  /** 意图。 */
  intent: string;
  /** 素材指针。 */
  materials: string[];
  /** 验收标准。 */
  acceptance: string[];
  budgetCoins?: number;
  timeBudgetMinutes?: number;
}

/** Expert → Orchestrator 交付物（缺栏位 / 缺 QC 签名 = 组装闸门不过）。 */
export interface ExpertDeliverable {
  expertId: ExpertId;
  /** 交付物种类，如 "scene_3d" | "music_track"。 */
  kind: string;
  /** 交付物本体（按域 schema）。 */
  payload: Record<string, unknown>;
  /** 可核验指针，至少一项。 */
  evidence: { url?: string; bytes?: number; durationSec?: number; artifactPath?: string };
  /** QC 签名（computeQcSignature 产出）。 */
  qcSignature: string;
  /** 回指派工契约（可追溯）。 */
  contract: ExpertTaskContract;
}

export type ExpertDeliverableValidation = { ok: boolean; errors: string[] };

// ─────────────────────────────────────────── QC 签名

/** 稳定 JSON：递回按 key 排序、阵列保序（JSON 兼容值逐值等价）。 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * QC 签名 = sha256("expertId|kind|payload稳定JSON")（口径钉死，hex）。
 * 同输入两次必同值；payload 内容任一变化必变值（篡改可检）。
 */
export function computeQcSignature(d: Omit<ExpertDeliverable, "qcSignature">): string {
  return createHash("sha256")
    .update(`${d.expertId}|${d.kind}|${stableJsonStringify(d.payload)}`, "utf8")
    .digest("hex");
}

// ─────────────────────────────────────────── 组装闸门校验

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
 * 交付物闸门：缺栏位 / 缺 QC 签名 / 签名被篡改 = ok:false，errors 逐条人话
 * （Expert 与 Orchestrator 都能直接照著补交）。纯函数零副作用，绝不 throw
 * （对齐 blender-delegate.ts 错误铁律）。
 */
export function validateExpertDeliverable(d: ExpertDeliverable): ExpertDeliverableValidation {
  const errors: string[] = [];
  const v = (d ?? {}) as unknown as Record<string, unknown>;

  const expertId = v.expertId;
  if (!(typeof expertId === "string" && (EXPERT_IDS as readonly string[]).includes(expertId))) {
    errors.push(
      `expertId 非法或缺失（收到 ${JSON.stringify(expertId) ?? "undefined"}）：只接受 ${EXPERT_IDS.map((id) => `"${id}"`).join("、")}，拼错视为未交付。`,
    );
  }

  if (!nonEmptyString(v.kind)) {
    errors.push(`kind 缺失或为空：交付物种类必填（如 "scene_3d"、"music_track"）。`);
  }

  if (!isPlainObject(v.payload) || Object.keys(v.payload).length === 0) {
    errors.push("payload 缺失或为空对象：交付物本体必须至少携带一个按域 schema 的栏位，空壳交付视为未交付。");
  }

  const evidence = (isPlainObject(v.evidence) ? v.evidence : {}) as Record<string, unknown>;
  const hasEvidence =
    nonEmptyString(evidence.url) ||
    nonEmptyString(evidence.artifactPath) ||
    positiveNumber(evidence.bytes) ||
    positiveNumber(evidence.durationSec);
  if (!hasEvidence) {
    errors.push("evidence 至少需要一项可核验指针：url（可访问地址）、artifactPath（档案路径）、bytes（字节数）或 durationSec（时长秒）任一非空。");
  }

  const qcSignature = v.qcSignature;
  if (!nonEmptyString(qcSignature)) {
    errors.push("qcSignature 缺失：交付物必须附 QC 签名（computeQcSignature 产出），缺签名 = 组装闸门不过。");
  } else {
    const expected = computeQcSignature({
      expertId: v.expertId as ExpertId,
      kind: (v.kind ?? "") as string,
      payload: (isPlainObject(v.payload) ? v.payload : {}) as Record<string, unknown>,
      evidence: evidence as ExpertDeliverable["evidence"],
      contract: v.contract as ExpertTaskContract,
    });
    if (qcSignature !== expected) {
      errors.push("qcSignature 与交付物内容不符（签名被篡改或计算口径不一致）：请用 computeQcSignature 对 expertId/kind/payload 原文重算后重交。");
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────── director3d 域扩展（轮子 import 范）

/**
 * director3d 域的 payload 词汇表（从 blender-delegate.ts import 扩展，
 * 禁重复定义同构类型）：delegation 回执原始委托单、deliverables 复用
 * blender 交付物白名单。波 1「3D 导演挂 registry」按此填 payload。
 */
export type Director3dDeliverablePayload = {
  delegation?: BlenderDelegationInput;
  deliverables?: BlenderDeliverable[];
  scene_summary?: string;
  [key: string]: unknown;
};

/**
 * music 域的 payload 词汇表（从 music-lyria.ts import 情绪契约形扩展，
 * 禁重复定义同构类型）：六栏与 registry music 行 requiredFields 同源
 * （MUSIC_DELIVERABLES，src/lib/music-delegate.ts）。波 1「音乐 Expert 挂
 * registry」按此填 payload；melody_notation（人声主旋律音高序列）为导演文案
 * 侧交付栏，music_gen 工具回执路径不产、由导演正文回填。
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
 * video-director 域的 payload 词汇表（从 video-delegate.ts import 形状扩展，
 * 禁重复定义同构类型）：四栏与 registry video-director 行 requiredFields 同源
 * （VIDEO_DELIVERABLES，src/lib/video-delegate.ts）。波 2「视频导演挂
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
 * editor 域的 payload 词汇表（从 editor-delegate.ts import 形状扩展，
 * 禁重复定义同构类型）：三栏与 registry editor 行 requiredFields 同源
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
 * screenwriter 域的 payload 词汇表（从 screenwriter-delegate.ts import
 * ShotlistEntry 扩展，禁重复定义同构类型）：三栏与 registry screenwriter 行
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
 * bridge 产物 → 契约 evidence 指针（复用 BlenderArtifact 真源形，不自造
 * 第二份 artifacts 形状）。path → artifactPath，bytes > 0 时透传。
 */
export function blenderArtifactToEvidence(a: BlenderArtifact): ExpertDeliverable["evidence"] {
  const evidence: ExpertDeliverable["evidence"] = { artifactPath: a.path };
  if (positiveNumber(a.bytes)) evidence.bytes = Math.round(a.bytes);
  return evidence;
}

/** 原创歌词交付：正文原样保留，摘要限制不适用于 lyrics。 */
export type LyricistDeliverablePayload = { title: string; lyrics: string; hook: string; prosody_notes: string; qc: string; [key: string]: unknown };
