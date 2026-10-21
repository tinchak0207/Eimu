"use client";

// 分镜卡主体（2026-09-16 刀 2 消费端，G3）。
// 轮子来源：同目录 Scene3dCardBody.tsx（栏位族渲染元件的结构/样式惯例：栏位族取值 → 分层
// 正文区 → 徽章行），栏位表来源 = `src/lib/storyboard-contract.ts` 的 21 栏 AID 逐字契约。
// 白名单偏离仅四项：
//   ①数据源 = node.metadata.storyboardShot（一镜，21 栏）/ node.metadata.storyboardScene（场景外壳）
//   ②文案简体（与 NodeBody/Scene3dCardBody 同款）
//   ③交互 = 只读（与 Scene3dCardBody 同姿态）＋**音轨绑定/解除**入口
//     （2026-09-30：`bindShotAudioTrack`/`clearShotAudioTrack` 的 UI 生产者；
//     写入路径由宿主注入＝`onPatchMetadata`，未注入时整块不渲染＝维持原唯读）
//   ④栏位分四组呈现（画面/台词·音效/时空/摄影），非平铺 21 行
//
// 空值规则（逐字沿用 AID）：无内容栏位 = `""`。**空栏位不渲染该行**——`""` 的语义就是
// 「本镜无此内容」（空镜填 ""），画成「—」或「（空）」是把「无内容」冒充成「有栏位」。
// 整组皆空则整组不渲染（组标题也不留），但 `shotNumber` 永远渲染（唯一键，契约保证非空）。
//
// 尺寸铁律：正文 ≥13px（DESIGN.md §4「正文不小于 13px」）；只有 eyebrow/label 走 11px。
// 渲染验收权在暴君，本组件不做自我 UI 检查。

import { useState } from "react";
import { Camera, Clock, Film, Link2, Link2Off, MessageSquareText } from "lucide-react";
import type { CanvasNode, CanvasNodeMetadata } from "@/lib/canvas/types";
import {
  bindShotAudioTrack,
  clearShotAudioTrack,
  type ShotAudioTrackRole,
  type StoryboardShotAudioMetadata,
} from "@/lib/canvas/storyboard-shots";
import {
  parseReferenceAssets,
  STORYBOARD_SHOT_FIELDS,
  type StoryboardScriptShot,
  type StoryboardShotField,
} from "@/lib/storyboard-contract";

/** 一组 = 标题 + 该组栏位（顺序 = 21 栏契约顺序的子序列，组内不重排）。 */
interface ShotFieldGroup {
  key: "picture" | "voice" | "spacetime" | "camera";
  label: string;
  fields: readonly StoryboardShotField[];
}

/**
 * 四组切分。**并集必须恰为 `STORYBOARD_SHOT_FIELDS` 全 21 栏**（顺序无关，但不得漏/多）——
 * 由 `storyboardShotGroups` 的契约测试钉死（新增栏位若忘了归组 → 测试红，不会静默消失）。
 * `shotNumber` 不入组：它是镜号，渲染在卡头徽章，不当正文行。
 */
export const SHOT_FIELD_GROUPS: readonly ShotFieldGroup[] = [
  {
    key: "picture",
    label: "画面",
    fields: ["scriptContent", "visualDescription", "actionState", "narrativeFunction", "referenceAssets"],
  },
  { key: "voice", label: "台词 · 音效", fields: ["dialogue", "soundEffect"] },
  { key: "spacetime", label: "时空", fields: ["timeOfDay", "eraCoordinate", "dateCoordinate", "weather"] },
  {
    key: "camera",
    label: "摄影",
    fields: [
      "shotSize",
      "cameraAngle",
      "focalLength",
      "cameraMovement",
      "composition",
      "atmosphere",
      "colorTone",
      "lighting",
      "exposureBlur",
    ],
  },
];

/** 分组标题的中文栏位名（逐字取 AID 提示词开发指南 §输出 栏位表「含义」列）。 */
export const SHOT_FIELD_LABEL: Record<StoryboardShotField, string> = {
  shotNumber: "镜号",
  scriptContent: "剧本原文",
  visualDescription: "画面描述",
  dialogue: "台词",
  actionState: "动作状态",
  narrativeFunction: "叙事功能",
  timeOfDay: "时间坐标",
  eraCoordinate: "年代坐标",
  dateCoordinate: "日期坐标",
  weather: "气候天象",
  referenceAssets: "引用资产",
  shotSize: "景别",
  cameraAngle: "拍摄角度",
  focalLength: "焦距",
  cameraMovement: "镜头运动",
  composition: "构图",
  atmosphere: "画面氛围",
  colorTone: "色彩倾向",
  lighting: "光线",
  exposureBlur: "曝光虚化",
  soundEffect: "音效",
};

export interface ShotFieldRow {
  field: StoryboardShotField;
  label: string;
  value: string;
}

export interface ShotGroupRows {
  key: ShotFieldGroup["key"];
  label: string;
  rows: ShotFieldRow[];
}

/**
 * 一镜 → 分组列（纯函数，供测试直测）：丢弃空值栏位；整组皆空则整组丢弃。
 * `storyboardShotGroups` 之名留给 React 分支，本函数是它的资料来源。
 */
export function storyboardShotRows(shot: StoryboardScriptShot): ShotGroupRows[] {
  const out: ShotGroupRows[] = [];
  for (const group of SHOT_FIELD_GROUPS) {
    const rows: ShotFieldRow[] = [];
    for (const field of group.fields) {
      const value = (shot[field] ?? "").trim();
      if (value.length === 0) continue;
      rows.push({ field, label: SHOT_FIELD_LABEL[field], value });
    }
    if (rows.length > 0) out.push({ key: group.key, label: group.label, rows });
  }
  return out;
}

/** 已填栏数（21 栏中非空者）——卡头显示用，让「空镜」一眼可辨，不灌水成百分比。 */
export function storyboardFilledCount(shot: StoryboardScriptShot): number {
  let n = 0;
  for (const field of STORYBOARD_SHOT_FIELDS) {
    if ((shot[field] ?? "").trim().length > 0) n++;
  }
  return n;
}

const GROUP_ICON = {
  picture: Film,
  voice: MessageSquareText,
  spacetime: Clock,
  camera: Camera,
} as const;

/** 内容卷动手势（use-node-gestures 的 scrollDrag 三件套，由 NodeBody 显式传入）。 */
interface ScrollGestures {
  onScrollAreaPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * 音轨绑定的写入出口（宿主注入）。省略＝不出绑定入口，卡片维持原唯读姿态。
 *
 * 宿主侧的真实值＝`use-canvas-chat` 回传的 `patchNodeMetadata`（`src/hooks/use-canvas-chat.ts:787`,
 * 型别 `src/hooks/canvas/canvas-chat-types.ts:235`）——本档只收一个 `(patch) => void` 的窄介面，
 * 不 import 任何宿主 hook（维持 node-view 只依 props 的既有架构，零 context）。
 */
export interface ShotAudioBindingProps {
  /** 节点 metadata 补丁出口（宿主既有写入路径；本档不新开通道）。 */
  onPatchMetadata?: (patch: StoryboardShotAudioMetadata) => void;
}

/** 卡头：eyebrow「分镜」+ 镜号徽章 + 已填栏数。 */
function ShotHeader({ shotNumber, filled }: { shotNumber: string; filled: number }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <ClapperboardEyebrow />
      <span className="rounded-full bg-[rgba(90,200,250,0.18)] px-2 py-0.5 text-[13px] font-semibold leading-none tabular-nums text-[#0E7FA8]">
        {shotNumber}
      </span>
      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
        已填 {filled}/{STORYBOARD_SHOT_FIELDS.length} 栏
      </span>
    </div>
  );
}

function ClapperboardEyebrow() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">
      <Film className="h-3 w-3 shrink-0" aria-hidden="true" />
      分镜
    </span>
  );
}

/**
 * 引用资产：走 `parseReferenceAssets`（契约档既有纯函数，不另造解析器）→ 分类胶囊。
 * 解析不出结构（agent 没照 `场景:[名] 角色:[名]` 协议填）时回落原文，不谎报已解析。
 */
function ReferenceAssetsRows({ raw }: { raw: string }) {
  const parsed = parseReferenceAssets(raw);
  const sections: { key: string; label: string; names: string[] }[] = [
    { key: "scene", label: "场景", names: parsed.scene },
    { key: "character", label: "角色", names: parsed.character },
    { key: "prop", label: "道具", names: parsed.prop },
  ].filter((s) => s.names.length > 0);

  if (sections.length === 0) {
    return <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{raw}</p>;
  }

  return (
    <div className="space-y-1">
      {sections.map((section) => (
        <div key={section.key} className="flex flex-wrap items-center gap-1">
          <span className="shrink-0 text-[11px] font-medium leading-none text-muted-foreground">{section.label}</span>
          {section.names.map((name) => (
            <span
              key={`${section.key}-${name}`}
              className="rounded-full bg-ios-blue/10 px-2 py-0.5 text-[13px] leading-snug text-ios-blue"
            >
              {name}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 旁白行（单镜旁白文本；无旁白＝本镜无此内容，该行不渲染——同 21 栏空值规则）。 */
export function NarrationRow({ narration }: { narration: string }) {
  return (
    <div className="space-y-0.5">
      <span className="block text-[12px] font-medium leading-none text-muted-foreground">旁白</span>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{narration}</p>
    </div>
  );
}

/**
 * 音轨状态（对白轨／旁白轨，有／无）。
 *
 * 只在该镜**真的挂了任一轨音档**时出现（沿用本档空值铁律：整镜无音档＝本镜无此内容，
 * 画一排「无」是把「无」冒充成「有栏位」）；一旦有音轨，两轨并列显示各自有／无。
 */
export function AudioTrackStatus({
  dialogueAudioId,
  narrationAudioId,
}: {
  dialogueAudioId: string;
  narrationAudioId: string;
}) {
  if (!dialogueAudioId && !narrationAudioId) return null;
  const tracks = [
    { key: "dialogue", label: "对白轨", present: Boolean(dialogueAudioId) },
    { key: "narration", label: "旁白轨", present: Boolean(narrationAudioId) },
  ];
  return (
    <div className="space-y-0.5">
      <span className="block text-[12px] font-medium leading-none text-muted-foreground">音轨</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {tracks.map((track) => (
          <span
            key={track.key}
            className={
              track.present
                ? "rounded-full bg-ios-blue/10 px-2 py-0.5 text-[13px] leading-none text-ios-blue"
                : "rounded-full bg-black/5 px-2 py-0.5 text-[13px] leading-none text-muted-foreground"
            }
          >
            {track.label} {track.present ? "有" : "无"}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── 音轨绑定／解除（2026-09-30）
//
// 病灶：音轨四键（`narration` 只读文本 ＋ `dialogueAudioId`／`narrationAudioId`／
// `audioAnchorId`）虽入了双白名单，但纯函式 `bindShotAudioTrack`/`clearShotAudioTrack`
// （`@/lib/canvas/storyboard-shots`，音频判准复用既有轮子 `usableAudioUrl`）**没有呼叫端**
// ——使用者根本无从绑定。本段只补**入口**，不新增第二套音轨状态（显示仍走上面的
// `AudioTrackStatus`）、不新增第二套音频判准（值一律喂纯函式，不在本档判副档名）。
//
// 写入路径：本档**原本没有任何写入路径**（只读卡，见档头 ③）。节点 metadata 的唯一写入
// 出口是宿主的 `use-canvas-chat.patchNodeMetadata`（`src/hooks/use-canvas-chat.ts:787`），
// 它经 CanvasEmbed → CanvasNodeView → NodeBody 用 props 显式转发（全库无 canvas context/store）。
// 故本档以 `onPatchMetadata` 选配 prop 收这条出口：宿主注入＝出绑定入口；未注入＝整块不渲染
// （读旧呼叫端／测试的既有渲染逐栏零改动）。**不注入就不出按钮**——不画一个按下去没用的入口。
//
// 音档来源：现场**无既有音源轮子**可复用（素材库 `GET /api/canvas/assets` 只有 text|image
// 两种 kind；音频产物散在各音频节点的 `metadata.content`，本卡只拿到自己一颗 node，
// 无兄弟节点存取权）→ 诚实退化为「贴上音档 URL」输入框（任务书允许的退化路径）。

/** 音轨绑定／解除的结果（纯函式回传；`accepted:false` ＝**未写入**，呼叫端不得动 metadata）。 */
export interface ShotAudioActionOutcome {
  accepted: boolean;
  /** 要交给宿主 `patchNodeMetadata` 的 metadata patch（`accepted:true` 才有值）。 */
  patch?: StoryboardShotAudioMetadata;
  /** 明确提示（成功／失败都有人话，**不静默**——本专案纪律）。 */
  message: string;
}

/** 音轨中文名（提示语用；与 `AudioTrackStatus` 的「对白轨／旁白轨」同一套叫法）。 */
function shotAudioRoleLabel(role: ShotAudioTrackRole): string {
  return role === "dialogue" ? "对白" : "旁白";
}

/** 该轨在 metadata 上的键名（解除时判「这一轨到底有没有绑」用，不另造状态）。 */
function shotAudioRoleKey(role: ShotAudioTrackRole): "dialogueAudioId" | "narrationAudioId" {
  return role === "dialogue" ? "dialogueAudioId" : "narrationAudioId";
}

/** 三支音轨 metadata 键（本档唯一会显式删除的键集合；顺序固定，回报/patch 稳定）。 */
const SHOT_AUDIO_METADATA_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const;

/**
 * 纯函式的 patch → **可在合并式写入路径上生效的 patch**（本档存在的唯一理由之一）。
 *
 * 为什么需要这一层：`patchNodeMetadata` 走 `dispatchCanvas({type:"patch_metadata"})`，reducer
 * 是**合并**语义（`canvas-reducer-adapter.ts:281` 的 `{ ...clearShotMediaLinks(before, …), ...patch }`）
 * ——**合并删不掉键**。纯函式靠「省略键」表达删除（对一份新 metadata 而言正确），但直喂合并路径
 * 会留下旧值（解除对白后 `dialogueAudioId` 还在，`audioAnchorId` 仍指向被解除的那一轨＝悬空锚，
 * 门禁 `audio_anchor_present` 照样过）。故把「输入有、patch 没有」的键显式写成 `undefined`
 * （全库既有同款手法：`use-canvas-chat.ts:768` 用 `errorDetails: undefined` 清错误详情）。
 * 落盘耐久性由既有清洗器承担：`layout.toNodeMetadata` 的 `string` 清洗器把 `undefined` 判为
 * 「省略该键」→ 重载/上行后键真的不在（不是留一个 `""` 空壳）。
 */
function withExplicitDeletions(
  metadata: CanvasNodeMetadata | undefined,
  patch: StoryboardShotAudioMetadata,
): StoryboardShotAudioMetadata {
  const before = (metadata ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...patch };
  for (const key of SHOT_AUDIO_METADATA_KEYS) {
    if (key in before && !(key in patch)) out[key] = undefined;
  }
  return out as StoryboardShotAudioMetadata;
}

/**
 * 绑定一轨：算 patch ＋ 人话提示（纯函式，供 UI 与测试共用；判定全权交给
 * `bindShotAudioTrack`，本档不重写音频判准）。
 * 非可用音频（`.png` 图 URL／无副档名裸 URL／空字串）→ `accepted:false`、**无 patch**、
 * 提示明说「不是可用的音频地址」。
 */
export function shotAudioBindOutcome(
  metadata: CanvasNodeMetadata | undefined,
  role: ShotAudioTrackRole,
  audio: string,
): ShotAudioActionOutcome {
  const mutation = bindShotAudioTrack(metadata, role, audio);
  const label = shotAudioRoleLabel(role);
  if (!mutation.accepted) {
    return {
      accepted: false,
      message: `绑定失败：这不是可用的音频地址（需 .mp3/.m4a/.wav 等音频文件或 data:audio:）。请检查${label}音档地址后重试。`,
    };
  }
  return { accepted: true, patch: withExplicitDeletions(metadata, mutation.patch), message: `已绑定${label}音轨` };
}

/**
 * 解除一轨：该轨键本来就不在（或空字串）→ `accepted:false` ＋提示「尚未绑定」——
 * **不写一个什么都没改的 patch**（那会白推一格 undo 历史）。
 * 判据是「该键有没有值」的存在性检查（与卡面「已绑定」徽章、`AudioTrackStatus` 同一把尺），
 * **不是第二套音频有效性判准**：值合法与否仍由 `clearShotAudioTrack` 内的 `usableAudioUrl` 决定
 * （脏值照样会被清掉，且顺带把锚重算回剩下的那一轨）。
 */
export function shotAudioClearOutcome(
  metadata: CanvasNodeMetadata | undefined,
  role: ShotAudioTrackRole,
): ShotAudioActionOutcome {
  const label = shotAudioRoleLabel(role);
  const bag = (metadata ?? {}) as Record<string, unknown>;
  const raw = bag[shotAudioRoleKey(role)];
  if (!(typeof raw === "string" && raw.trim().length > 0)) {
    return { accepted: false, message: `该镜尚未绑定${label}音轨` };
  }
  const mutation = clearShotAudioTrack(metadata, role);
  return {
    accepted: true,
    patch: withExplicitDeletions(metadata, mutation.patch),
    message: `已解除${label}音轨`,
  };
}

/**
 * 单轨控件：贴上 URL → 绑定／解除。
 *
 * 提示行用 `role="status"`（无障碍）+ `text-[13px]`（正文尺寸铁律）；失败走 `text-destructive`，
 * 成功走 `text-muted-foreground`——成功与失败视觉可分，不靠颜色以外的猜测。
 * `data-canvas-interactive`＝画布手势层放行（`use-node-gestures.ts:97`），输入框另停 pointerdown
 * （否则打字/选字会被当成拖节点）。
 */
function ShotAudioTrackControls({
  role,
  metadata,
  onPatchMetadata,
}: {
  role: ShotAudioTrackRole;
  metadata: CanvasNodeMetadata | undefined;
  onPatchMetadata: (patch: StoryboardShotAudioMetadata) => void;
}) {
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const bag = (metadata ?? {}) as Record<string, unknown>;
  const boundRaw = bag[shotAudioRoleKey(role)];
  const bound = typeof boundRaw === "string" ? boundRaw.trim() : "";
  const label = shotAudioRoleLabel(role);

  const apply = (outcome: ShotAudioActionOutcome) => {
    setNotice({ text: outcome.message, ok: outcome.accepted });
    if (outcome.accepted && outcome.patch) onPatchMetadata(outcome.patch);
  };

  return (
    <div className="space-y-1">
      <span className="block text-[11px] font-medium leading-none text-muted-foreground">{label}音轨</span>
      <div className="flex flex-wrap items-center gap-1">
        {bound ? (
          <span
            className="max-w-full truncate rounded-full bg-ios-blue/10 px-2 py-0.5 text-[13px] leading-snug text-ios-blue"
            title={bound}
          >
            已绑定
          </span>
        ) : null}
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="粘贴音频 URL（.mp3/.m4a/.wav）"
          aria-label={`${label}音档 URL`}
          data-canvas-interactive
          className="min-w-0 flex-1 rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-[13px] leading-none text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
        />
        <button
          type="button"
          data-canvas-interactive
          onClick={(e) => {
            e.stopPropagation();
            apply(shotAudioBindOutcome(metadata, role, url));
          }}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-ios-blue/10 px-2.5 py-1 text-[13px] font-medium text-ios-blue transition-colors duration-150 hover:bg-ios-blue/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
        >
          <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          绑定
        </button>
        {bound ? (
          <button
            type="button"
            data-canvas-interactive
            onClick={(e) => {
              e.stopPropagation();
              apply(shotAudioClearOutcome(metadata, role));
            }}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-black/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
          >
            <Link2Off className="h-3 w-3 shrink-0" aria-hidden="true" />
            解除
          </button>
        ) : null}
      </div>
      {notice ? (
        <p
          role="status"
          className={
            notice.ok
              ? "break-words text-[13px] leading-relaxed text-muted-foreground"
              : "break-words text-[13px] leading-relaxed text-destructive"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

/** 一镜分镜卡（AID 21 栏，挂在 Group 节点的子节点）。 */
export function StoryboardShotBody({
  node,
  onPatchMetadata,
  onScrollAreaPointerDown,
  onScrollAreaPointerMove,
  onScrollAreaPointerEnd,
}: { node: CanvasNode } & ScrollGestures & ShotAudioBindingProps) {
  const shot: StoryboardScriptShot | undefined = node.metadata?.storyboardShot;

  if (!shot) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <Film className="h-7 w-7 text-foreground/45" aria-hidden="true" />
        <span className="text-ios-caption1 text-muted-foreground">分镜 · 等待 agent 填充</span>
      </div>
    );
  }

  const groups = storyboardShotRows(shot);
  const filled = storyboardFilledCount(shot);

  // ── 旁白文本 ＋ 对白／旁白双音轨（2026-09-30）──
  // 这四键**不在 21 栏编剧契约内**（属制作阶段 metadata），故不入 SHOT_FIELD_GROUPS
  //（那张表与 21 栏逐字绑定），改以「台词 · 音效」组的附加列呈现。值经宽化袋子读
  //（四键已在 `types.ts` 的 `CanvasNodeMetadata` 宣告——2026-09-30 现场核对：`narration`/
  // `dialogueAudioId`/`narrationAudioId`/`audioAnchorId` 逐键在案；此处仍走袋子读，
  // 与 `AudioTrackStatus` 消费端姿态一致，且容忍旧记忆「未宣告」的历史口径）。
  const audioMeta = (node.metadata ?? {}) as Record<string, unknown>;
  const narration = typeof audioMeta.narration === "string" ? audioMeta.narration.trim() : "";
  const dialogueAudioId = typeof audioMeta.dialogueAudioId === "string" ? audioMeta.dialogueAudioId.trim() : "";
  const narrationAudioId = typeof audioMeta.narrationAudioId === "string" ? audioMeta.narrationAudioId.trim() : "";
  const hasVoiceExtras = Boolean(narration || dialogueAudioId || narrationAudioId);
  // 绑定入口也要求「台词 · 音效」组成组：宿主注入了写入路径时，即使本镜一句台词/旁白都没有，
  // 使用者仍须有地方绑音轨（否则入口随空组一起消失＝没入口）。
  const showAudioControls = typeof onPatchMetadata === "function";
  // 对话/音效皆空但旁白或音轨存在时，「台词 · 音效」组仍须成组（否则制作物凭空消失）；
  // 插入位置照 SHOT_FIELD_GROUPS 的组序（voice 在 picture 之后、spacetime 之前）。
  if ((hasVoiceExtras || showAudioControls) && !groups.some((g) => g.key === "voice")) {
    const voiceLabel = SHOT_FIELD_GROUPS.find((g) => g.key === "voice")?.label ?? "台词 · 音效";
    const insertAt = groups.findIndex((g) => g.key === "spacetime" || g.key === "camera");
    groups.splice(insertAt < 0 ? groups.length : insertAt, 0, { key: "voice", label: voiceLabel, rows: [] });
  }

  return (
    <div
      onPointerDown={onScrollAreaPointerDown}
      onPointerMove={onScrollAreaPointerMove}
      onPointerUp={onScrollAreaPointerEnd}
      onPointerCancel={onScrollAreaPointerEnd}
      className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2.5 overflow-auto p-3"
    >
      <ShotHeader shotNumber={shot.shotNumber} filled={filled} />
      {groups.map((group) => {
        const GroupIcon = GROUP_ICON[group.key];
        return (
          <section key={group.key} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <GroupIcon className="h-3 w-3 shrink-0 text-[#0E7FA8]" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">
                {group.label}
              </span>
            </div>
            {group.rows.map((row) => (
              <div key={row.field} className="space-y-0.5">
                <span className="block text-[12px] font-medium leading-none text-muted-foreground">
                  {row.label}
                </span>
                {row.field === "referenceAssets" ? (
                  <ReferenceAssetsRows raw={row.value} />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
                    {row.value}
                  </p>
                )}
              </div>
            ))}
            {group.key === "voice" ? (
              <>
                {narration ? <NarrationRow narration={narration} /> : null}
                <AudioTrackStatus dialogueAudioId={dialogueAudioId} narrationAudioId={narrationAudioId} />
                {/* 绑定／解除入口：只在宿主注入 metadata 写入出口时出现（未注入＝原唯读态度） */}
                {showAudioControls && onPatchMetadata ? (
                  <div className="space-y-2 rounded-lg bg-black/[0.03] p-2">
                    <ShotAudioTrackControls
                      role="dialogue"
                      metadata={node.metadata}
                      onPatchMetadata={onPatchMetadata}
                    />
                    <ShotAudioTrackControls
                      role="narration"
                      metadata={node.metadata}
                      onPatchMetadata={onPatchMetadata}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/**
 * 分镜场景外壳（AID 根结构 `scenes[].sceneName`，挂在 **Group 节点**）。
 * 只渲染 `storyboardScene` 自带的指标（sceneName + shotCount）——真值是子节点的
 * `storyboardShot`，本元件**不**去列子镜：NodeBody 只拿到自己这颗 node，没有兄弟节点
 * 存取权（列子镜要向宿主 CanvasNodeView 传 `batchChildren` 解析结果，属跨档改动）。
 */
export function StoryboardSceneBody({
  node,
  onScrollAreaPointerDown,
  onScrollAreaPointerMove,
  onScrollAreaPointerEnd,
}: { node: CanvasNode } & ScrollGestures) {
  const scene = node.metadata?.storyboardScene;

  if (!scene) {
    return (
      <div className="m-3 flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-black/10">
        <span className="px-3 text-center text-ios-footnote font-medium text-muted-foreground">{node.title}</span>
      </div>
    );
  }

  return (
    <div
      onPointerDown={onScrollAreaPointerDown}
      onPointerMove={onScrollAreaPointerMove}
      onPointerUp={onScrollAreaPointerEnd}
      onPointerCancel={onScrollAreaPointerEnd}
      className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2.5 overflow-auto p-3"
    >
      <ClapperboardEyebrow />
      <p className="break-words text-[15px] font-semibold leading-snug text-foreground">{scene.sceneName}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-[rgba(90,200,250,0.18)] px-2 py-0.5 text-[13px] font-semibold leading-none tabular-nums text-[#0E7FA8]">
          {scene.shotCount} 镜
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        逐镜内容在场景内的分镜子节点上（一镜一节点）。
      </p>
    </div>
  );
}
