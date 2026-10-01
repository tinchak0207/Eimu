"use client";

// 分鏡卡主體（2026-09-16 刀 2 消費端，G3）。
// 輪子來源：同目錄 Scene3dCardBody.tsx（欄位族渲染元件的結構/樣式慣例：欄位族取值 → 分層
// 正文區 → 徽章行），欄位表來源 = `src/lib/storyboard-contract.ts` 的 21 欄 AID 逐字契約。
// 白名單偏離僅四項：
//   ①數據源 = node.metadata.storyboardShot（一鏡，21 欄）/ node.metadata.storyboardScene（場景外殼）
//   ②文案簡體（與 NodeBody/Scene3dCardBody 同款）
//   ③交互 = 只讀（與 Scene3dCardBody 同姿態）＋**音軌綁定/解除**入口
//     （2026-09-30：`bindShotAudioTrack`/`clearShotAudioTrack` 的 UI 生產者；
//     寫入路徑由宿主注入＝`onPatchMetadata`，未注入時整塊不渲染＝維持原唯讀）
//   ④欄位分四組呈現（畫面/台词·音效/時空/摄影），非平鋪 21 行
//
// 空值規則（逐字沿用 AID）：無內容欄位 = `""`。**空欄位不渲染該行**——`""` 的語義就是
// 「本鏡無此內容」（空镜填 ""），畫成「—」或「（空）」是把「無內容」冒充成「有欄位」。
// 整組皆空則整組不渲染（組標題也不留），但 `shotNumber` 永遠渲染（唯一鍵，契約保證非空）。
//
// 尺寸鐵律：正文 ≥13px（DESIGN.md §4「正文不小於 13px」）；只有 eyebrow/label 走 11px。
// 渲染驗收權在暴君，本組件不做自我 UI 檢查。

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

/** 一組 = 標題 + 該組欄位（順序 = 21 欄契約順序的子序列，組內不重排）。 */
interface ShotFieldGroup {
  key: "picture" | "voice" | "spacetime" | "camera";
  label: string;
  fields: readonly StoryboardShotField[];
}

/**
 * 四組切分。**並集必須恰為 `STORYBOARD_SHOT_FIELDS` 全 21 欄**（順序無關，但不得漏/多）——
 * 由 `storyboardShotGroups` 的契約測試釘死（新增欄位若忘了歸組 → 測試紅，不會靜默消失）。
 * `shotNumber` 不入組：它是鏡號，渲染在卡頭徽章，不當正文行。
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

/** 分組標題的中文欄位名（逐字取 AID 提示词开发指南 §輸出 欄位表「含义」列）。 */
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
 * 一鏡 → 分組列（純函數，供測試直測）：丟棄空值欄位；整組皆空則整組丟棄。
 * `storyboardShotGroups` 之名留給 React 分支，本函數是它的資料來源。
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

/** 已填欄數（21 欄中非空者）——卡頭顯示用，讓「空鏡」一眼可辨，不灌水成百分比。 */
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

/** 內容捲動手勢（use-node-gestures 的 scrollDrag 三件套，由 NodeBody 顯式傳入）。 */
interface ScrollGestures {
  onScrollAreaPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * 音軌綁定的寫入出口（宿主注入）。省略＝不出綁定入口，卡片維持原唯讀姿態。
 *
 * 宿主側的真實值＝`use-canvas-chat` 回傳的 `patchNodeMetadata`（`src/hooks/use-canvas-chat.ts:787`,
 * 型別 `src/hooks/canvas/canvas-chat-types.ts:235`）——本檔只收一個 `(patch) => void` 的窄介面，
 * 不 import 任何宿主 hook（維持 node-view 只依 props 的既有架構，零 context）。
 */
export interface ShotAudioBindingProps {
  /** 節點 metadata 補丁出口（宿主既有寫入路徑；本檔不新開通道）。 */
  onPatchMetadata?: (patch: StoryboardShotAudioMetadata) => void;
}

/** 卡頭：eyebrow「分镜」+ 镜号徽章 + 已填欄數。 */
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
 * 引用資產：走 `parseReferenceAssets`（契約檔既有純函數，不另造解析器）→ 分類膠囊。
 * 解析不出結構（agent 沒照 `场景:[名] 角色:[名]` 協議填）時回落原文，不謊報已解析。
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

/** 旁白行（單鏡旁白文本；無旁白＝本鏡無此內容，該行不渲染——同 21 欄空值規則）。 */
export function NarrationRow({ narration }: { narration: string }) {
  return (
    <div className="space-y-0.5">
      <span className="block text-[12px] font-medium leading-none text-muted-foreground">旁白</span>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{narration}</p>
    </div>
  );
}

/**
 * 音軌狀態（對白軌／旁白軌，有／無）。
 *
 * 只在該鏡**真的掛了任一軌音檔**時出現（沿用本檔空值鐵律：整鏡無音檔＝本鏡無此內容，
 * 畫一排「无」是把「無」冒充成「有欄位」）；一旦有音軌，兩軌並列顯示各自有／無。
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

// ─────────────────────────────────────────── 音軌綁定／解除（2026-09-30）
//
// 病灶：音軌四鍵（`narration` 只讀文本 ＋ `dialogueAudioId`／`narrationAudioId`／
// `audioAnchorId`）雖入了雙白名單，但純函式 `bindShotAudioTrack`/`clearShotAudioTrack`
// （`@/lib/canvas/storyboard-shots`，音頻判準複用既有輪子 `usableAudioUrl`）**沒有呼叫端**
// ——使用者根本無從綁定。本段只補**入口**，不新增第二套音軌狀態（顯示仍走上面的
// `AudioTrackStatus`）、不新增第二套音頻判準（值一律餵純函式，不在本檔判副檔名）。
//
// 寫入路徑：本檔**原本沒有任何寫入路徑**（只讀卡，見檔頭 ③）。節點 metadata 的唯一寫入
// 出口是宿主的 `use-canvas-chat.patchNodeMetadata`（`src/hooks/use-canvas-chat.ts:787`），
// 它經 CanvasEmbed → CanvasNodeView → NodeBody 用 props 顯式轉發（全庫無 canvas context/store）。
// 故本檔以 `onPatchMetadata` 選配 prop 收這條出口：宿主注入＝出綁定入口；未注入＝整塊不渲染
// （讀舊呼叫端／測試的既有渲染逐欄零改動）。**不注入就不出按鈕**——不畫一個按下去沒用的入口。
//
// 音檔來源：現場**無既有音源輪子**可複用（素材庫 `GET /api/canvas/assets` 只有 text|image
// 兩種 kind；音頻產物散在各音頻節點的 `metadata.content`，本卡只拿到自己一顆 node，
// 無兄弟節點存取權）→ 誠實退化為「貼上音檔 URL」輸入框（任務書允許的退化路徑）。

/** 音軌綁定／解除的結果（純函式回傳；`accepted:false` ＝**未寫入**，呼叫端不得動 metadata）。 */
export interface ShotAudioActionOutcome {
  accepted: boolean;
  /** 要交給宿主 `patchNodeMetadata` 的 metadata patch（`accepted:true` 才有值）。 */
  patch?: StoryboardShotAudioMetadata;
  /** 明確提示（成功／失敗都有人話，**不靜默**——本專案紀律）。 */
  message: string;
}

/** 音軌中文名（提示語用；與 `AudioTrackStatus` 的「对白轨／旁白轨」同一套叫法）。 */
function shotAudioRoleLabel(role: ShotAudioTrackRole): string {
  return role === "dialogue" ? "对白" : "旁白";
}

/** 該軌在 metadata 上的鍵名（解除時判「這一軌到底有沒有綁」用，不另造狀態）。 */
function shotAudioRoleKey(role: ShotAudioTrackRole): "dialogueAudioId" | "narrationAudioId" {
  return role === "dialogue" ? "dialogueAudioId" : "narrationAudioId";
}

/** 三支音軌 metadata 鍵（本檔唯一會顯式刪除的鍵集合；順序固定，回報/patch 穩定）。 */
const SHOT_AUDIO_METADATA_KEYS = ["dialogueAudioId", "narrationAudioId", "audioAnchorId"] as const;

/**
 * 純函式的 patch → **可在合併式寫入路徑上生效的 patch**（本檔存在的唯一理由之一）。
 *
 * 為什麼需要這一層：`patchNodeMetadata` 走 `dispatchCanvas({type:"patch_metadata"})`，reducer
 * 是**合併**語義（`canvas-reducer-adapter.ts:281` 的 `{ ...clearShotMediaLinks(before, …), ...patch }`）
 * ——**合併刪不掉鍵**。純函式靠「省略鍵」表達刪除（對一份新 metadata 而言正確），但直餵合併路徑
 * 會留下舊值（解除對白後 `dialogueAudioId` 還在，`audioAnchorId` 仍指向被解除的那一軌＝懸空錨，
 * 門禁 `audio_anchor_present` 照樣過）。故把「輸入有、patch 沒有」的鍵顯式寫成 `undefined`
 * （全庫既有同款手法：`use-canvas-chat.ts:768` 用 `errorDetails: undefined` 清錯誤詳情）。
 * 落盤耐久性由既有清洗器承擔：`layout.toNodeMetadata` 的 `string` 清洗器把 `undefined` 判為
 * 「省略該鍵」→ 重載/上行後鍵真的不在（不是留一個 `""` 空殼）。
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
 * 綁定一軌：算 patch ＋ 人話提示（純函式，供 UI 與測試共用；判定全權交給
 * `bindShotAudioTrack`，本檔不重寫音頻判準）。
 * 非可用音頻（`.png` 圖 URL／無副檔名裸 URL／空字串）→ `accepted:false`、**無 patch**、
 * 提示明說「不是可用的音频地址」。
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
 * 解除一軌：該軌鍵本來就不在（或空字串）→ `accepted:false` ＋提示「尚未绑定」——
 * **不寫一個什麼都沒改的 patch**（那會白推一格 undo 歷史）。
 * 判據是「該鍵有沒有值」的存在性檢查（與卡面「已绑定」徽章、`AudioTrackStatus` 同一把尺），
 * **不是第二套音頻有效性判準**：值合法與否仍由 `clearShotAudioTrack` 內的 `usableAudioUrl` 決定
 * （髒值照樣會被清掉，且順帶把錨重算回剩下的那一軌）。
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
 * 單軌控件：貼上 URL → 綁定／解除。
 *
 * 提示行用 `role="status"`（無障礙）+ `text-[13px]`（正文尺寸鐵律）；失敗走 `text-destructive`，
 * 成功走 `text-muted-foreground`——成功與失敗視覺可分，不靠顏色以外的猜測。
 * `data-canvas-interactive`＝畫布手勢層放行（`use-node-gestures.ts:97`），輸入框另停 pointerdown
 * （否則打字/選字會被當成拖節點）。
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

/** 一鏡分鏡卡（AID 21 欄，掛在 Group 節點的子節點）。 */
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

  // ── 旁白文本 ＋ 對白／旁白雙音軌（2026-09-30）──
  // 這四鍵**不在 21 欄編劇契約內**（屬製作階段 metadata），故不入 SHOT_FIELD_GROUPS
  //（那張表與 21 欄逐字綁定），改以「台词 · 音效」組的附加列呈現。值經寬化袋子讀
  //（四鍵已在 `types.ts` 的 `CanvasNodeMetadata` 宣告——2026-09-30 現場核對：`narration`/
  // `dialogueAudioId`/`narrationAudioId`/`audioAnchorId` 逐鍵在案；此處仍走袋子讀，
  // 與 `AudioTrackStatus` 消費端姿態一致，且容忍舊記憶「未宣告」的歷史口徑）。
  const audioMeta = (node.metadata ?? {}) as Record<string, unknown>;
  const narration = typeof audioMeta.narration === "string" ? audioMeta.narration.trim() : "";
  const dialogueAudioId = typeof audioMeta.dialogueAudioId === "string" ? audioMeta.dialogueAudioId.trim() : "";
  const narrationAudioId = typeof audioMeta.narrationAudioId === "string" ? audioMeta.narrationAudioId.trim() : "";
  const hasVoiceExtras = Boolean(narration || dialogueAudioId || narrationAudioId);
  // 綁定入口也要求「台词 · 音效」組成組：宿主注入了寫入路徑時，即使本鏡一句台詞/旁白都沒有，
  // 使用者仍須有地方綁音軌（否則入口隨空組一起消失＝沒入口）。
  const showAudioControls = typeof onPatchMetadata === "function";
  // 對話/音效皆空但旁白或音軌存在時，「台词 · 音效」組仍須成組（否則製作物憑空消失）；
  // 插入位置照 SHOT_FIELD_GROUPS 的組序（voice 在 picture 之後、spacetime 之前）。
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
                {/* 綁定／解除入口：只在宿主注入 metadata 寫入出口時出現（未注入＝原唯讀態度） */}
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
 * 分鏡場景外殼（AID 根結構 `scenes[].sceneName`，掛在 **Group 節點**）。
 * 只渲染 `storyboardScene` 自帶的指標（sceneName + shotCount）——真值是子節點的
 * `storyboardShot`，本元件**不**去列子鏡：NodeBody 只拿到自己這顆 node，沒有兄弟節點
 * 存取權（列子鏡要向宿主 CanvasNodeView 傳 `batchChildren` 解析結果，屬跨檔改動）。
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
