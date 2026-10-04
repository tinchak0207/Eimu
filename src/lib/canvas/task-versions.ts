// 任务版本（Version）＋标签（Tags）＋选中（Selected）（P1-9，对称差 D37；2026-09-29）。
//
// D37 逐字：「任务 `{Version:"<时戳>", Tags:["main_image"|"main_video"], Status}`；
// 素材 `Version`/`Selected`」；判我方「有五态状态机但**无 per-任务 Version 与 Tags 语义**」。
//
// 落点＝画布节点 metadata 的 `taskVersions`（`{ items, selectedVersion }`）：
//
//   · 一「格」＝一颗节点；**同一格重跑＝一笔新任务 → 追加一笔新版本**，旧版本原样留著
//     （append-only，不是覆盖）。`items[].version` ＝任务的版本识别（Dramagic 的
//     `"<时戳>"`）＝**产生该任务的时刻**，正规化成 ISO 8601（UTC）字串 ⇒ 字典序＝时间序，
//     可排序、可辨识、可回溯。
//
//   · **刻意不用节点版本历史**（`node-versions.ts` 的 `nodeVersions`，2026-09-27）代替：
//     那是「内容变更历史」（title＋metadata 快照，挂在 `CanvasProject` 而非节点 metadata），
//     按内容签名落版 ⇒ 同一 prompt 重跑第二笔可能不落版（任务凭空消失），
//     且它没有任务身份/标签/选中语义。两个「版本」是不同的东西，不合并。
//
//   · `items[].tags` ＝任务标签（值域 `TASK_TAGS`：`main_image` / `main_video`），可由现场
//     既有 kind 词汇推导（`taskTagForKind`），也可直接宣告。未知值在清洗端**丢弃**
//     （fail-closed，不降格成 `main_image`——猜错会让分组把别的产物算进来）。
//
//   · `items[].status` ＝沿用节点四态（`CanvasNodeStatus`），不另立枚举。
//
//   · `selectedVersion` ＝**星标选中的那一版任务**（＝Dramagic 素材 `Selected:true`）：
//     该版的交付 URL（`items[].url`）就是本格的采用稿。
//
// 形状刻意照 `storyboard-shots.ts` 的 `StoryboardShotCandidateSet`（`items` ＋ 选中键），
// 删除回退语义照 `reducer.ts` 批次主图（`batchPrimaryImageId: kept[0]`）与
// `removeShotCandidate`（`items[0]`）——**不造第三套**。选中键命名 `selectedVersion`
// （而非候选集的 `selectedId`）是因为条目的身份键在 D37 口径就是 `version`。
//
// 双白名单铁律：`taskVersions` 必须同时存在于还原端 `layout.toNodeMetadata` 与上行端
// `compactMetadataForAgent` 两处白名单（真源＝`node-metadata-fields.ts`），
// 漏一端＝刷新/回旧会话后任务版本史与选中者**凭空消失且不报错**（同 shotCandidates 病灶）。

import type { CanvasNode, CanvasNodeMetadata, CanvasNodeStatus } from "./types";

// ─────────────────────────────────────────── 值域与上限

/**
 * 任务标签值域（D37 字面 `main_image`/`main_video`）。
 *
 * 为什么用这两个字面而不是 `image`/`video`：`image`/`video` 在本库已被节点 kind 与
 * `mediaType` 占用（值域＝生成物种类），D37 的 Tags 是**任务角色**（这条任务是不是
 * 本格的主图/主片交付）。直接收敛成既有字面会与 kind 语义纠缠，故照 D37 逐字立值域，
 * 并在 `taskTagForKind` 提供 kind → tag 的**单向**推导（不反向、不合并两套枚举）。
 */
export const TASK_TAGS = ["main_image", "main_video"] as const;
export type TaskTag = (typeof TASK_TAGS)[number];

/** 执行期判据（SSE/Blob 读回的值不可信，一律过此）。 */
export function isTaskTag(v: unknown): v is TaskTag {
  return typeof v === "string" && (TASK_TAGS as readonly string[]).includes(v);
}

/**
 * 单格（单节点）保留的任务版本上限。
 * 20 与节点版本历史同尺（`node-versions.ts` 的 `MAX_NODE_VERSIONS_PER_NODE`）：一次
 * 「生成→看→再生成」的来回通常 ≤ 10 笔，20 给一倍余裕。
 * **写入端满了回 `full` 明确拒绝，不静默裁掉旧版本**——「旧版本要留得住」正是 D37 的要求，
 * 静默裁旧＝直接违反它（要腾位子得由人明确 `removeTaskVersion`）。
 */
export const MAX_TASK_VERSIONS_PER_NODE = 20;

/** 版本字串（ISO 8601）输入长度上限：`2026-09-29T10:00:00.123+08:00` ＝ 29 字，留余裕。 */
const VERSION_INPUT_MAX = 64;
/** 任务 id 长度上限（同族薄键量级）。 */
const TASK_ID_MAX = 200;
/** 交付 URL 长度上限（同 `shotCandidates` 的 URL 栏同尺）。 */
const TASK_URL_MAX = 2048;
/** kind 输入长度上限（推导标签时用）。 */
const KIND_MAX = 64;

/** 任务状态值域＝节点四态（`types.ts:81` 的 `CanvasNodeStatus`），不另立第二套。 */
const TASK_STATUSES: readonly CanvasNodeStatus[] = ["idle", "success", "loading", "error"];

// ─────────────────────────────────────────── 资料形状

/**
 * 一笔任务版本（＝D37 的任务 `{Version, Tags, Status}`；`url` ＝该版的交付物）
 * ＋ 该版产物的选中标记载体（选中记在集合的 `selectedVersion`，不写每笔布林——「最多一笔
 * 选中」是结构保证，不靠清洗端补救）。
 */
export interface TaskVersionEntry {
  /** 版本识别：产生本任务的时刻（ISO 8601 UTC；字典序＝时间序）。 */
  version: string;
  /** 生成任务 id（`metadata.imageTaskId` 同源）；缺席＝本地补录（不编造）。 */
  taskId?: string;
  /** 任务状态（节点四态）。 */
  status?: CanvasNodeStatus;
  /** 任务标签（值域内，首见序去重；空阵列＝推不出标签，不是「没有这个栏位」）。 */
  tags: TaskTag[];
  /** 本版任务的交付物 URL（＝D37 的素材；选中者就是采用稿）。 */
  url?: string;
}

/** 一格的任务版本史 ＋ 星标选中的那一版。 */
export interface TaskVersionSet {
  /** 任务版本清单（按 `version` 升序；末条＝最新一笔任务）。 */
  items: TaskVersionEntry[];
  /** 星标选中的版本（＝素材 `Selected`）；缺席＝尚未选定。 */
  selectedVersion?: string;
}

/** 一次任务版本变更的结果（**诚实拒绝**：塞不下就明说，不静默丢）。 */
export interface TaskVersionMutation {
  /** 变更后的集合（未接受时＝原集合的等值新物件）。 */
  set: TaskVersionSet;
  accepted: boolean;
  /** 未被接受的原因（accepted=true 时缺席）。 */
  reason?: "invalid" | "duplicate" | "full";
}

// ─────────────────────────────────────────── 清洗（读取端／写入端共用）

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** trim 后非空才回字串（超长截断）。 */
function trimmed(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * 版本识别正规化：能解析成时间的输入 → ISO 8601 UTC 字串（**字典序＝时间序**，
 * 这是「可辨识、可排序」的根）。
 * 解析不出来 → `undefined`（**没有时戳就没有版本识别**：不编造版本号、不用阵列序当版本）。
 */
export function normalizeTaskVersion(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > VERSION_INPUT_MAX) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * kind → 标签（值域收敛，**未知值不猜**）：
 *   · `"main_image"` / `"main_video"`（D37 字面）→ 原样
 *   · 现场 image 族（`image`、`image_generate`、`image_edit`）→ `main_image`
 *   · 现场 video 族（`video`、`video_generate`、`video_edit`）→ `main_video`
 *   · 其余（`tts`/`avatar`/`lipsync` 等语义上不是主图/主片的，以及任何未知值）→ `null`
 *     （**不降格成 `main_image`**：猜错会让分组把别的产物算进来）
 *
 * 词汇来源（现场真源，不另立）：
 *   · `CanvasNodeMetadata.kind` ∈ `"image"|"video"`（`types.ts:125`）
 *   · `GenerationTaskProjection.kind` ∈ 六值（`generation-task-types.ts:12`）
 *   · `HistoryEntry` 的 `mediaType` ∈ `"image"|"video"`（`history-types.ts`）
 */
export function taskTagForKind(kind: unknown): TaskTag | null {
  const k = trimmed(kind, KIND_MAX)?.toLowerCase();
  if (!k) return null;
  if (isTaskTag(k)) return k;
  if (k === "image" || k.startsWith("image_")) return "main_image";
  if (k === "video" || k.startsWith("video_")) return "main_video";
  return null;
}

/**
 * 标签清单清洗：trim、只留值域内值（**未知值丢弃，fail-closed**）、首见序去重。
 * 非阵列/清洗后为空 → `[]`（刻意**保留空阵列**而非省略键：分组是总函式，
 * 每笔任务都要能回答「它带什么标签」，空＝推不出，不是栏位缺席）。
 */
export function normalizeTaskTags(raw: unknown): TaskTag[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskTag[] = [];
  for (const item of raw) {
    const tag = trimmed(item, 32);
    if (!isTaskTag(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/**
 * 单笔任务版本清洗：`version` 解析不出即丢该笔（不制造没有版本识别的半形任务）。
 * 其余栏位逐栏验型：型别不符＝省略该栏，不连坐整笔。
 */
export function normalizeTaskVersionEntry(raw: unknown): TaskVersionEntry | null {
  if (!isRecord(raw)) return null;
  const version = normalizeTaskVersion(raw.version);
  if (!version) return null;
  const taskId = trimmed(raw.taskId, TASK_ID_MAX);
  const url = trimmed(raw.url, TASK_URL_MAX);
  const status = TASK_STATUSES.includes(raw.status as CanvasNodeStatus)
    ? (raw.status as CanvasNodeStatus)
    : undefined;
  return {
    version,
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
    tags: normalizeTaskTags(raw.tags),
    ...(url ? { url } : {}),
  };
}

/** 按 `version` 升序比较（ISO 8601 UTC 字串的字典序＝时间序）。 */
function byVersion(a: TaskVersionEntry, b: TaskVersionEntry): number {
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/**
 * 任务版本集清洗（逐项白名单，照 `normalizeShotCandidates` 的范式）：
 *   · 非物件 / 无 `items` 阵列 → `undefined`（省略键，不写空壳）
 *   · 逐笔走 `normalizeTaskVersionEntry`，非法笔丢弃（不整包作废）
 *   · 同 `version` 去重（保留首见）→ 按 `version` 升序排序 → 裁到 `MAX_TASK_VERSIONS_PER_NODE`
 *     （**读取端的防御性裁剪**，同 `normalizeNodeVersions`；写入端由 `appendTaskVersion`
 *     以 `full` 明确拒绝，两条路径语义不同、都不静默丢资料）
 *   · `selectedVersion` **必须是成员**才收（指向不存在者＝不制造悬空星标）
 *   · 清完是空集合 → `undefined`（没有任务版本＝没有这个键）
 */
export function normalizeTaskVersions(raw: unknown): TaskVersionSet | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  const seen = new Set<string>();
  const collected: TaskVersionEntry[] = [];
  for (const entry of raw.items) {
    const clean = normalizeTaskVersionEntry(entry);
    if (!clean || seen.has(clean.version)) continue;
    seen.add(clean.version);
    collected.push(clean);
  }
  if (collected.length === 0) return undefined;
  const items = collected.sort(byVersion).slice(-MAX_TASK_VERSIONS_PER_NODE);
  const selected = normalizeTaskVersion(raw.selectedVersion);
  const kept = new Set(items.map((item) => item.version));
  return {
    items,
    ...(selected && kept.has(selected) ? { selectedVersion: selected } : {}),
  };
}

/** 节点 metadata → 任务版本集（缺键／空集合＝`null`，不制造半形集合）。 */
export function readTaskVersions(metadata: CanvasNodeMetadata | undefined): TaskVersionSet | null {
  return normalizeTaskVersions(metadata?.taskVersions) ?? null;
}

/**
 * 任务版本集 → metadata patch（纯函式，呼叫端 `patchNodeMetadata` 直用）。
 * 空集合＝空 patch（不写空壳键，与 `shotCandidatesMetadata` 同款诚实边界）。
 */
export function taskVersionsMetadata(
  set: TaskVersionSet | null | undefined,
): Pick<CanvasNodeMetadata, "taskVersions"> {
  const normalized = normalizeTaskVersions(set);
  return normalized ? { taskVersions: normalized } : {};
}

// ─────────────────────────────────────────── 写入（追加／回填／删除／选中）

/** 集合的等值新物件（拒绝时回传，保证呼叫端拿不到可被误改的旧参考）。 */
function copySet(set: TaskVersionSet): TaskVersionSet {
  return {
    items: set.items.map((item) => ({ ...item, tags: [...item.tags] })),
    ...(set.selectedVersion ? { selectedVersion: set.selectedVersion } : {}),
  };
}

/**
 * 追加一笔任务版本（**同一格重跑的落点**）。
 *
 * 契约（形状照 `addShotCandidate`）：
 *   · 脏笔（`version` 解析不出）→ `{ accepted:false, reason:"invalid" }`
 *   · 同 `version`（同一任务重放）→ `duplicate`（幂等：不重复登记同一笔任务）
 *   · 已满 `MAX_TASK_VERSIONS_PER_NODE` → `full`（**明说塞不下，不静默裁掉旧版本**）
 *   · **旧版本一律留在清单里**（append-only；本函式没有任何「覆盖同版」的路径）
 *   · 首笔自动上星标（本格要有采用稿；后续只加不抢星标——星标移动只走
 *     `selectTaskVersion`，避免「跑完就自动换稿」的隐式改稿）
 */
export function appendTaskVersion(set: TaskVersionSet | undefined, raw: unknown): TaskVersionMutation {
  const current = set ? copySet(set) : { items: [] };
  const entry = normalizeTaskVersionEntry(raw);
  if (!entry) return { set: current, accepted: false, reason: "invalid" };
  if (current.items.some((item) => item.version === entry.version)) {
    return { set: current, accepted: false, reason: "duplicate" };
  }
  if (current.items.length >= MAX_TASK_VERSIONS_PER_NODE) {
    return { set: current, accepted: false, reason: "full" };
  }
  const items = [...current.items, entry].sort(byVersion);
  return {
    set: { items, selectedVersion: current.selectedVersion ?? entry.version },
    accepted: true,
  };
}

/** 任务状态/交付物的回填补丁（只做回填，不做清除：清除＝删版本再追加）。 */
export interface TaskVersionPatch {
  status?: string | null;
  url?: string | null;
  taskId?: string | null;
}

/**
 * 就地回填某一版任务（同一任务跑完时写状态/交付 URL）。**版本不变** ⇒ 不产生新版本
 * （「同一任务的进度」不是新版本，这正是 D37 要求 Version 不能覆盖的镜像面）。
 * 找不到该版 → `updated:false`（不改集合）；补丁值清洗不出来 → 该栏不动（不把好值洗成空）。
 */
export function updateTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
  patch: TaskVersionPatch,
): { set: TaskVersionSet; updated: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target) return { set: current, updated: false };
  const index = current.items.findIndex((item) => item.version === target);
  if (index < 0) return { set: current, updated: false };

  const existing = current.items[index];
  const status = TASK_STATUSES.includes(patch.status as CanvasNodeStatus)
    ? (patch.status as CanvasNodeStatus)
    : undefined;
  const url = trimmed(patch.url, TASK_URL_MAX);
  const taskId = trimmed(patch.taskId, TASK_ID_MAX);
  const next: TaskVersionEntry = {
    version: existing.version,
    ...((taskId ?? existing.taskId) ? { taskId: taskId ?? existing.taskId } : {}),
    ...((status ?? existing.status) ? { status: status ?? existing.status } : {}),
    tags: existing.tags,
    ...((url ?? existing.url) ? { url: url ?? existing.url } : {}),
  };
  const items = [...current.items];
  items[index] = next;
  return { set: { items, ...(current.selectedVersion ? { selectedVersion: current.selectedVersion } : {}) }, updated: true };
}

/**
 * 星标选定（D37 素材 `Selected`）：只有集合成员可被选中，非成员＝不改
 * （`selected:false`，不制造悬空星标）。
 */
export function selectTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
): { set: TaskVersionSet; selected: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target || !current.items.some((item) => item.version === target)) {
    return { set: current, selected: false };
  }
  return { set: { items: current.items, selectedVersion: target }, selected: true };
}

/**
 * 删一版任务（腾出版本位子的唯一手段）。
 *
 * **选中者被删除时的处置（明确定义，照既有语义，不造第三套）**：
 * 回退到**剩余清单第一条**＝`reducer.ts` 批次主图「主图被删 → fallback 剩余第一个」
 * （`batchPrimaryImageId: kept[0]`，reducer.ts:346-347）与 `removeShotCandidate` 的
 * `items[0]`，逐字同款。全删光＝没有 `selectedVersion`（空集合由
 * `taskVersionsMetadata` 收成省略键）。
 *
 * 注记（诚实）：本档的清单是**时序升序**（末条最新），故「剩余第一条」＝最旧的一笔。
 * 这是照既有回退语义的直接结果；若产品要「回退到最新」，那是**新的**语义，需另开裁定，
 * 本档不擅自发明。
 */
export function removeTaskVersion(
  set: TaskVersionSet | undefined,
  version: string,
): { set: TaskVersionSet; removed: boolean } {
  const current = set ? copySet(set) : { items: [] };
  const target = normalizeTaskVersion(version);
  if (!target || !current.items.some((item) => item.version === target)) {
    return { set: current, removed: false };
  }
  const items = current.items.filter((item) => item.version !== target);
  const selectedVersion =
    current.selectedVersion && current.selectedVersion !== target
      ? current.selectedVersion
      : items[0]?.version;
  return {
    set: { items, ...(selectedVersion ? { selectedVersion } : {}) },
    removed: true,
  };
}

// ─────────────────────────────────────────── 查询／分组

/** 某一版任务（找不到＝`null`）。 */
export function taskVersionOf(set: TaskVersionSet | null | undefined, version: string): TaskVersionEntry | null {
  const target = normalizeTaskVersion(version);
  if (!target) return null;
  return set?.items.find((item) => item.version === target) ?? null;
}

/** 最新一笔任务（时序最大；空集合＝`null`）。 */
export function latestTaskVersion(set: TaskVersionSet | null | undefined): TaskVersionEntry | null {
  if (!set?.items.length) return null;
  return set.items[set.items.length - 1];
}

/** 星标选中的任务版本（采用稿）；未选定／集合空＝`null`。 */
export function selectedTaskVersion(set: TaskVersionSet | null | undefined): TaskVersionEntry | null {
  if (!set?.selectedVersion) return null;
  return set.items.find((item) => item.version === set.selectedVersion) ?? null;
}

/** 星标选中那版任务的交付 URL（＝本格采用稿的素材）；没有＝`null`。 */
export function selectedTaskVersionUrl(set: TaskVersionSet | null | undefined): string | null {
  return selectedTaskVersion(set)?.url ?? null;
}

/** 该标签的任务版本（集合内查询；保序）。 */
export function taskVersionsByTag(
  set: TaskVersionSet | null | undefined,
  tag: TaskTag,
): TaskVersionEntry[] {
  if (!set) return [];
  return set.items.filter((item) => item.tags.includes(tag));
}

/** 一组标签分组（只出非空的组，顺序＝`TASK_TAGS` 值域序，稳定可比对）。 */
export interface TaskTagGroup {
  tag: TaskTag;
  items: TaskVersionEntry[];
}

export function groupTaskVersionsByTag(set: TaskVersionSet | null | undefined): TaskTagGroup[] {
  return TASK_TAGS.map((tag) => ({ tag, items: taskVersionsByTag(set, tag) })).filter(
    (group) => group.items.length > 0,
  );
}

/** 画布层的一条标签命中（节点 id ＋ 该笔任务版本）。 */
export interface CanvasTaskVersionRef {
  nodeId: string;
  entry: TaskVersionEntry;
}

/**
 * 跨格的标签查询（画布层分组的唯一入口）：
 * 逐节点读 `metadata.taskVersions`，收该标签的任务版本（节点序 × 版本时序）。
 * 没有该键的节点＝零命中（不臆造）。
 */
export function taskVersionsWithTag(
  nodes: readonly CanvasNode[],
  tag: TaskTag,
): CanvasTaskVersionRef[] {
  const out: CanvasTaskVersionRef[] = [];
  if (!isTaskTag(tag)) return out;
  for (const node of nodes) {
    const set = readTaskVersions(node?.metadata);
    if (!set) continue;
    for (const entry of taskVersionsByTag(set, tag)) out.push({ nodeId: node.id, entry });
  }
  return out;
}