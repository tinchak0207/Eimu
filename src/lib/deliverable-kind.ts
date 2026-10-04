// 交付物种类的唯一真源（单一真源注册表）。
//
// 背景：在此之前「种类」在 repo 里有 5+ 份各写一份的清单——历史侧的
// HistoryEntryKind / HistoryResult.mediaType、模型侧的 MediaKind、
// 资产侧的 AssetPackItemKind，再加上 UI 的三份硬编（ENTRY_KIND_VALUES /
// HistoryEntryKindFilter / HistoryFilterBar 的 chips）。
// 新增一种交付物（例：音乐）＝要改 20 个地方，而且靠人脑保持同步。
//
// 本档把「交付物有哪些、各自叫什么、产物落哪个栏位、资产侧怎么承接、
// 能不能播、要不要给筛选 chip」收敛成 DELIVERABLE_KINDS 一张表；
// 其余各处（型别、UID 文案、历史推断、资产映射）全部由它推导。
// 之后新增一种交付物 ＝ 在这里加一行。
//
// 值域与模型 catalog 的 MediaKind（generation-model-catalog/types.ts）是**同一件事**：
// MediaKind 已改为由本档的 DeliverableKind 推导（`export type MediaKind = DeliverableKind`），
// 不再是平行宣告——新增交付物种类时两侧不会走钟，这是编译期事实而非注解声明。
// `workflow` 不是交付物（它是一次跑批记录），由历史侧单独以
// NON_DELIVERABLE_ENTRY_KINDS 承接，不进本表。
//
// 本档零依赖，可被任何层（lib / component / route）安全 import，不造成循环。
//
// 契约（detectPriority 必填）：历史侧 inferEntryKind 决定「一条 entry 的种类」时，
// 靠这里的 detectPriority 排优先序。新增一种交付物若忘了给 detectPriority，
// **编译不会通过**——这正是刻意的性质：优先序是种类注册的一部分，不是可选装饰。
// 少了它，新种类会在任何带媒体的 entry 上被静默判成旧种类（历史上就是 image）。

/** 交付物种类规格。新增一种交付物＝在 DELIVERABLE_KINDS 加一行，型别与各推导清单自动跟上。 */
export interface DeliverableKindSpec {
  /** 种类 id。也是 HistoryResult.mediaType 的值。 */
  id: string;
  /** 站点 UI 文案（简体，例：图片／视频／音乐）。 */
  label: string;
  /** HistoryResult 上承载该种类的栏位名（资产侧与历史侧共用同一语义）。 */
  resultField: "imageUrl" | "videoUrl" | "audioUrl";
  /** 资产包 item 的 kind（资产库承接同一种类）。 */
  assetItemKind: string;
  /** 资产包 item 上承载 URL 的栏位名。 */
  assetUrlField: "imageUrl" | "mediaUrl";
  /** 是否为可播放媒体（影片/音乐 true；图片 false）。 */
  playable: boolean;
  /** 历史页是否给种类筛选 chip。 */
  filterable: boolean;
  /**
   * 种类推断优先序（数字越小＝越优先；同值时以宣告序稳定排序）。
   *
   * inferEntryKind 一条 entry 同时带多种媒体时，取此序最前者。必填：
   * 新增种类漏填＝编译失败，不会再出现「新种类被静默判成 image」的破口。
   */
  detectPriority: number;
}

/**
 * 交付物种类真源（宣告序：image → video → audio）。
 *
 * `audio` 的 label 刻意用「音乐」——站内既有口径（原 HistoryFilterBar 那颗 chip），
 * 不另造「音频」第二种叫法。
 *
 * detectPriority 维持既有推断语义：video(10) 先于 audio(20) 先于 image(30)。
 * image 排最后是既有注解的理由——只有当一条 entry 完全没有 video/audio 产物时
 * 才轮到它；而「结果带 imageUrl」在 deliverableKindOfResult 里已先扫 image，
 * 两件事互不影响（前者是单一 result 的 URL 投影，后者是整条 entry 的种类）。
 */
export const DELIVERABLE_KINDS = [
  { id: "image", label: "图片", resultField: "imageUrl", assetItemKind: "image", assetUrlField: "imageUrl", playable: false, filterable: true, detectPriority: 30 },
  { id: "video", label: "视频", resultField: "videoUrl", assetItemKind: "video", assetUrlField: "mediaUrl", playable: true, filterable: true, detectPriority: 10 },
  { id: "audio", label: "音乐", resultField: "audioUrl", assetItemKind: "audio", assetUrlField: "mediaUrl", playable: true, filterable: true, detectPriority: 20 },
] as const satisfies readonly DeliverableKindSpec[];

/** 交付物种类 id 的联集，由注册表推导（不再手写字串联集）。 */
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]["id"];

/** 种类 id 的执行时清单。owner 仍是 DELIVERABLE_KINDS；此处只是投影，供 O(1) 判定。 */
export const DELIVERABLE_KIND_IDS: readonly DeliverableKind[] = DELIVERABLE_KINDS.map(
  (kind) => kind.id,
);

/** 白名单判定：只放行注册表里的种类 id。 */
export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return (
    typeof value === "string" && (DELIVERABLE_KIND_IDS as readonly string[]).includes(value)
  );
}

/** 取某种类的完整规格。注册表内必存在；传入未注册 id 视为程式错误，直接抛。 */
export function deliverableKindSpec(id: DeliverableKind): DeliverableKindSpec {
  const spec = DELIVERABLE_KINDS.find((kind) => kind.id === id);
  if (!spec) throw new Error(`unknown deliverable kind: ${String(id)}`);
  return spec;
}

/** 取某种类的 UI 文案（简体）。 */
export function deliverableKindLabel(id: DeliverableKind): string {
  return deliverableKindSpec(id).label;
}

/**
 * 从一个「可能带三种 URL 栏位」的结果物件推种类。
 *
 * 扫描顺序＝注册表宣告序 image → video → audio，回第一个有非空字串值的种类；
 * 都没有回 null。参数用结构型别，不 import HistoryResult（避免循环依赖）。
 */
export function deliverableKindOfResult(result: {
  imageUrl?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
}): DeliverableKind | null {
  for (const kind of DELIVERABLE_KINDS) {
    const value = result[kind.resultField];
    if (typeof value === "string" && value.trim()) return kind.id;
  }
  return null;
}

/**
 * 从一个「可能带三种 URL 栏位」的结果物件取得**所有**命中的种类。
 *
 * 与 deliverableKindOfResult 的差异：后者是「这个 result 的代表媒体是哪一种」
 * 的单一投影（扫描序＝宣告序 image → video → audio，回第一个）；本函式回传
 * 全部命中（例：同时带 imageUrl 与 videoUrl 的 result → ["video","image"]），
 * 供历史侧 inferEntryKind 逐 result、逐栏位收集种类后按 detectPriority 取最
 * 高优先者——否则单一 result 的双 URL 会被单一投影抹掉（videoUrl 被 image 盖过）。
 *
 * 回传值按 deliverableKindsByDetectPriority() 排序（优先者在前）；无命中回空阵列。
 */
export function deliverableKindsOfResult(result: {
  imageUrl?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
}): readonly DeliverableKind[] {
  const hits = new Set<DeliverableKind>();
  for (const kind of DELIVERABLE_KINDS) {
    const value = result[kind.resultField];
    if (typeof value === "string" && value.trim()) hits.add(kind.id);
  }
  return deliverableKindsByDetectPriority().filter((kind) => hits.has(kind));
}

/** 可给筛选 chip 的种类（按 DELIVERABLE_KINDS 宣告序；内容与长度由注册表推导）。 */
export function filterableDeliverableKinds(): readonly DeliverableKindSpec[] {
  return DELIVERABLE_KINDS.filter((kind) => kind.filterable);
}

/**
 * 种类推断优先序清单：按 detectPriority 升序，同值时以宣告序稳定排序。
 *
 * 这就是 inferEntryKind（history-types）判定「一条 entry 带多种媒体」时的唯一
 * 真源——新增种类只要在注册表给 detectPriority，就自动纳入这条序，不需再改
 * history-types 的硬编分支。
 */
export function deliverableKindsByDetectPriority(): readonly DeliverableKind[] {
  return DELIVERABLE_KINDS
    .map((kind, index) => ({ id: kind.id, priority: kind.detectPriority, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.id);
}

/** 资产侧：deliverable → 资产包 item kind。 */
export function assetItemKindOf(deliverable: DeliverableKind): string {
  return deliverableKindSpec(deliverable).assetItemKind;
}

/** 资产侧：deliverable → 资产包 item 上承载 URL 的栏位名。 */
export function assetUrlFieldOf(deliverable: DeliverableKind): "imageUrl" | "mediaUrl" {
  return deliverableKindSpec(deliverable).assetUrlField;
}
