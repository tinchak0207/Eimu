// 历史记录 → 资产卡锚点（纯函式）：把一条历史记录的图锚定成 character-card。
//
// 只做增量：卡的最终清洗仍走 normalizeCharacterCard（character-cards.ts 是唯一
// 资产 owner，这里不建第二套资产系统，只负责从 HistoryEntry 构造 payload）。
// 消费端：src/components/history/SaveCardDialog.tsx（历史页「存为角色卡」动作）。
//
// 同档另提供 assetPackPayloadFromHistoryEntry：历史 → 资产包 payload（存为资产），
// 消费端：src/components/history/HistoryCard.tsx（PUT /api/assets，upsert by
// 确定性 id `history-${entry.id}`）。
import { toReferenceImageRole } from "./image-types";
import type { ReferenceImageRole } from "./image-types";
import { CHARACTER_CARD_KIND_LABEL, toCharacterCardKind } from "./character-cards";
import type { CharacterCard, CharacterCardKind } from "./character-cards";
import type { AssetPackItem, AssetPackItemKind } from "./asset-pack-store";
import type { HistoryEntry } from "./history-types";
import { historyEntryHandles, lineageTimestamp } from "./lineage";
import type { LineageLink } from "./lineage";
// 交付物种类真源（./deliverable-kind，零依赖，可安全进 client bundle）：
// 历史 → 资产库的代表媒体种类与 URL 栏位全由注册表推导。
import {
  assetItemKindOf,
  assetUrlFieldOf,
  deliverableKindLabel,
  deliverableKindOfResult,
  deliverableKindSpec,
} from "./deliverable-kind";
import type { DeliverableKind } from "./deliverable-kind";

const MAX_ANCHOR_NAME_LENGTH = 100;
/**
 * 资产 item 标题上限：与 asset-pack-store.MAX_TITLE_LENGTH 同界。
 * 该档含 node 依赖（node:crypto / blob-backend），本档被 client 元件（SaveCardDialog /
 * HistoryCard）import，不可 runtime import 取常数，故照抄同一数值并由 normalizeAssetPack 兜底。
 */
const MAX_ITEM_TITLE_LENGTH = 200;

/** 与站内一致的可用图 URL 判定（http(s) 与 data:image）。 */
function isUsableImageUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:image/");
}

/** 可用产物 URL 判定（公网 http(s) 或 data:）——影片/音乐/图片代表产物共用这把尺。 */
function isUsableMediaUrl(url: string): boolean {
  return url.startsWith("http") || url.startsWith("data:");
}

/**
 * 取历史记录的锚定图 URL：任何结果里有可用公网 imageUrl 就用它（可持久、体积小），
 * 全都没有才由 base64 组 data URL 兜底（本地缓存记录）。
 */
export function anchorImageUrlOf(entry: HistoryEntry): string | null {
  for (const result of entry.results) {
    if (result.imageUrl && isUsableImageUrl(result.imageUrl)) return result.imageUrl;
  }
  for (const result of entry.results) {
    if (result.image && typeof result.image === "string") {
      const dataUrl = result.image.startsWith("data:image/") ? result.image : `data:image/png;base64,${result.image}`;
      if (isUsableImageUrl(dataUrl)) return dataUrl;
    }
  }
  return null;
}

/** 历史记录的代表交付物：种类（交付物注册表）＋ 该种类的产物 URL。 */
export interface AnchoredDeliverable {
  kind: DeliverableKind;
  url: string;
}

/**
 * 取历史记录的「代表产物」（种类 + URL）——anchorImageUrlOf 的兄弟函式。
 *
 * 逐 result 由 deliverableKindOfResult 推种类，再按 deliverableKindSpec(kind).resultField
 * 取对应 URL（不再只认 image/imageUrl），因此影片/音乐历史条目也能取得代表产物。
 * 取不到可用 URL 回 null。
 *
 * 为何不直接改 anchorImageUrlOf：后者语义是「锚定图」（imageUrl 优先、base64 兜底），
 * 仍被 cardFromHistoryEntry（存为角色卡）等既有消费者使用，故保留原语义不动。
 */
export function anchorDeliverableOf(entry: HistoryEntry): AnchoredDeliverable | null {
  for (const result of entry.results) {
    const kind = deliverableKindOfResult(result);
    if (!kind) continue;
    const raw = result[deliverableKindSpec(kind).resultField];
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (url && isUsableMediaUrl(url)) return { kind, url };
  }
  return null;
}

/** 卡种类 → 参考图角色：style/character 有同名的 ReferenceImageRole，scene 无对应角色收敛 general。 */
function anchorRoleOf(kind: CharacterCardKind): ReferenceImageRole {
  return toReferenceImageRole(kind === "scene" ? "general" : kind);
}

/**
 * 从历史记录构造一张「纯参考图卡」：
 *   - 名称必填（trim 后非空，上限 100 与 normalizeCharacterCard 一致）
 *   - 图取第一张可用结果（无图记录（计费日志等）返回 null，不建空卡）
 *   - locked prompt 为空（可在卡面板事后补描述），kind 未知值收敛 character
 */
export function cardFromHistoryEntry(
  entry: HistoryEntry,
  kind: unknown,
  name: string,
): CharacterCard | null {
  const url = anchorImageUrlOf(entry);
  if (!url) return null;
  const cleanName = typeof name === "string" ? name.trim().slice(0, MAX_ANCHOR_NAME_LENGTH) : "";
  if (!cleanName) return null;
  const safeKind = toCharacterCardKind(kind);
  const now = new Date().toISOString();
  const card: CharacterCard = {
    id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleanName,
    kind: safeKind,
    prompt: "",
    references: [{ url, role: anchorRoleOf(safeKind), name: cleanName }],
    createdAt: now,
    updatedAt: now,
  };
  // REQ-D1 挂钩 b：「存为卡片」把来源历史记录登记成卡的 lineage（derivation）。
  // 只落卡本体（裁决②：不进 canvas、不进 agent 白名单）。缺 taskId 的同步直出
  // 记录用历史把手 `history-${entry.id}` 作 assetId（与「存为资产」惯例同键）。
  const handles = historyEntryHandles(entry);
  const at = lineageTimestamp(entry.generatedAt);
  const link: LineageLink = handles.jobId
    ? { kind: "derivation", jobId: handles.jobId, at }
    : { kind: "derivation", assetId: handles.assetIds[0], at };
  card.lineage = [link];
  return card;
}

/** 统一的结果文案（对话框与 toast 共用）。 */
export function anchorSuccessMessage(card: CharacterCard): string {
  return `已存为${CHARACTER_CARD_KIND_LABEL[card.kind]}卡：${card.name}`;
}

// ─────────────────────────────── 历史 → 资产包（存为资产）───────────────────────────

/** 资产包标题后缀的日期格式：YYYY-MM-DD（本地时区，供「历史资产 ${日期}」兜底）。 */
function assetTitleDateLabel(generatedAt: number): string {
  const d = new Date(generatedAt);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 历史条目顶层可能带的 lora 栏位（HistoryEntry 型别未宣告，采防御读取）。 */
interface HistoryEntryLoraCarrier extends HistoryEntry {
  loraModelVersionIds?: unknown;
  lora?: unknown;
}

/** 从历史条目取 loraVersionId：loraModelVersionIds 阵列取第一个字串，或 lora 物件的 versionId。 */
function loraVersionIdOf(entry: HistoryEntry): string | null {
  const carrier = entry as HistoryEntryLoraCarrier;
  if (Array.isArray(carrier.loraModelVersionIds)) {
    const first = carrier.loraModelVersionIds.find((v): v is string => typeof v === "string" && Boolean(v.trim()));
    if (first) return first.trim();
  }
  if (carrier.lora && typeof carrier.lora === "object") {
    const lora = carrier.lora as { versionId?: unknown; modelVersionId?: unknown };
    const v = lora.versionId ?? lora.modelVersionId;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * 从历史记录构造「资产包 payload」（存为资产）：历史 → /api/assets 的 upsert 主体。
 * 与 cardFromHistoryEntry 用同一套历史取数，但代表产物改由交付物注册表推导：
 *  - 有 prompt → 存 prompt item（带 modelId/size/首图 URL，既有语义不变）
 *  - 代表交付物（image/video/audio，由 anchorDeliverableOf 推）→ 存对应 kind 的
 *    媒体 item：image 收 imageUrl、video/audio 收 mediaUrl（种类与栏位皆由注册表推导）
 *  - 条目顶层带 loraModelVersionIds/lora → 加 lora item（无则省略）
 *  - 无 id、或既无 prompt 又无代表产物 → 回 null（不建空包，计费日志即此类）
 * 消费端：HistoryCard「存为资产」按钮，upsert by 确定性 id `history-${entry.id}`。
 */
export function assetPackPayloadFromHistoryEntry(
  entry: HistoryEntry,
): { title: string; items: AssetPackItem[] } | null {
  if (!entry || typeof entry.id !== "string" || !entry.id.trim()) return null;

  const imageUrl = anchorImageUrlOf(entry);
  const anchor = anchorDeliverableOf(entry);
  const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
  const modelId = entry.results?.[0]?.modelId;
  const size = entry.workflow?.imageSize;
  const loraVersionId = loraVersionIdOf(entry);
  const source = { type: "history" as const, id: entry.id };

  const items: AssetPackItem[] = [];
  if (prompt) {
    items.push({
      kind: "prompt",
      title: "生成提示词",
      content: prompt,
      ...(modelId ? { modelId } : {}),
      ...(size ? { size } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      source,
    });
  }
  // 代表媒体 item：种类与 URL 栏位全由交付物注册表推导
  // （image → {kind:"image", imageUrl}；video/audio → {kind, mediaUrl}）。
  // title 用 prompt 截断；prompt 为空时用「种类文案 + 真实生成时间」，不编造内容。
  if (anchor) {
    const title = prompt
      ? prompt.slice(0, MAX_ITEM_TITLE_LENGTH)
      : `${deliverableKindLabel(anchor.kind)} ${new Date(entry.generatedAt).toLocaleString("zh-CN")}`;
    const urlField = assetUrlFieldOf(anchor.kind);
    items.push({
      kind: assetItemKindOf(anchor.kind) as AssetPackItemKind,
      title,
      ...(urlField === "imageUrl" ? { imageUrl: anchor.url } : { mediaUrl: anchor.url }),
      source,
    });
  }
  if (loraVersionId) {
    items.push({ kind: "lora", title: "LoRA", loraVersionId, source });
  }
  if (!items.length) return null;

  return {
    title: `历史资产 ${assetTitleDateLabel(entry.generatedAt)}`,
    items,
  };
}
