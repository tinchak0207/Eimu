// 赏阅的评审层：标记 → 精确到位置的一段话 → 回流给助理。纯函式 + 本地存储，零 React。
// 各种类的 adapter 只负责「此刻指在哪」（Locator），其余（标签、措辞、存取、合成）全在这里，
// 这样音/视/图/文/3D 的反馈长得一样，助理只需要学会读一种格式。

import type { Annotation, Locator, TagDef, ViewAsset, ViewKind } from "./types";

const BEST: TagDef = { id: "best", label: "这段最好", say: "这里很好，保留不要动", good: true };

export const TAGS_BY_KIND: Record<ViewKind, readonly TagDef[]> = {
  audio: [
    { id: "loud", label: "太吵", say: "配器太吵，盖住了人声" },
    { id: "vocal", label: "人声小", say: "人声太小或太闷" },
    { id: "tempo", label: "节奏不对", say: "节奏不对（太快或太慢）" },
    { id: "mood", label: "情绪不对", say: "情绪不对" },
    { id: "lyric", label: "词不顺", say: "这句词不顺，想改" },
    { id: "pron", label: "咬字不准", say: "咬字或发音不准" },
    BEST,
  ],
  video: [
    { id: "jitter", label: "画面抖动", say: "画面抖动或闪烁" },
    { id: "identity", label: "人物崩坏", say: "人物外观前后不一致或变形" },
    { id: "lip", label: "口型不对", say: "口型和声音对不上" },
    { id: "camera", label: "运镜不对", say: "运镜不对" },
    { id: "pace", label: "节奏拖", say: "节奏拖沓或太赶" },
    { id: "cut", label: "转场生硬", say: "转场生硬" },
    BEST,
  ],
  image: [
    { id: "subject", label: "主体崩坏", say: "主体变形或结构错误" },
    { id: "hand", label: "手部异常", say: "手或肢体异常" },
    { id: "text", label: "文字错", say: "画面里的文字错误或乱码" },
    { id: "comp", label: "构图不对", say: "构图不对" },
    { id: "tone", label: "色调不对", say: "色调或光线不对" },
    { id: "blur", label: "细节糊", say: "细节糊，需要更清晰" },
    BEST,
  ],
  text: [
    { id: "long", label: "太长", say: "太长，需要精简" },
    { id: "tone", label: "语气不对", say: "语气不对" },
    { id: "fact", label: "事实有误", say: "事实有误" },
    { id: "wording", label: "措辞不顺", say: "措辞不顺" },
    BEST,
  ],
  scene3d: [
    { id: "scale", label: "比例不对", say: "比例不对" },
    { id: "clip", label: "穿模", say: "物体穿模或重叠" },
    { id: "view", label: "视角不对", say: "视角不对" },
    { id: "material", label: "材质不对", say: "材质或光照不对" },
    BEST,
  ],
  document: [
    { id: "layout", label: "排版问题", say: "排版有问题" },
    { id: "content", label: "内容不对", say: "内容不对或缺失" },
    { id: "typo", label: "错字", say: "有错字" },
    BEST,
  ],
  storyboard: [
    { id: "order", label: "顺序不对", say: "镜头顺序不对" },
    { id: "shot", label: "这镜不行", say: "这一镜需要重做" },
    { id: "continuity", label: "不连贯", say: "前后镜不连贯" },
    BEST,
  ],
  collection: [
    { id: "pick", label: "只留这件", say: "只保留这一件" },
    { id: "drop", label: "不要这件", say: "不要这一件" },
    BEST,
  ],
};

export function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;

/** 把定位器说成人话（也是助理读到的那一段）。 */
export function describeLocator(loc: Locator): string {
  switch (loc.t) {
    case "time":
      return loc.b != null && loc.b - loc.a > 0.8 ? `${mmss(loc.a)}–${mmss(loc.b)}` : mmss(loc.a);
    case "region": {
      const where = `画面 (${pct(loc.x)},${pct(loc.y)}) 起 ${pct(loc.w)}×${pct(loc.h)}`;
      return loc.frameT != null ? `${mmss(loc.frameT)} 处${where}` : where;
    }
    case "page":
      return `第 ${loc.n} 页`;
    case "pose":
      return `视角 位置(${loc.pos.map((n) => n.toFixed(1)).join(",")}) 看向(${loc.target.map((n) => n.toFixed(1)).join(",")})`;
    case "span":
      return `第 ${loc.from + 1}–${loc.to} 字`;
    case "whole":
      return "整体";
  }
}

export function tagDefsFor(kind: ViewKind, ids: readonly string[]): TagDef[] {
  const table = TAGS_BY_KIND[kind];
  return ids.map((id) => table.find((t) => t.id === id)).filter((t): t is TagDef => !!t);
}

const KIND_NOUN: Record<ViewKind, string> = {
  audio: "听感",
  video: "观感",
  image: "观感",
  text: "阅读",
  scene3d: "场景",
  document: "文档",
  storyboard: "分镜",
  collection: "合集",
};

/** 单件成品的反馈文本。位置在前、原因在后；助理逐处改，没提到的保持不变。 */
export function composeFeedback(asset: ViewAsset, annotations: readonly Annotation[]): string {
  const sorted = [...annotations].sort(locatorOrder);
  const title = asset.title?.trim() || "未命名";
  const lines = [`《${title}》${KIND_NOUN[asset.kind]}反馈（共 ${sorted.length} 处）：`];
  sorted.forEach((a, i) => {
    const reasons = [...tagDefsFor(asset.kind, a.tags).map((t) => t.say), ...(a.note?.trim() ? [a.note.trim()] : [])];
    lines.push(
      `${i + 1}. ${describeLocator(a.locator)}${a.excerpt ? `「${a.excerpt}」` : ""}：${reasons.join("；") || "请重点看这里"}`,
    );
  });
  lines.push("请只针对以上标记的位置调整，没提到的部分保持不变。");
  return lines.join("\n");
}

function locatorKey(l: Locator): number {
  switch (l.t) {
    case "time":
      return l.a;
    case "region":
      return l.frameT ?? l.y * 1000 + l.x;
    case "page":
      return l.n;
    case "span":
      return l.from;
    default:
      return 0;
  }
}
export function locatorOrder(a: Annotation, b: Annotation): number {
  return locatorKey(a.locator) - locatorKey(b.locator) || a.at - b.at;
}

/* ---------- 本地存取（按成品 id；服务端同步是后话，接口已留好） ---------- */

const PREFIX = "eimu-viewer:marks:";

export function loadAnnotations(assetId: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): Annotation[] {
  if (!storage) return [];
  try {
    const arr = JSON.parse(storage.getItem(PREFIX + assetId) ?? "[]");
    return Array.isArray(arr) ? (arr as Annotation[]).filter((a) => a && a.assetId === assetId && a.locator).sort(locatorOrder) : [];
  } catch {
    return [];
  }
}

export function saveAnnotations(
  assetId: string,
  list: readonly Annotation[],
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    if (list.length) storage.setItem(PREFIX + assetId, JSON.stringify(list));
    else storage.removeItem(PREFIX + assetId);
  } catch {
    /* 配额/隐私模式：标记只在内存里，不影响查看 */
  }
}

export function newAnnotation(assetId: string, locator: Locator, tags: string[], note?: string, excerpt?: string): Annotation {
  return {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    assetId,
    locator,
    tags,
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(excerpt ? { excerpt } : {}),
    at: Date.now(),
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
