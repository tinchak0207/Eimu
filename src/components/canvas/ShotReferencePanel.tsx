"use client";

// ShotReferencePanel —— 「本镜参考素材」解析清單（生成前看得見本鏡實際帶上的參考素材）。
//
// 定位：卡是項目級「鎖定配置」，token 是正文裡的「逐處引用」。本元件把兩者攤在同一塊：
//   - source "token"：正文用 @ 就地引用的卡（本鏡真正點名的實體）
//   - source "shot"：本鏡**已指定**的卡（來源＝節點 metadata 的卡 id 欄，非行內引用）
//   - source "locked"：項目鎖定、但本鏡沒行內引用的卡（低對比灰——一眼看出漏引）
//   - unresolvedTokens：解析不到對應卡的 token 原文（紅字警示，**不阻擋生成**——
//     與 entity-tokens 的 fail-open 語義一致：未命中就原樣留在 prompt 裡）
//
// 純展示：零 API、零 hook 副作用。條目與未解析清單由宿主用下列純函式推導（useMemo），
// 本檔不讀 DOM、不發請求、不訂閱。

import type { CharacterCardKind } from "@/lib/character-cards";
import { parseEntityTokens, resolveEntityTokenKind, serializeEntityToken } from "@/lib/entity-tokens";
import { cn } from "@/lib/utils";

export interface ShotReferenceEntry {
  key: string;
  kindLabel: string; // 角色/场景/风格/道具
  name: string;
  previewUrl?: string;
  /** token = 行內 @ 引用；shot = 本鏡已指定（metadata 卡 id 欄）；locked = 項目鎖定但本鏡沒引用。 */
  source: "token" | "locked" | "shot";
}

export interface ShotReferencePanelProps {
  entries: ShotReferenceEntry[];
  /** 正文裡無法解析的 token 原文（紅字警示，不阻擋生成）。 */
  unresolvedTokens?: string[];
}

/**
 * 推導用的候選卡形狀——與 CanvasNodePromptPanel 的 `CanvasEntityCandidate` 同構。
 * 本檔刻意不回向 import 面板（避免元件互相 import 成環），改吃結構相容的窄型別。
 */
export interface ShotReferenceCandidate {
  cardId: string;
  name: string;
  kind: CharacterCardKind;
  kindLabel: string;
  previewUrl: string;
}

export interface ShotReferenceDerivation {
  entries: ShotReferenceEntry[];
  unresolvedTokens: string[];
}

/**
 * 純推導：正文 token × 可用候選卡 → 本鏡參考素材條目 + 未解析 token。
 *
 * 語義：
 *   - token 命中（種類字可解析且同名同 kind 的卡在候選內）→ 一條 source "token"；
 *     同一張卡被引用多次只列一條（首次出現序）。
 *   - 候選卡未被任何 token 引用 → 一條 source "locked"（候選原序，排在 token 段之後）。
 *   - token 未命中（種類字未知 / 候選裡沒這張卡）→ 原始字串進 unresolvedTokens（去重）。
 *   - 純函式：不改輸入。
 */
export function deriveShotReference(
  promptText: string,
  candidates: readonly ShotReferenceCandidate[],
): ShotReferenceDerivation {
  const hits = parseEntityTokens(promptText);
  const entries: ShotReferenceEntry[] = [];
  const unresolvedTokens: string[] = [];
  const usedCardIds = new Set<string>();
  for (const hit of hits) {
    const kind = resolveEntityTokenKind(hit.kindLabel);
    const matched = kind
      ? candidates.find((cand) => cand.kind === kind && cand.name.trim() === hit.name.trim())
      : undefined;
    if (!matched) {
      const raw = promptText.slice(hit.start, hit.end);
      if (!unresolvedTokens.includes(raw)) unresolvedTokens.push(raw);
      continue;
    }
    if (usedCardIds.has(matched.cardId)) continue;
    usedCardIds.add(matched.cardId);
    entries.push({
      key: `token:${matched.cardId}`,
      kindLabel: matched.kindLabel,
      name: matched.name,
      previewUrl: matched.previewUrl,
      source: "token",
    });
  }
  for (const cand of candidates) {
    if (usedCardIds.has(cand.cardId)) continue;
    entries.push({
      key: `locked:${cand.cardId}`,
      kindLabel: cand.kindLabel,
      name: cand.name,
      previewUrl: cand.previewUrl,
      source: "locked",
    });
  }
  return { entries, unresolvedTokens };
}

/** 純分組：條目按來源分三段（token → shot → locked，locked 永遠墊底）。 */
export function groupShotReferenceEntries(
  entries: readonly ShotReferenceEntry[],
): { token: ShotReferenceEntry[]; locked: ShotReferenceEntry[]; shot: ShotReferenceEntry[] } {
  return {
    token: entries.filter((entry) => entry.source === "token"),
    locked: entries.filter((entry) => entry.source === "locked"),
    shot: entries.filter((entry) => entry.source === "shot"),
  };
}

// ─────────────────────────── @ 選單候選列（純邏輯，DOM 無關）

/** @ 選單的攤平列：兩組候選共用同一個連續索引序列（↑↓ 跨組導航）。 */
export interface MentionRow {
  /** 攤平後的連續索引（跨組），鍵盤導航吃這個。 */
  index: number;
  group: "image" | "entity";
  /** 在該組候選陣列中的下標（消費端用它取回原候選物件）。 */
  sourceIndex: number;
}

/**
 * 純函式：把兩組候選攤平成一列（圖片組在前、素材卡組在後），並套用 query 過濾。
 *
 * 語義：
 *   - 過濾對兩組都生效：圖片比標題、素材卡比名稱（lowercase includes）。
 *   - 空 query（含純空白）＝不過濾，順序即「圖片組在前、素材卡組在後」。
 *   - 某組為空 → 該組不出列（消費端據此不渲染組標題，零空組）。
 *   - 兩組都沒命中 → 回空陣列（消費端據此關閉選單，維持既有行為）。
 */
export function buildMentionRows(
  imageCandidates: readonly { title: string }[],
  entityCandidates: readonly { name: string }[],
  query: string,
): MentionRow[] {
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const rows: MentionRow[] = [];
  imageCandidates.forEach((cand, sourceIndex) => {
    if (!match(cand.title)) return;
    rows.push({ index: rows.length, group: "image", sourceIndex });
  });
  entityCandidates.forEach((cand, sourceIndex) => {
    if (!match(cand.name)) return;
    rows.push({ index: rows.length, group: "entity", sourceIndex });
  });
  return rows;
}

// ─────────────────────────── chip 序列化分派（純函式，吃假 dataset）

/** chip 序列化只看這幾個 data-* 欄位（純函式介面：測試可餵假物件）。 */
export interface ChipSerializationInput {
  /** data-node-id：上游圖片 chip。 */
  nodeId?: string;
  /** data-card-id：素材卡 chip（有此欄即走 token 序列化）。 */
  cardId?: string;
  /** data-card-kind：卡 kind 原文（"scene" / "角色" 皆可解析）。 */
  cardKind?: string;
  /** data-title：顯示／引用用的全名（未被 CHIP_TITLE_MAX 截斷）。 */
  title?: string;
}

/**
 * 生成用 chip 序列化分派（純函式）：
 *   - 帶 `cardId` → `@[场景:雨夜街]`（種類字由 cardKind 正規化；認不出 → 角色）
 *   - 帶 `nodeId` → `@图片N`（N = 在 selectedIds 的序號 + 1；不在清單則退回 `@标题`）
 * 分派靠 `cardId` 判定（不是 class）——素材卡 chip 不會被誤編成 `@图片N`。
 */
export function serializeChipText(input: ChipSerializationInput, selectedIds: readonly string[]): string {
  if (input.cardId) {
    return serializeEntityToken({
      kind: resolveEntityTokenKind(input.cardKind ?? "") ?? "character",
      name: input.title ?? "",
    });
  }
  const id = input.nodeId ?? "";
  const idx = selectedIds.indexOf(id);
  return idx >= 0 ? `@图片${idx + 1}` : `@${input.title || "图片"}`;
}

// ─────────────────────────── 展示元件

function ShotReferenceItem({ entry }: { entry: ShotReferenceEntry }) {
  // 灰階 chip ＝「不是行內 @ 引用」的兩種來源（locked 未引用 / shot 已指定），
  // 只有 token（本鏡真正行內點名）走有色 chip。
  const muted = entry.source !== "token";
  return (
    <span
      className={cn(
        "inline-flex max-w-[160px] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs",
        muted ? "bg-black/5 text-foreground/45" : "bg-ios-purple/15 text-ios-purple",
      )}
      title={`${entry.kindLabel}:${entry.name}`}
    >
      {entry.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.previewUrl} alt={entry.name} className="h-4 w-4 shrink-0 rounded-[3px] object-cover" draggable={false} />
      ) : null}
      <span className={cn("shrink-0 font-medium", muted && "opacity-70")}>{entry.kindLabel}</span>
      <span className="truncate">{entry.name}</span>
    </span>
  );
}

/**
 * 本镜参考素材清單（玻璃面板語彙沿用 CanvasNodePromptPanel 既有小卡片：
 * `border-t` 分隔 + `bg-black/5` 徽章 + `text-ios-caption2 text-foreground/45` 標題）。
 * 條目為空且無未解析 token → 整塊不渲染（零空殼）。
 */
export function ShotReferencePanel({ entries, unresolvedTokens = [] }: ShotReferencePanelProps) {
  if (entries.length === 0 && unresolvedTokens.length === 0) return null;
  const { token, locked, shot } = groupShotReferenceEntries(entries);
  return (
    <div className="border-t px-3 py-2" data-shot-reference-panel>
      {/* 一行摘要（預設即可見）；條目區自身限高可捲，不撐高面板影響既有按鈕列 */}
      <p className="mb-1.5 text-ios-caption2 font-medium text-foreground/45">
        本镜参考素材 {entries.length}
      </p>
      {token.length > 0 && (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
          {token.map((entry) => (
            <ShotReferenceItem key={entry.key} entry={entry} />
          ))}
        </div>
      )}
      {shot.length > 0 && (
        <div className="mt-1.5 flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto">
          <span className="shrink-0 text-ios-caption2 text-foreground/35">本镜已指定</span>
          {shot.map((entry) => (
            <ShotReferenceItem key={entry.key} entry={entry} />
          ))}
        </div>
      )}
      {locked.length > 0 && (
        <div className="mt-1.5 flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto">
          <span className="shrink-0 text-ios-caption2 text-foreground/35">已锁定·未引用</span>
          {locked.map((entry) => (
            <ShotReferenceItem key={entry.key} entry={entry} />
          ))}
        </div>
      )}
      {unresolvedTokens.length > 0 && (
        <p className="mt-1.5 text-ios-caption2 text-ios-red">
          未匹配的引用：{unresolvedTokens.join(" ")}
        </p>
      )}
    </div>
  );
}

