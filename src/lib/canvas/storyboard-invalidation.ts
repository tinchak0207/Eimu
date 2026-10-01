// 分鏡內容變更 → 該鏡舊關聯媒體失效（W2，2026-09-30）。
//
// 缺口（本檔要補的資料層語義）：改了一鏡的台詞／旁白／畫面內容後，舊的影像與配音
// 關聯仍掛在該鏡上，被下游當成「這一格已完成」——內容與產物脫鉤。既有節點版本歷史
// （`node-versions.ts`）只快照內容，不會動任何關聯鍵；本檔補上「內容變 → 關聯失效」
// 這一塊，並且**只是純函式**（無 IO、無副作用），由呼叫端決定何時落盤。
//
// ── 為何**不另造第二套版本帳**（先讀我方既有版本機制後的裁定）──────────────────
//   ① 我方已有「節點版本歷史」：`node-versions.ts` 的 `CanvasNodeVersion`（掛在
//      `CanvasProject.nodeVersions`，單節點上限 20 版／專案 400 版），按**內容簽名**
//      落版——內容變更這件事已經有帳。對手的 `production_revision`（routes.js:456）是
//      「內容變更就 +1 的整數版號」，與此語義重疊；再造一個就是第二套帳，兩者必漂移。
//   ② 對手遞增 `production_revision` 的**真正用途**是「擋遲到任務回綁」
//      （poller.js:140：遲到的輪詢結果比對 `storyboard_revision` 不同就丟棄）。我方
//      這層守衛可由既有版本機制承載（回綁前比對該節點最新版本的內容簽名），不需新欄位。
//   ③ 本檔真正缺的是**關聯失效**（舊媒體不再是這一格的產物），版本歷史不承載此事——
//      故只補這一個純函式，不新增任何 revision 欄位。**未新增任何版本帳。**
//
// ── 語義來源（逐字照對手 `PUT /api/storyboards/:id`，agnes-manga-studio/lib/routes.js）──
//   · routes.js:442 `changed(key)`：`key in patch && String(patch[key] ?? '') !== String(before[key] ?? '')`
//     ——「值真的不同」才算變更（同值重送＝未變更）。
//   · routes.js:443-444 影像變更＝畫面描述／角色／場景／動作任一變（videoChanged 含 imageChanged）。
//   · routes.js:445-447 `dialogueChanged` / `narrationChanged` / `audioChanged = 兩者之一`。
//   · routes.js:448-452 **未顯式帶 linked id 就把對應關聯清空**：
//     `if (imageChanged && !('linked_image_id' in body)) patch.linked_image_id = '';` 等。
//   · routes.js:453-455 內容變更順帶改 status（本檔不做 status，屬生成態機，不在資料層職責）。
//   · routes.js:456-460 遞增 revision（我方**刻意不做**，理由見上）。
//
// ── 鍵名（W2 已凍結，逐字照用；不另立詞表）────────────────────────────────────
//   · 內容欄：`dialogue`／`visualDescription` 在 21 欄 AID 契約內（`storyboard-contract.ts`
//     的 `STORYBOARD_SHOT_FIELDS`，本檔不改契約）；「畫師 prompt」我方 21 欄無此欄，
//     由畫師 agent 另產、落在節點 `metadata.prompt`（同 `storyboard-shots.shotRerunRequest`
//     的讀法），本檔以 `prompt` 承接。`narration` 是 W2 新鍵（不在 21 欄內）。
//   · 關聯鍵：`dialogueAudioId`／`narrationAudioId`／`audioAnchorId`＝W2 凍結新鍵；
//     `shotCandidates`＝我方既有「一分鏡候選集＋星標採用稿」輪子（`storyboard-shots.ts`，
//     D9），就是本鏡的影像（含影）關聯，**不另造新鍵**。

// ─────────────────────────────────────────── 鍵與視野

/**
 * 分鏡的「舊關聯媒體」鍵集合（本函式唯一會回報的失效標的）。
 * 順序固定＝回報順序固定（呼叫端據此組出穩定 patch，測試不靠 sort）。
 *
 * `shotCandidates` 對應對手 `linked_image_id`／`linked_video_id`（該鏡的影像/影音關聯）；
 * `dialogueAudioId`/`narrationAudioId`/`audioAnchorId` 逐字對應 W2 凍結鍵。
 */
export const SHOT_MEDIA_LINK_KEYS = [
  "shotCandidates",
  "dialogueAudioId",
  "narrationAudioId",
  "audioAnchorId",
] as const;

export type ShotMediaLinkKey = (typeof SHOT_MEDIA_LINK_KEYS)[number];

/**
 * 分鏡媒體視野（＝本函式唯一輸入形狀）。
 *
 * 形狀照我方**分鏡節點 metadata**：21 欄內容在 `storyboardShot` 內、其餘新鍵在頂層。
 * 帶 index signature 是為了讓它直接吃真實 metadata（含本函式不關心的鍵，如 `shotSize`、
 * `status`），呼叫端不必先裁剪；本函式只讀它認得的欄位，其餘一概不看。
 *
 * 三個內容欄位（`visualDescription`/`dialogue`/`narration`）與「畫師 prompt」採
 * **先看 `storyboardShot[欄]`、再看頂層同名鍵**的讀法：容忍 patch 以巢狀（21 欄寫入）
 * 或攤平（呼叫端預先展平）兩種形狀進來，兩者語義相同。
 */
export interface StoryboardShotMediaView {
  /** AID 21 欄內容（`metadata.storyboardShot`）；本函式只讀 `visualDescription`/`dialogue`。 */
  readonly storyboardShot?: Readonly<Record<string, unknown>> | null;
  /** 畫師 prompt（節點 `metadata.prompt`；21 欄無此欄）。 */
  readonly prompt?: unknown;
  /** 旁白（W2 新鍵；內容欄）。 */
  readonly narration?: unknown;
  /** 本鏡影像（含影）關聯：候選集＋星標採用稿（既有輪子，`storyboard-shots.ts`）。 */
  readonly shotCandidates?: unknown;
  /** 台詞配音關聯（W2 凍結鍵）。 */
  readonly dialogueAudioId?: unknown;
  /** 旁白配音關聯（W2 凍結鍵）。 */
  readonly narrationAudioId?: unknown;
  /** 音頻錨點關聯（W2 凍結鍵）。 */
  readonly audioAnchorId?: unknown;
  /** 其餘 metadata 鍵本函式不看（`shotSize`/`status`/…）。 */
  readonly [key: string]: unknown;
}

// ─────────────────────────────────────────── 內容變更判定

/** 讀一個內容欄位：值（一律字串化，比照對手的 `String(v ?? '')`）＋「本次是否真的有供給此欄」。 */
function readContentField(
  view: StoryboardShotMediaView | undefined,
  field: string,
): { present: boolean; value: string } {
  const nested = view?.storyboardShot;
  if (nested && typeof nested === "object" && field in nested) {
    return { present: true, value: stringify((nested as Record<string, unknown>)[field]) };
  }
  if (view && field in view) {
    return { present: true, value: stringify(view[field]) };
  }
  return { present: false, value: "" };
}

/** 對手的 `String(v ?? '')`：`null`/`undefined` → `""`，其餘字串化（非字串不臆造結構，照字面）。 */
function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/** `key in patch`（對手 448-452 的顯式供給判據）＝本函式要求「有這個鍵」才不下手。 */
function provides(view: StoryboardShotMediaView | undefined, key: string): boolean {
  return view !== undefined && Object.prototype.hasOwnProperty.call(view, key);
}

/**
 * 單欄變更判定（逐字照 routes.js:442 `changed`）：
 * patch **有供給該欄** 且 字串化後與 `before` 不同 ⇒ 變更。同值重送＝未變更。
 */
function contentChanged(
  before: StoryboardShotMediaView | undefined,
  patch: StoryboardShotMediaView | undefined,
  field: string,
): boolean {
  const next = readContentField(patch, field);
  if (!next.present) return false;
  return next.value !== readContentField(before, field).value;
}

// ─────────────────────────────────────────── 失效計算（唯一入口）

/**
 * 分鏡內容變更 → 應被清空的關聯鍵集合（純函式，回固定順序的鍵清單）。
 *
 * 規則（全部照 routes.js:443-452，只換成我方鍵名與形狀）：
 *   ① 畫面內容變（`visualDescription` 或畫師 `prompt` 任一變）→ `shotCandidates` 失效
 *      （本鏡舊圖／舊影不再算這一格的產物）。
 *   ② 台詞變（`dialogue`）→ `dialogueAudioId` 失效。
 *   ③ 旁白變（`narration`）→ `narrationAudioId` 失效。
 *   ④ 音頻內容任一變（②或③）→ `audioAnchorId` 失效（對手 audioChanged 同時清 `linked_audio_id`）。
 *   ⑤ **本次 patch 顯式帶了該關聯的新值 → 不由本函式清**（對手 448-452 的 `!('linked_*' in body)`）：
 *      呼叫端明確要換一顆新媒體時，失效邏輯必須讓路，否則會把剛綁的新值又清掉。
 *   ⑥ 未變更的內容欄位 → 對應關聯一律不動（防過度失效）。
 *
 * 回傳的是「要清空的鍵」，不含新值；實際落盤＝呼叫端據此把這些鍵刪掉（或用
 * `clearShotMediaLinks` 產生新 metadata）。**不改輸入**。
 */
export function invalidatedShotMediaLinks(
  before: StoryboardShotMediaView | undefined,
  patch: StoryboardShotMediaView | undefined,
): readonly ShotMediaLinkKey[] {
  const imageChanged =
    contentChanged(before, patch, "visualDescription") || contentChanged(before, patch, "prompt");
  const dialogueChanged = contentChanged(before, patch, "dialogue");
  const narrationChanged = contentChanged(before, patch, "narration");
  const audioChanged = dialogueChanged || narrationChanged;

  const out: ShotMediaLinkKey[] = [];
  // ① 影像關聯
  if (imageChanged && !provides(patch, "shotCandidates")) out.push("shotCandidates");
  // ② 台詞配音關聯
  if (dialogueChanged && !provides(patch, "dialogueAudioId")) out.push("dialogueAudioId");
  // ③ 旁白配音關聯
  if (narrationChanged && !provides(patch, "narrationAudioId")) out.push("narrationAudioId");
  // ④ 音頻錨點關聯（台詞或旁白任一變）
  if (audioChanged && !provides(patch, "audioAnchorId")) out.push("audioAnchorId");
  return out;
}

/**
 * 把指定的關聯鍵從分鏡媒體視野中清掉（純函式，回**新物件**，不改輸入）。
 * 只刪 `SHOT_MEDIA_LINK_KEYS` 白名單內的鍵，其餘欄位原樣透傳；空清單＝等值新物件。
 */
export function clearShotMediaLinks<T extends StoryboardShotMediaView>(
  view: T,
  keys: readonly ShotMediaLinkKey[],
): T {
  const next: Record<string, unknown> = { ...view };
  for (const key of keys) delete next[key];
  return next as T;
}

/**
 * 便利收口：算出「失效後的分鏡 metadata」＝把 `before` 上被本次 patch 判定失效的關聯鍵清掉。
 *
 * **只負責清失效關聯，不合併 patch 內容**（patch 的內容寫入由呼叫端自己的 patch 合併路徑做；
 * 若 patch 顯式帶了新關聯 id，規則⑤ 已保證它不在失效鍵內，故先清後合併、或先合併後清都安全）。
 * 未變更時回與輸入等值的新物件（呼叫端不會拿到被突變的舊參考）。
 */
export function invalidateShotMediaLinksFromPatch<T extends StoryboardShotMediaView>(
  before: T,
  patch: StoryboardShotMediaView,
): T {
  return clearShotMediaLinks(before, invalidatedShotMediaLinks(before, patch));
}