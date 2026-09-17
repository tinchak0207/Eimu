"use client";

// 分鏡卡主體（2026-09-16 刀 2 消費端，G3）。
// 輪子來源：同目錄 Scene3dCardBody.tsx（欄位族渲染元件的結構/樣式慣例：欄位族取值 → 分層
// 正文區 → 徽章行），欄位表來源 = `src/lib/storyboard-contract.ts` 的 21 欄 AID 逐字契約。
// 白名單偏離僅四項：
//   ①數據源 = node.metadata.storyboardShot（一鏡，21 欄）/ node.metadata.storyboardScene（場景外殼）
//   ②文案簡體（與 NodeBody/Scene3dCardBody 同款）
//   ③交互鎖定 = P1 只讀：無編輯/生成入口（與 Scene3dCardBody 同姿態）
//   ④欄位分四組呈現（畫面/台词·音效/時空/摄影），非平鋪 21 行
//
// 空值規則（逐字沿用 AID）：無內容欄位 = `""`。**空欄位不渲染該行**——`""` 的語義就是
// 「本鏡無此內容」（空镜填 ""），畫成「—」或「（空）」是把「無內容」冒充成「有欄位」。
// 整組皆空則整組不渲染（組標題也不留），但 `shotNumber` 永遠渲染（唯一鍵，契約保證非空）。
//
// 尺寸鐵律：正文 ≥13px（DESIGN.md §4「正文不小於 13px」）；只有 eyebrow/label 走 11px。
// 渲染驗收權在暴君，本組件不做自我 UI 檢查。

import { Camera, Clock, Film, MessageSquareText } from "lucide-react";
import type { CanvasNode } from "@/lib/canvas/types";
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

/** 一鏡分鏡卡（AID 21 欄，掛在 Group 節點的子節點）。 */
export function StoryboardShotBody({
  node,
  onScrollAreaPointerDown,
  onScrollAreaPointerMove,
  onScrollAreaPointerEnd,
}: { node: CanvasNode } & ScrollGestures) {
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
