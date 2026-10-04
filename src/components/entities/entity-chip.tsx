"use client";

// 行内实体胶囊（`@[角色:灰羽]` 的视觉化）——「看得见的实体封装」。
//
// 为什么要有这一层：`@[种类:名称]` 是提示词里的**实体引用**，但先前在前端一律渲染成
// 纯文字，使用者看到的是「一串符号」而不是「引用了哪张卡」。这里把它画成一颗胶囊：
// **最左边永远有一格微缩图**（有参考图就放图、没有就放该种类的图示占位），
// 右边依序是种类字与卡名——一眼看得出「这一段指名的是一个实体」。
//
// 契约（与 src/lib/entity-tokens.ts 同一份语义，禁在此另立第二套解析）：
//   - 命中卡库 → 胶囊 + 该卡第一张参考图的微缩图
//   - 未命中   → 胶囊但**虚线红框**（诚实标示「这张卡不存在」），原文照样显示，不吞内容
//   - 卡库未载入/未登入 → 种类图示占位（**宽度与有图时相同，零 layout shift**）
//
// 纯展示：不改提示词内容、不写入任何状态。

import { useEffect, useState } from "react";
import { AudioLines, Box, HelpCircle, Mountain, Palette, UserRound } from "lucide-react";
import { listCharacterCards } from "@/lib/character-card-client";
import { bumpCharacterCardIndexRevision, getCharacterCardIndexRevision } from "@/lib/character-card-index";
import { CHARACTER_CARD_KIND_LABEL, type CharacterCard, type CharacterCardKind } from "@/lib/character-cards";
import { parseEntityTokens, resolveEntityTokenKind } from "@/lib/entity-tokens";
import { cn } from "@/lib/utils";

// ─────────────────────────── 卡库索引（模组级一次载入，跨元件共用）

// 带修订号的快取：号码与资料层现值不同 = 快取过期，重载。
// 呼叫端不必记得失效——资料层存/删成功后自动发号，这里凭号码判断。
let cardIndexCache: { revision: number; promise: Promise<Map<string, CharacterCard>> } | null = null;

function indexKey(kind: CharacterCardKind, name: string): string {
  return `${kind}\u0000${name.trim()}`;
}

/**
 * 卡库索引：`kind|name` → 卡。整页只载一次（promise 去重），失败静默降级成空索引——
 * 卡是「顺手引用」的增强，载不到不该让聊天或画布坏掉。
 * 快取连同当下的修订号一起记下；号码变了（资料层存/删过卡）就重新发请求。
 */
function loadCardIndex(): Promise<Map<string, CharacterCard>> {
  const revision = getCharacterCardIndexRevision();
  const cached = cardIndexCache;
  if (cached && cached.revision === revision) return cached.promise;

  const attempt = (async () => {
    const res = await listCharacterCards();
    const cards = res.ok ? res.data : undefined;
    // CanvasClientResult 的 ok 不是 discriminated union：成功分支仍要自证 data 存在。
    if (!cards) throw new Error("card_index_unavailable");
    const map = new Map<string, CharacterCard>();
    for (const card of cards) map.set(indexKey(card.kind, card.name), card);
    return map;
  })();

  const promise = attempt.catch(() => new Map<string, CharacterCard>());
  // 先同步赋值（在任何 await 之前），保留「同一 tick 多颗胶囊只发一次请求」的同步去重。
  cardIndexCache = { revision, promise };
  // 失败（未登入／网路／伺服器）不留在快取：留著的话，空索引会连同当前修订号被锁死，
  // 扫码登入这种「不换页就换身分」的路径会一路显示未找到，直到存/删卡或整页重载。
  // attempt 与 promise 各自挂 handler：attempt 的 rejection 由 promise 消化，故不会 unhandled。
  void attempt.catch(() => {
    if (cardIndexCache?.promise === promise) cardIndexCache = null;
  });
  return promise;
}

/** 订阅卡库索引（首次载入后全树共用同一份 map）。 */
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

/**
 * 强制下次载入重取卡库索引（不强制即刻重绘既有胶囊）。
 *
 * 资料层（character-card-client）存/删成功后已会自动发号，展示层凭号码判定过期，
 * 一般呼叫端因此不必再手动失效；这个名字只保留给「需要立刻作废目前快取」的场合。
 */
export function invalidateEntityCardIndex(): void {
  bumpCharacterCardIndexRevision();
}

// ─────────────────────────── 种类视觉（左侧那一格）

const KIND_ICON: Record<CharacterCardKind, typeof UserRound> = {
  character: UserRound,
  scene: Mountain,
  style: Palette,
  prop: Box,
  audio: AudioLines,
};

/** 种类色票取自设计系统既有 ios.* token，不引入新色板。 */
const KIND_TINT: Record<CharacterCardKind, string> = {
  character: "bg-ios-purple/15 text-ios-purple",
  scene: "bg-ios-teal/20 text-[#1F86B8]",
  style: "bg-ios-indigo/15 text-ios-indigo",
  prop: "bg-ios-orange/15 text-[#B26A00]",
  audio: "bg-ios-green/15 text-[#248A3D]",
};

/**
 * 胶囊最左边的微缩图格（固定尺寸，永远占位）。
 * 有该卡的参考图 → 缩图；否则 → 种类图示（色调玻璃底）。
 */
function EntityThumb({
  kind,
  name: _name,
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
      // eslint-disable-next-line @next/next/no-img-element -- 平台直链域名不定，next/image 不适用
      <img src={previewUrl} alt="" aria-hidden="true" className={cn(box, "object-cover")} draggable={false} />
    );
  }
  const Icon = unresolved || !kind ? HelpCircle : KIND_ICON[kind];
  return (
    <span
      aria-hidden="true"
      className={cn(box, "inline-flex items-center justify-center", unresolved || !kind ? "bg-ios-red/[0.12] text-ios-red/70" : KIND_TINT[kind])}
    >
      <Icon className="h-[11px] w-[11px]" strokeWidth={2.2} />
    </span>
  );
}

// ─────────────────────────── 胶囊本体

export interface EntityChipProps {
  /** token 里的种类字（未正规化，如「角色」）。 */
  kindLabel: string;
  name: string;
  className?: string;
}

/**
 * 一颗实体引用胶囊。种类字不合法或卡库查无此卡时走「未命中」样式（虚线红框）——
 * 与后端 fail-open 契约一致：**原文不吞、状态不骗**。
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
        "text-ios-caption1 leading-[1.5]",
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

// ─────────────────────────── 把一段纯文字里的 token 变成胶囊

/**
 * 把文字里的 `@[种类:名称]` 就地换成胶囊，其余照原样输出。
 *
 * 零 token → **原字串直接回**（不包 span、不改空白，逐位元不变）。
 * 供聊天气泡与画布节点正文共用——两个表面同一套渲染，禁各写一份。
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
 * 一段文字里引用到的实体（依首次出现序去重）。
 * 供节点卡标题左侧的微缩图堆叠使用——卡面「左边有微缩图」的那一格。
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
 * 节点卡标题左侧的微缩图堆叠（最多 3 格，超出以 +N 收尾）。
 *
 * 这是「别人的卡片最左边有微缩图」那一格：卡片一旦引用了实体，卡面左缘就长出
 * 该实体的微缩图——不必点开提示词也知道这张卡在讲谁。
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
      {rest > 0 ? <span className="ml-1 text-ios-caption2 font-medium text-foreground/45">+{rest}</span> : null}
    </span>
  );
}
