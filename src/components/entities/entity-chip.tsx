"use client";

// 行內實體膠囊（`@[角色:灰羽]` 的視覺化）——「看得見的實體封裝」。
//
// 為什麼要有這一層：`@[種類:名稱]` 是提示詞裡的**實體引用**，但先前在前端一律渲染成
// 純文字，使用者看到的是「一串符號」而不是「引用了哪張卡」。這裡把它畫成一顆膠囊：
// **最左邊永遠有一格微縮圖**（有參考圖就放圖、沒有就放該種類的圖示佔位），
// 右邊依序是種類字與卡名——一眼看得出「這一段指名的是一個實體」。
//
// 契約（與 src/lib/entity-tokens.ts 同一份語義，禁在此另立第二套解析）：
//   - 命中卡庫 → 膠囊 + 該卡第一張參考圖的微縮圖
//   - 未命中   → 膠囊但**虛線紅框**（誠實標示「這張卡不存在」），原文照樣顯示，不吞內容
//   - 卡庫未載入/未登入 → 種類圖示佔位（**寬度與有圖時相同，零 layout shift**）
//
// 純展示：不改提示詞內容、不寫入任何狀態。

import { useEffect, useState } from "react";
import { AudioLines, Box, HelpCircle, Mountain, Palette, UserRound } from "lucide-react";
import { listCharacterCards } from "@/lib/character-card-client";
import { CHARACTER_CARD_KIND_LABEL, type CharacterCard, type CharacterCardKind } from "@/lib/character-cards";
import { parseEntityTokens, resolveEntityTokenKind } from "@/lib/entity-tokens";
import { cn } from "@/lib/utils";

// ─────────────────────────── 卡庫索引（模組級一次載入，跨元件共用）

let cardIndexPromise: Promise<Map<string, CharacterCard>> | null = null;

function indexKey(kind: CharacterCardKind, name: string): string {
  return `${kind}\u0000${name.trim()}`;
}

/**
 * 卡庫索引：`kind|name` → 卡。整頁只載一次（promise 去重），失敗靜默降級成空索引——
 * 卡是「順手引用」的增強，載不到不該讓聊天或畫布壞掉。
 */
function loadCardIndex(): Promise<Map<string, CharacterCard>> {
  if (!cardIndexPromise) {
    cardIndexPromise = (async () => {
      const res = await listCharacterCards();
      const map = new Map<string, CharacterCard>();
      // CanvasClientResult 的 ok 不是 discriminated union：成功分支仍要自證 data 存在。
      const cards = res.ok ? res.data : undefined;
      if (cards) for (const card of cards) map.set(indexKey(card.kind, card.name), card);
      return map;
    })().catch(() => new Map<string, CharacterCard>());
  }
  return cardIndexPromise;
}

/** 訂閱卡庫索引（首次載入後全樹共用同一份 map）。 */
function useEntityCardIndex(): Map<string, CharacterCard> {
  const [index, setIndex] = useState<Map<string, CharacterCard>>(() => new Map());
  useEffect(() => {
    let alive = true;
    void loadCardIndex().then((map) => {
      if (alive) setIndex(map);
    });
    return () => {
      alive = false;
    };
  }, []);
  return index;
}

/** 卡庫變動後（存卡/刪卡）呼叫，讓下次渲染重載——不強制即刻重繪既有膠囊。 */
export function invalidateEntityCardIndex(): void {
  cardIndexPromise = null;
}

// ─────────────────────────── 種類視覺（左側那一格）

const KIND_ICON: Record<CharacterCardKind, typeof UserRound> = {
  character: UserRound,
  scene: Mountain,
  style: Palette,
  prop: Box,
  audio: AudioLines,
};

/** 種類色票取自設計系統既有 ios.* token，不引入新色板。 */
const KIND_TINT: Record<CharacterCardKind, string> = {
  character: "bg-ios-purple/15 text-ios-purple",
  scene: "bg-ios-teal/20 text-[#1F86B8]",
  style: "bg-ios-indigo/15 text-ios-indigo",
  prop: "bg-ios-orange/15 text-[#B26A00]",
  audio: "bg-ios-green/15 text-[#248A3D]",
};

/**
 * 膠囊最左邊的微縮圖格（固定尺寸，永遠佔位）。
 * 有該卡的參考圖 → 縮圖；否則 → 種類圖示（色調玻璃底）。
 */
function EntityThumb({
  kind,
  name,
  previewUrl,
  unresolved,
}: {
  kind: CharacterCardKind | null;
  name: string;
  previewUrl?: string;
  unresolved: boolean;
}) {
  const box = "h-[16px] w-[16px] shrink-0 rounded-[5px] ring-1 ring-white/70";
  if (previewUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 平台直鏈域名不定，next/image 不適用
      <img src={previewUrl} alt="" aria-hidden="true" className={cn(box, "object-cover")} draggable={false} />
    );
  }
  const Icon = unresolved || !kind ? HelpCircle : KIND_ICON[kind];
  return (
    <span
      aria-hidden="true"
      className={cn(box, "inline-flex items-center justify-center", unresolved || !kind ? "bg-ios-red/12 text-ios-red/70" : KIND_TINT[kind])}
    >
      <Icon className="h-[11px] w-[11px]" strokeWidth={2.2} />
    </span>
  );
}

// ─────────────────────────── 膠囊本體

export interface EntityChipProps {
  /** token 裡的種類字（未正規化，如「角色」）。 */
  kindLabel: string;
  name: string;
  className?: string;
}

/**
 * 一顆實體引用膠囊。種類字不合法或卡庫查無此卡時走「未命中」樣式（虛線紅框）——
 * 與後端 fail-open 契約一致：**原文不吞、狀態不騙**。
 */
export function EntityChip({ kindLabel, name, className }: EntityChipProps) {
  const index = useEntityCardIndex();
  const kind = resolveEntityTokenKind(kindLabel);
  const card = kind ? index.get(indexKey(kind, name.trim())) : undefined;
  const unresolved = !card;
  const label = kind ? CHARACTER_CARD_KIND_LABEL[kind] : kindLabel.trim();
  const previewUrl = card?.references?.[0]?.url;

  return (
    <span
      title={
        card
          ? `实体引用：${label}「${name}」已锁定，生成时自动展开它的描述与参考图`
          : `未找到实体卡：${label}「${name}」——提示词会保留原样`
      }
      className={cn(
        "lg-float mx-[1px] inline-flex max-w-[200px] items-center gap-1 rounded-full px-1.5 py-[1px] align-[-3px]",
        "text-[12.5px] leading-[1.5]",
        unresolved && "border-dashed border-ios-red/35",
        className,
      )}
    >
      <EntityThumb kind={kind} name={name} previewUrl={previewUrl} unresolved={unresolved} />
      <span className={cn("shrink-0 text-[11px] font-medium", unresolved ? "text-ios-red/65" : "text-foreground/45")}>{label}</span>
      <span className={cn("truncate font-medium", unresolved ? "text-ios-red/80" : "text-foreground")}>{name}</span>
    </span>
  );
}

// ─────────────────────────── 把一段純文字裡的 token 變成膠囊

/**
 * 把文字裡的 `@[種類:名稱]` 就地換成膠囊，其餘照原樣輸出。
 *
 * 零 token → **原字串直接回**（不包 span、不改空白，逐位元不變）。
 * 供聊天氣泡與畫布節點正文共用——兩個表面同一套渲染，禁各寫一份。
 */
export function EntityText({ text, className }: { text: string; className?: string }) {
  const hits = parseEntityTokens(text);
  if (hits.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.start > cursor) parts.push(text.slice(cursor, hit.start));
    parts.push(<EntityChip key={`${hit.start}-${i}`} kindLabel={hit.kindLabel} name={hit.name} />);
    cursor = hit.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <span className={className}>{parts}</span>;
}

/**
 * 一段文字裡引用到的實體（依首次出現序去重）。
 * 供節點卡標題左側的微縮圖堆疊使用——卡面「左邊有微縮圖」的那一格。
 */
export function entitiesInText(text: string): { kindLabel: string; name: string }[] {
  const seen = new Set<string>();
  const out: { kindLabel: string; name: string }[] = [];
  for (const hit of parseEntityTokens(text)) {
    const key = `${hit.kindLabel}\u0000${hit.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kindLabel: hit.kindLabel, name: hit.name });
  }
  return out;
}

/**
 * 節點卡標題左側的微縮圖堆疊（最多 3 格，超出以 +N 收尾）。
 *
 * 這是「別人的卡片最左邊有微縮圖」那一格：卡片一旦引用了實體，卡面左緣就長出
 * 該實體的微縮圖——不必點開提示詞也知道這張卡在講誰。
 */
export function EntityThumbStack({ entities, className }: { entities: { kindLabel: string; name: string }[]; className?: string }) {
  const index = useEntityCardIndex();
  if (entities.length === 0) return null;
  const shown = entities.slice(0, 3);
  const rest = entities.length - shown.length;

  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} title={entities.map((e) => e.name).join("、")}>
      {shown.map((entity, i) => {
        const kind = resolveEntityTokenKind(entity.kindLabel);
        const card = kind ? index.get(indexKey(kind, entity.name.trim())) : undefined;
        const previewUrl = card?.references?.[0]?.url;
        return (
          <span
            key={`${entity.name}-${i}`}
            className={cn(
              "inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-[6px]",
              "bg-white/70 ring-1 ring-white/85",
              i > 0 && "-ml-[5px]",
            )}
          >
            <EntityThumb kind={kind} name={entity.name} previewUrl={previewUrl} unresolved={!card} />
          </span>
        );
      })}
      {rest > 0 ? <span className="ml-1 text-[10.5px] font-medium text-foreground/45">+{rest}</span> : null}
    </span>
  );
}
