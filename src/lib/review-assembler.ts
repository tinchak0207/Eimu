/**
 * 审查页单页组装器（纯函数）。
 *
 * 输入是 boards-store 的 SavedShotMeta 列表（见 src/lib/boards-store.ts，
 * 那是画布项目/镜头的唯一存储 owner，本模块不建第二存储、不碰 IndexedDB），
 * 输出可直接渲染的面板模型：每个 shot 一个 pane（id / 标题 / 元数据），
 * 外加导航分组与 hash 锚点 id（pane-<安全 slug>），供 /review 单页合成模式使用。
 */

import type { SavedShotMeta } from "./boards-store";

/** 标题截断长度（按码点计，超出加省略号）。 */
const TITLE_MAX_CODEPOINTS = 28;

export interface ReviewPaneMetadata {
  modelId?: string;
  endpointLabel?: string;
  presetLabel?: string;
  imageSize?: string;
}

export interface ReviewPane {
  /** 原始 shot id（取 blob / 后续操作用它，不用展示 slug）。 */
  shotId: string;
  /** hash 锚点 id：pane-<安全 slug>，保证唯一，可直接放进 URL。 */
  anchorId: string;
  /** 展示标题：优先既有 name，其次截断 prompt，兜底「未命名镜头」。 */
  title: string;
  starred: boolean;
  createdAt: number;
  metadata: ReviewPaneMetadata;
}

export interface ReviewSection {
  /** 分组 key（稳定 slug）。 */
  key: string;
  /** 分组展示名（本地日期 YYYY-MM-DD，无效时间归「未分组」）。 */
  label: string;
  panes: ReviewPane[];
}

/**
 * 把任意字符串压成可安全放进 URL hash 的 slug：
 * 仅保留 [a-z0-9-]，其余折叠为单个 "-"，去首尾 "-"，空结果兜底 "shot"。
 */
export function slugifyForAnchor(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "shot" : slug;
}

function truncateTitle(text: string): string {
  const chars = Array.from(text.trim());
  if (chars.length <= TITLE_MAX_CODEPOINTS) return chars.join("");
  return chars.slice(0, TITLE_MAX_CODEPOINTS).join("") + "…";
}

/** pane 标题：name > 截断 prompt > 兜底文案。 */
export function paneTitleFor(shot: Pick<SavedShotMeta, "name" | "prompt">): string {
  if (shot.name && shot.name.trim() !== "") return shot.name;
  if (shot.prompt && shot.prompt.trim() !== "") return truncateTitle(shot.prompt);
  return "未命名镜头";
}

/**
 * 组装审查面板：每个 shot 一个 pane，保持输入顺序。
 * anchorId 按 slug 化后的 shot id 生成，撞名时追加 -2/-3 保证唯一。
 */
export function composeReviewPanes(shots: SavedShotMeta[]): ReviewPane[] {
  const seen = new Map<string, number>();
  return shots.map((shot) => {
    const base = slugifyForAnchor(shot.id);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const anchorId = count === 0 ? "pane-" + base : "pane-" + base + "-" + (count + 1);
    return {
      shotId: shot.id,
      anchorId,
      title: paneTitleFor(shot),
      starred: shot.starred,
      createdAt: shot.createdAt,
      metadata: {
        modelId: shot.modelId,
        endpointLabel: shot.endpointLabel,
        presetLabel: shot.presetLabel,
        imageSize: shot.imageSize,
      },
    };
  });
}

function sectionLabelFor(timestamp: number): { key: string; label: string } | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const label = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  return { key: slugifyForAnchor(label), label };
}

/**
 * 导航分组：按 createdAt 的本地日期把 pane 归组，组按首次出现顺序排列。
 * 时间无效的 pane 归入「未分组」。空输入返回空数组。
 */
export function groupReviewSections(panes: ReviewPane[]): ReviewSection[] {
  const sections: ReviewSection[] = [];
  const byKey = new Map<string, ReviewSection>();
  for (const pane of panes) {
    const section = sectionLabelFor(pane.createdAt);
    const key = section ? section.key : "ungrouped";
    const label = section ? section.label : "未分组";
    let target = byKey.get(key);
    if (!target) {
      target = { key, label, panes: [] };
      byKey.set(key, target);
      sections.push(target);
    }
    target.panes.push(pane);
  }
  return sections;
}
