// 分镜内容变更 → 该镜旧关联媒体失效（W2，2026-09-30）。
//
// 缺口（本档要补的资料层语义）：改了一镜的台词／旁白／画面内容后，旧的影像与配音
// 关联仍挂在该镜上，被下游当成「这一格已完成」——内容与产物脱钩。既有节点版本历史
// （`node-versions.ts`）只快照内容，不会动任何关联键；本档补上「内容变 → 关联失效」
// 这一块，并且**只是纯函式**（无 IO、无副作用），由呼叫端决定何时落盘。
//
// ── 为何**不另造第二套版本帐**（先读我方既有版本机制后的裁定）──────────────────
//   ① 我方已有「节点版本历史」：`node-versions.ts` 的 `CanvasNodeVersion`（挂在
//      `CanvasProject.nodeVersions`，单节点上限 20 版／专案 400 版），按**内容签名**
//      落版——内容变更这件事已经有帐。对手的 `production_revision`（routes.js:456）是
//      「内容变更就 +1 的整数版号」，与此语义重叠；再造一个就是第二套帐，两者必漂移。
//   ② 对手递增 `production_revision` 的**真正用途**是「挡迟到任务回绑」
//      （poller.js:140：迟到的轮询结果比对 `storyboard_revision` 不同就丢弃）。我方
//      这层守卫可由既有版本机制承载（回绑前比对该节点最新版本的内容签名），不需新栏位。
//   ③ 本档真正缺的是**关联失效**（旧媒体不再是这一格的产物），版本历史不承载此事——
//      故只补这一个纯函式，不新增任何 revision 栏位。**未新增任何版本帐。**
//
// ── 语义来源（逐字照对手 `PUT /api/storyboards/:id`，agnes-manga-studio/lib/routes.js）──
//   · routes.js:442 `changed(key)`：`key in patch && String(patch[key] ?? '') !== String(before[key] ?? '')`
//     ——「值真的不同」才算变更（同值重送＝未变更）。
//   · routes.js:443-444 影像变更＝画面描述／角色／场景／动作任一变（videoChanged 含 imageChanged）。
//   · routes.js:445-447 `dialogueChanged` / `narrationChanged` / `audioChanged = 两者之一`。
//   · routes.js:448-452 **未显式带 linked id 就把对应关联清空**：
//     `if (imageChanged && !('linked_image_id' in body)) patch.linked_image_id = '';` 等。
//   · routes.js:453-455 内容变更顺带改 status（本档不做 status，属生成态机，不在资料层职责）。
//   · routes.js:456-460 递增 revision（我方**刻意不做**，理由见上）。
//
// ── 键名（W2 已冻结，逐字照用；不另立词表）────────────────────────────────────
//   · 内容栏：`dialogue`／`visualDescription` 在 21 栏 AID 契约内（`storyboard-contract.ts`
//     的 `STORYBOARD_SHOT_FIELDS`，本档不改契约）；「画师 prompt」我方 21 栏无此栏，
//     由画师 agent 另产、落在节点 `metadata.prompt`（同 `storyboard-shots.shotRerunRequest`
//     的读法），本档以 `prompt` 承接。`narration` 是 W2 新键（不在 21 栏内）。
//   · 关联键：`dialogueAudioId`／`narrationAudioId`／`audioAnchorId`＝W2 冻结新键；
//     `shotCandidates`＝我方既有「一分镜候选集＋星标采用稿」轮子（`storyboard-shots.ts`，
//     D9），就是本镜的影像（含影）关联，**不另造新键**。

// ─────────────────────────────────────────── 键与视野

/**
 * 分镜的「旧关联媒体」键集合（本函式唯一会回报的失效标的）。
 * 顺序固定＝回报顺序固定（呼叫端据此组出稳定 patch，测试不靠 sort）。
 *
 * `shotCandidates` 对应对手 `linked_image_id`／`linked_video_id`（该镜的影像/影音关联）；
 * `dialogueAudioId`/`narrationAudioId`/`audioAnchorId` 逐字对应 W2 冻结键。
 */
export const SHOT_MEDIA_LINK_KEYS = [
  "shotCandidates",
  "dialogueAudioId",
  "narrationAudioId",
  "audioAnchorId",
] as const;

export type ShotMediaLinkKey = (typeof SHOT_MEDIA_LINK_KEYS)[number];

/**
 * 分镜媒体视野（＝本函式唯一输入形状）。
 *
 * 形状照我方**分镜节点 metadata**：21 栏内容在 `storyboardShot` 内、其余新键在顶层。
 * 带 index signature 是为了让它直接吃真实 metadata（含本函式不关心的键，如 `shotSize`、
 * `status`），呼叫端不必先裁剪；本函式只读它认得的栏位，其余一概不看。
 *
 * 三个内容栏位（`visualDescription`/`dialogue`/`narration`）与「画师 prompt」采
 * **先看 `storyboardShot[栏]`、再看顶层同名键**的读法：容忍 patch 以巢状（21 栏写入）
 * 或摊平（呼叫端预先展平）两种形状进来，两者语义相同。
 */
export interface StoryboardShotMediaView {
  /** AID 21 栏内容（`metadata.storyboardShot`）；本函式只读 `visualDescription`/`dialogue`。 */
  readonly storyboardShot?: Readonly<Record<string, unknown>> | null;
  /** 画师 prompt（节点 `metadata.prompt`；21 栏无此栏）。 */
  readonly prompt?: unknown;
  /** 旁白（W2 新键；内容栏）。 */
  readonly narration?: unknown;
  /** 本镜影像（含影）关联：候选集＋星标采用稿（既有轮子，`storyboard-shots.ts`）。 */
  readonly shotCandidates?: unknown;
  /** 台词配音关联（W2 冻结键）。 */
  readonly dialogueAudioId?: unknown;
  /** 旁白配音关联（W2 冻结键）。 */
  readonly narrationAudioId?: unknown;
  /** 音频锚点关联（W2 冻结键）。 */
  readonly audioAnchorId?: unknown;
  /** 其余 metadata 键本函式不看（`shotSize`/`status`/…）。 */
  readonly [key: string]: unknown;
}

// ─────────────────────────────────────────── 内容变更判定

/** 读一个内容栏位：值（一律字串化，比照对手的 `String(v ?? '')`）＋「本次是否真的有供给此栏」。 */
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

/** 对手的 `String(v ?? '')`：`null`/`undefined` → `""`，其余字串化（非字串不臆造结构，照字面）。 */
function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/** `key in patch`（对手 448-452 的显式供给判据）＝本函式要求「有这个键」才不下手。 */
function provides(view: StoryboardShotMediaView | undefined, key: string): boolean {
  return view !== undefined && Object.prototype.hasOwnProperty.call(view, key);
}

/**
 * 单栏变更判定（逐字照 routes.js:442 `changed`）：
 * patch **有供给该栏** 且 字串化后与 `before` 不同 ⇒ 变更。同值重送＝未变更。
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

// ─────────────────────────────────────────── 失效计算（唯一入口）

/**
 * 分镜内容变更 → 应被清空的关联键集合（纯函式，回固定顺序的键清单）。
 *
 * 规则（全部照 routes.js:443-452，只换成我方键名与形状）：
 *   ① 画面内容变（`visualDescription` 或画师 `prompt` 任一变）→ `shotCandidates` 失效
 *      （本镜旧图／旧影不再算这一格的产物）。
 *   ② 台词变（`dialogue`）→ `dialogueAudioId` 失效。
 *   ③ 旁白变（`narration`）→ `narrationAudioId` 失效。
 *   ④ 音频内容任一变（②或③）→ `audioAnchorId` 失效（对手 audioChanged 同时清 `linked_audio_id`）。
 *   ⑤ **本次 patch 显式带了该关联的新值 → 不由本函式清**（对手 448-452 的 `!('linked_*' in body)`）：
 *      呼叫端明确要换一颗新媒体时，失效逻辑必须让路，否则会把刚绑的新值又清掉。
 *   ⑥ 未变更的内容栏位 → 对应关联一律不动（防过度失效）。
 *
 * 回传的是「要清空的键」，不含新值；实际落盘＝呼叫端据此把这些键删掉（或用
 * `clearShotMediaLinks` 产生新 metadata）。**不改输入**。
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
  // ① 影像关联
  if (imageChanged && !provides(patch, "shotCandidates")) out.push("shotCandidates");
  // ② 台词配音关联
  if (dialogueChanged && !provides(patch, "dialogueAudioId")) out.push("dialogueAudioId");
  // ③ 旁白配音关联
  if (narrationChanged && !provides(patch, "narrationAudioId")) out.push("narrationAudioId");
  // ④ 音频锚点关联（台词或旁白任一变）
  if (audioChanged && !provides(patch, "audioAnchorId")) out.push("audioAnchorId");
  return out;
}

/**
 * 把指定的关联键从分镜媒体视野中清掉（纯函式，回**新物件**，不改输入）。
 * 只删 `SHOT_MEDIA_LINK_KEYS` 白名单内的键，其余栏位原样透传；空清单＝等值新物件。
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
 * 便利收口：算出「失效后的分镜 metadata」＝把 `before` 上被本次 patch 判定失效的关联键清掉。
 *
 * **只负责清失效关联，不合并 patch 内容**（patch 的内容写入由呼叫端自己的 patch 合并路径做；
 * 若 patch 显式带了新关联 id，规则⑤ 已保证它不在失效键内，故先清后合并、或先合并后清都安全）。
 * 未变更时回与输入等值的新物件（呼叫端不会拿到被突变的旧参考）。
 */
export function invalidateShotMediaLinksFromPatch<T extends StoryboardShotMediaView>(
  before: T,
  patch: StoryboardShotMediaView,
): T {
  return clearShotMediaLinks(before, invalidatedShotMediaLinks(before, patch));
}