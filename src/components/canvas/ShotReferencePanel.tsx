"use client";

// ShotReferencePanel —— 「本镜参考素材」解析清单（生成前看得见本镜实际带上的参考素材）。
//
// 定位：卡是项目级「锁定配置」，token 是正文里的「逐处引用」。本元件把两者摊在同一块：
//   - source "token"：正文用 @ 就地引用的卡（本镜真正点名的实体）
//   - source "shot"：本镜**已指定**的卡（来源＝节点 metadata 的卡 id 栏，非行内引用）
//   - source "locked"：项目锁定、但本镜没行内引用的卡（低对比灰——一眼看出漏引）
//   - unresolvedTokens：解析不到对应卡的 token 原文（红字警示，**不阻挡生成**——
//     与 entity-tokens 的 fail-open 语义一致：未命中就原样留在 prompt 里）
//
// 纯展示：零 API、零 hook 副作用。条目与未解析清单由宿主用下列纯函式推导（useMemo），
// 本档不读 DOM、不发请求、不订阅。

import type { CharacterCardKind } from "@/lib/character-cards";
import { parseEntityTokens, resolveEntityTokenKind, serializeEntityToken } from "@/lib/entity-tokens";
import { cn } from "@/lib/utils";

export interface ShotReferenceEntry {
  key: string;
  kindLabel: string; // 角色/场景/风格/道具
  name: string;
  previewUrl?: string;
  /** token = 行内 @ 引用；shot = 本镜已指定（metadata 卡 id 栏）；locked = 项目锁定但本镜没引用。 */
  source: "token" | "locked" | "shot";
}

export interface ShotReferencePanelProps {
  entries: ShotReferenceEntry[];
  /** 正文里无法解析的 token 原文（红字警示，不阻挡生成）。 */
  unresolvedTokens?: string[];
}

/**
 * 推导用的候选卡形状——与 CanvasNodePromptPanel 的 `CanvasEntityCandidate` 同构。
 * 本档刻意不回向 import 面板（避免元件互相 import 成环），改吃结构相容的窄型别。
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
 * 纯推导：正文 token × 可用候选卡 → 本镜参考素材条目 + 未解析 token。
 *
 * 语义：
 *   - token 命中（种类字可解析且同名同 kind 的卡在候选内）→ 一条 source "token"；
 *     同一张卡被引用多次只列一条（首次出现序）。
 *   - 候选卡未被任何 token 引用 → 一条 source "locked"（候选原序，排在 token 段之后）。
 *   - token 未命中（种类字未知 / 候选里没这张卡）→ 原始字串进 unresolvedTokens（去重）。
 *   - 纯函式：不改输入。
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

/** 纯分组：条目按来源分三段（token → shot → locked，locked 永远垫底）。 */
export function groupShotReferenceEntries(
  entries: readonly ShotReferenceEntry[],
): { token: ShotReferenceEntry[]; locked: ShotReferenceEntry[]; shot: ShotReferenceEntry[] } {
  return {
    token: entries.filter((entry) => entry.source === "token"),
    locked: entries.filter((entry) => entry.source === "locked"),
    shot: entries.filter((entry) => entry.source === "shot"),
  };
}

// ─────────────────────────── @ 选单候选列（纯逻辑，DOM 无关）

/** @ 选单的摊平列：两组候选共用同一个连续索引序列（↑↓ 跨组导航）。 */
export interface MentionRow {
  /** 摊平后的连续索引（跨组），键盘导航吃这个。 */
  index: number;
  group: "image" | "entity";
  /** 在该组候选阵列中的下标（消费端用它取回原候选物件）。 */
  sourceIndex: number;
}

/**
 * 纯函式：把两组候选摊平成一列（图片组在前、素材卡组在后），并套用 query 过滤。
 *
 * 语义：
 *   - 过滤对两组都生效：图片比标题、素材卡比名称（lowercase includes）。
 *   - 空 query（含纯空白）＝不过滤，顺序即「图片组在前、素材卡组在后」。
 *   - 某组为空 → 该组不出列（消费端据此不渲染组标题，零空组）。
 *   - 两组都没命中 → 回空阵列（消费端据此关闭选单，维持既有行为）。
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

// ─────────────────────────── chip 序列化分派（纯函式，吃假 dataset）

/** chip 序列化只看这几个 data-* 栏位（纯函式介面：测试可喂假物件）。 */
export interface ChipSerializationInput {
  /** data-node-id：上游图片 chip。 */
  nodeId?: string;
  /** data-card-id：素材卡 chip（有此栏即走 token 序列化）。 */
  cardId?: string;
  /** data-card-kind：卡 kind 原文（"scene" / "角色" 皆可解析）。 */
  cardKind?: string;
  /** data-title：显示／引用用的全名（未被 CHIP_TITLE_MAX 截断）。 */
  title?: string;
}

/**
 * 生成用 chip 序列化分派（纯函式）：
 *   - 带 `cardId` → `@[场景:雨夜街]`（种类字由 cardKind 正规化；认不出 → 角色）
 *   - 带 `nodeId` → `@图片N`（N = 在 selectedIds 的序号 + 1；不在清单则退回 `@标题`）
 * 分派靠 `cardId` 判定（不是 class）——素材卡 chip 不会被误编成 `@图片N`。
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
  // 灰阶 chip ＝「不是行内 @ 引用」的两种来源（locked 未引用 / shot 已指定），
  // 只有 token（本镜真正行内点名）走有色 chip。
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
 * 本镜参考素材清单（玻璃面板语汇沿用 CanvasNodePromptPanel 既有小卡片：
 * `border-t` 分隔 + `bg-black/5` 徽章 + `text-ios-caption2 text-foreground/45` 标题）。
 * 条目为空且无未解析 token → 整块不渲染（零空壳）。
 */
export function ShotReferencePanel({ entries, unresolvedTokens = [] }: ShotReferencePanelProps) {
  if (entries.length === 0 && unresolvedTokens.length === 0) return null;
  const { token, locked, shot } = groupShotReferenceEntries(entries);
  return (
    <div className="border-t px-3 py-2" data-shot-reference-panel>
      {/* 一行摘要（预设即可见）；条目区自身限高可卷，不撑高面板影响既有按钮列 */}
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

