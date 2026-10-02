// 交付物種類的唯一真源（單一真源註冊表）。
//
// 背景：在此之前「種類」在 repo 裡有 5+ 份各寫一份的清單——歷史側的
// HistoryEntryKind / HistoryResult.mediaType、模型側的 MediaKind、
// 資產側的 AssetPackItemKind，再加上 UI 的三份硬編（ENTRY_KIND_VALUES /
// HistoryEntryKindFilter / HistoryFilterBar 的 chips）。
// 新增一種交付物（例：音樂）＝要改 20 個地方，而且靠人腦保持同步。
//
// 本檔把「交付物有哪些、各自叫什麼、產物落哪個欄位、資產側怎麼承接、
// 能不能播、要不要給篩選 chip」收斂成 DELIVERABLE_KINDS 一張表；
// 其餘各處（型別、UID 文案、歷史推斷、資產映射）全部由它推導。
// 之後新增一種交付物 ＝ 在這裡加一行。
//
// 值域與模型 catalog 的 MediaKind（generation-model-catalog/types.ts）是**同一件事**：
// MediaKind 已改為由本檔的 DeliverableKind 推導（`export type MediaKind = DeliverableKind`），
// 不再是平行宣告——新增交付物種類時兩側不會走鐘，這是編譯期事實而非註解聲明。
// `workflow` 不是交付物（它是一次跑批記錄），由歷史側單獨以
// NON_DELIVERABLE_ENTRY_KINDS 承接，不進本表。
//
// 本檔零依賴，可被任何層（lib / component / route）安全 import，不造成循環。
//
// 契約（detectPriority 必填）：歷史側 inferEntryKind 決定「一條 entry 的種類」時，
// 靠這裡的 detectPriority 排優先序。新增一種交付物若忘了給 detectPriority，
// **編譯不會通過**——這正是刻意的性質：優先序是種類註冊的一部分，不是可選裝飾。
// 少了它，新種類會在任何帶媒體的 entry 上被靜默判成舊種類（歷史上就是 image）。

/** 交付物種類規格。新增一種交付物＝在 DELIVERABLE_KINDS 加一行，型別與各推導清單自動跟上。 */
export interface DeliverableKindSpec {
  /** 種類 id。也是 HistoryResult.mediaType 的值。 */
  id: string;
  /** 站點 UI 文案（簡體，例：图片／视频／音乐）。 */
  label: string;
  /** HistoryResult 上承載該種類的欄位名（資產側與歷史側共用同一語義）。 */
  resultField: "imageUrl" | "videoUrl" | "audioUrl";
  /** 資產包 item 的 kind（資產庫承接同一種類）。 */
  assetItemKind: string;
  /** 資產包 item 上承載 URL 的欄位名。 */
  assetUrlField: "imageUrl" | "mediaUrl";
  /** 是否為可播放媒體（影片/音樂 true；圖片 false）。 */
  playable: boolean;
  /** 歷史頁是否給種類篩選 chip。 */
  filterable: boolean;
  /**
   * 種類推斷優先序（數字越小＝越優先；同值時以宣告序穩定排序）。
   *
   * inferEntryKind 一條 entry 同時帶多種媒體時，取此序最前者。必填：
   * 新增種類漏填＝編譯失敗，不會再出現「新種類被靜默判成 image」的破口。
   */
  detectPriority: number;
}

/**
 * 交付物種類真源（宣告序：image → video → audio）。
 *
 * `audio` 的 label 刻意用「音乐」——站內既有口徑（原 HistoryFilterBar 那顆 chip），
 * 不另造「音频」第二種叫法。
 *
 * detectPriority 維持既有推斷語義：video(10) 先於 audio(20) 先於 image(30)。
 * image 排最後是既有註解的理由——只有當一條 entry 完全沒有 video/audio 產物時
 * 才輪到它；而「結果帶 imageUrl」在 deliverableKindOfResult 裡已先掃 image，
 * 兩件事互不影響（前者是單一 result 的 URL 投影，後者是整條 entry 的種類）。
 */
export const DELIVERABLE_KINDS = [
  { id: "image", label: "图片", resultField: "imageUrl", assetItemKind: "image", assetUrlField: "imageUrl", playable: false, filterable: true, detectPriority: 30 },
  { id: "video", label: "视频", resultField: "videoUrl", assetItemKind: "video", assetUrlField: "mediaUrl", playable: true, filterable: true, detectPriority: 10 },
  { id: "audio", label: "音乐", resultField: "audioUrl", assetItemKind: "audio", assetUrlField: "mediaUrl", playable: true, filterable: true, detectPriority: 20 },
] as const satisfies readonly DeliverableKindSpec[];

/** 交付物種類 id 的聯集，由註冊表推導（不再手寫字串聯集）。 */
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]["id"];

/** 種類 id 的執行時清單。owner 仍是 DELIVERABLE_KINDS；此處只是投影，供 O(1) 判定。 */
export const DELIVERABLE_KIND_IDS: readonly DeliverableKind[] = DELIVERABLE_KINDS.map(
  (kind) => kind.id,
);

/** 白名單判定：只放行註冊表裡的種類 id。 */
export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return (
    typeof value === "string" && (DELIVERABLE_KIND_IDS as readonly string[]).includes(value)
  );
}

/** 取某種類的完整規格。註冊表內必存在；傳入未註冊 id 視為程式錯誤，直接拋。 */
export function deliverableKindSpec(id: DeliverableKind): DeliverableKindSpec {
  const spec = DELIVERABLE_KINDS.find((kind) => kind.id === id);
  if (!spec) throw new Error(`unknown deliverable kind: ${String(id)}`);
  return spec;
}

/** 取某種類的 UI 文案（簡體）。 */
export function deliverableKindLabel(id: DeliverableKind): string {
  return deliverableKindSpec(id).label;
}

/**
 * 從一個「可能帶三種 URL 欄位」的結果物件推種類。
 *
 * 掃描順序＝註冊表宣告序 image → video → audio，回第一個有非空字串值的種類；
 * 都沒有回 null。參數用結構型別，不 import HistoryResult（避免循環依賴）。
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
 * 從一個「可能帶三種 URL 欄位」的結果物件取得**所有**命中的種類。
 *
 * 與 deliverableKindOfResult 的差異：後者是「這個 result 的代表媒體是哪一種」
 * 的單一投影（掃描序＝宣告序 image → video → audio，回第一個）；本函式回傳
 * 全部命中（例：同時帶 imageUrl 與 videoUrl 的 result → ["video","image"]），
 * 供歷史側 inferEntryKind 逐 result、逐欄位收集種類後按 detectPriority 取最
 * 高優先者——否則單一 result 的雙 URL 會被單一投影抹掉（videoUrl 被 image 蓋過）。
 *
 * 回傳值按 deliverableKindsByDetectPriority() 排序（優先者在前）；無命中回空陣列。
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

/** 可給篩選 chip 的種類（按 DELIVERABLE_KINDS 宣告序；內容與長度由註冊表推導）。 */
export function filterableDeliverableKinds(): readonly DeliverableKindSpec[] {
  return DELIVERABLE_KINDS.filter((kind) => kind.filterable);
}

/**
 * 種類推斷優先序清單：按 detectPriority 升序，同值時以宣告序穩定排序。
 *
 * 這就是 inferEntryKind（history-types）判定「一條 entry 帶多種媒體」時的唯一
 * 真源——新增種類只要在註冊表給 detectPriority，就自動納入這條序，不需再改
 * history-types 的硬編分支。
 */
export function deliverableKindsByDetectPriority(): readonly DeliverableKind[] {
  return DELIVERABLE_KINDS
    .map((kind, index) => ({ id: kind.id, priority: kind.detectPriority, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.id);
}

/** 資產側：deliverable → 資產包 item kind。 */
export function assetItemKindOf(deliverable: DeliverableKind): string {
  return deliverableKindSpec(deliverable).assetItemKind;
}

/** 資產側：deliverable → 資產包 item 上承載 URL 的欄位名。 */
export function assetUrlFieldOf(deliverable: DeliverableKind): "imageUrl" | "mediaUrl" {
  return deliverableKindSpec(deliverable).assetUrlField;
}
