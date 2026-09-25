// 資產血統（REQ-D1）：純資料層——序列化形態、清洗收口、鏈條構建與兩態判定。
//
// 裁決邊界（2026-09-22 暴君四刀，見 PRD REQ-D1）：
//   * 血統只給人看：宿主是歷史記錄（HistoryEntry）與資產卡（CharacterCard）本體，
//     嚴禁補進 compactMetadataForAgent（agent 不讀血統是裁決），也不進 canvas 節點 metadata。
//   * 欄位族復用現成資產/歷史表示：`lineage: Array<{kind, assetId?, jobId?, nodeId?, at}>`，
//     parents 上限 5，超過截尾並顯式標註截斷（`lineageTruncated: true` 兄弟欄，
//     截斷資訊必須落在數據上，否則讀時 UI 無法區分「恰好 5 個」與「被砍過」）。
//   * 已刪除 ≠ 來源不明，兩個態必須分開：parent 有把手但查無記錄 = 已刪除；
//     本體完全沒有血統登記 = 來源不明。
//
// 本檔零依賴（不 import 帶 node API 或端別專屬的模組），前端抽屜、後端寫入掛鉤
// 與 tools/ 回溯補丁共用同一把尺。

// ─────────────────────────────────────────────── 欄位族

export const LINEAGE_KIND_VALUES = ["reference", "derivation", "remix", "rerun"] as const;
export type LineageKind = (typeof LINEAGE_KIND_VALUES)[number];

/** 血統條目四種來源語義的 UI 標籤（詞表唯一 owner 是本檔）。 */
export const LINEAGE_KIND_LABEL: Record<LineageKind, string> = {
  reference: "参考",
  derivation: "衍生",
  remix: "混编",
  rerun: "重跑",
};

export interface LineageLink {
  kind: LineageKind;
  /** 資產把手：卡 id（`card-…`）、資產包歷史把手（`history-…`）或產物 artifact id。 */
  assetId?: string;
  /** 任務把手：generation job / taskId。 */
  jobId?: string;
  /** 畫布節點把手：序列化形態預留（裁決④畫布不畫血統邊，本期掛鉤不產出）。 */
  nodeId?: string;
  /** ISO 8601 時間戳。 */
  at: string;
}

/** parents 上限（暴君裁決定數）：超過截尾並顯式標註截斷。 */
export const MAX_LINEAGE_PARENTS = 5;

/** 宿主本體上承載血統的欄位族（HistoryEntry 與 CharacterCard 共用同形）。 */
export interface LineageHostFields {
  lineage?: LineageLink[];
  /** 顯式截斷標記：登記時曾有超過上限的直接來源被砍尾。 */
  lineageTruncated?: boolean;
}

const MAX_HANDLE_LENGTH = 160;

// ─────────────────────────────────────────────── 清洗與序列化

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把手清洗：非空、限長、不帶空白/控制字元（全站 id 形態都滿足；灌串的丟棄）。 */
export function cleanLineageHandle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HANDLE_LENGTH) return undefined;
  for (const ch of trimmed) {
    if (ch <= " " || ch === "\u007f") return undefined;
  }
  return trimmed;
}

/** `at` 只收 ISO 8601 可解析字串；缺省補當前時間（登記动作本身發生在「現在」）。 */
function cleanLineageAt(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && !Number.isNaN(Date.parse(trimmed))) return new Date(trimmed).toISOString();
  }
  return new Date().toISOString();
}

export function isLineageKind(value: unknown): value is LineageKind {
  return typeof value === "string" && (LINEAGE_KIND_VALUES as readonly string[]).includes(value);
}

/** 單條血統：kind 非法丟整條；三個把手全缺也丟（無把手的血統既無法跳轉也無法判「已刪除」）。 */
export function normalizeLineageLink(raw: unknown): LineageLink | null {
  if (!isRecord(raw)) return null;
  if (!isLineageKind(raw.kind)) return null;
  const assetId = cleanLineageHandle(raw.assetId);
  const jobId = cleanLineageHandle(raw.jobId);
  const nodeId = cleanLineageHandle(raw.nodeId);
  if (!assetId && !jobId && !nodeId) return null;
  return {
    kind: raw.kind,
    ...(assetId ? { assetId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(nodeId ? { nodeId } : {}),
    at: cleanLineageAt(raw.at),
  };
}

/** 血統條目的身份鍵：同 kind + 同把手 = 同一條（冪等合併的判據）。 */
function linkKey(link: LineageLink): string {
  return `${link.kind}|${link.assetId ?? ""}|${link.jobId ?? ""}|${link.nodeId ?? ""}`;
}

/**
 * 清洗一組血統登記：逐條白名單 → 去重（保留首見）→ 上限截尾。
 * truncated 只在「有合法條目被上限砍掉」時為 true（重複不計），
 * 這是「顯式標註截斷」的數據面，UI 據它顯示「僅保留最近 5 個直接來源」。
 */
export function normalizeLineageLinks(raw: unknown): { parents: LineageLink[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { parents: [], truncated: false };
  const seen = new Set<string>();
  const parents: LineageLink[] = [];
  let overflow = false;
  for (const item of raw) {
    const link = normalizeLineageLink(item);
    if (!link) continue;
    const key = linkKey(link);
    if (seen.has(key)) continue;
    if (parents.length >= MAX_LINEAGE_PARENTS) {
      overflow = true;
      continue;
    }
    seen.add(key);
    parents.push(link);
  }
  return { parents, truncated: overflow };
}

/** 讀宿主欄位族：完全未登記血統返回 null（＝來源不明），登記了返回清洗後結果。 */
export function readHostLineage(host: Partial<LineageHostFields> | null | undefined): {
  parents: LineageLink[];
  truncated: boolean;
} | null {
  if (!host || !Array.isArray(host.lineage)) return null;
  const { parents, truncated } = normalizeLineageLinks(host.lineage);
  return { parents, truncated: truncated || host.lineageTruncated === true };
}

/**
 * 把新生成的血統登記併進宿主欄位（寫入掛鉤與回溯補丁共用的冪等入口）：
 *   - 既有條目原樣保留（含其 at），新條目按 key 去重——重跑同一掛鉤不會雙登記；
 *   - 合併後統一過上限，溢出時顯式標註截斷；
 *   - 冪等：mergeLineageIntoHost(host, readHostLineage(host).parents) 與 host 等價。
 * 返回 null 表示沒有任何可寫內容（新舊皆空），調用方據此不落欄位。
 */
export function mergeLineageIntoHost(
  host: Partial<LineageHostFields> | null | undefined,
  added: LineageLink[],
): LineageHostFields | null {
  const existing = Array.isArray(host?.lineage) ? host.lineage : [];
  if (!existing.length && !added.length) return null;
  const { parents, truncated } = normalizeLineageLinks([...existing, ...added]);
  if (!parents.length) return null;
  return {
    lineage: parents,
    ...(truncated || host?.lineageTruncated === true ? { lineageTruncated: true } : {}),
  };
}

/** 序列化/反序列化往返（交付件要求形態可序列化；導出本期不做，口子留在這）。 */
export function serializeLineageFields(host: Partial<LineageHostFields>): string {
  return JSON.stringify({
    ...(host.lineage ? { lineage: host.lineage } : {}),
    ...(host.lineageTruncated ? { lineageTruncated: true } : {}),
  });
}

export function parseLineageFields(text: string): LineageHostFields | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const merged = mergeLineageIntoHost(null, Array.isArray(parsed.lineage) ? parsed.lineage : []);
    if (!merged) return null;
    if (parsed.lineageTruncated === true) merged.lineageTruncated = true;
    return merged;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────── 生成管線把手提取

/** 生成管線里帶血統線索的參考圖元數據（歷史 workflow.referenceImages 與 job workflow.references 的交集形態）。 */
export interface LineageBearingReference {
  sourceResultId?: string | null;
  sourceGenerationId?: string | null;
}

/**
 * 掛鉤 a 的共用尺：從 job/歷史記錄的參考圖元數據提取 parents。
 *   - sourceGenerationId（參考圖出自另一條生成任務）→ derivation，jobId 指回源任務；
 *   - 僅 sourceResultId（直接引用某產物 artifact）→ reference，assetId 指回產物；
 *   - 裸上傳參考圖（兩個把手都沒有）不登記：沒有持久身份的來源無法跳轉，
 *     登記了只会製造永久「查無」的假鏈條。
 * at 用本次生成時間；去重合併統一交給 mergeLineageIntoHost。
 */
export function parentsFromReferences(
  references: readonly LineageBearingReference[] | null | undefined,
  at: string,
): LineageLink[] {
  if (!Array.isArray(references)) return [];
  const links: LineageLink[] = [];
  for (const ref of references) {
    if (!isRecord(ref)) continue;
    const jobId = cleanLineageHandle(ref.sourceGenerationId);
    const assetId = cleanLineageHandle(ref.sourceResultId);
    if (jobId) links.push({ kind: "derivation", jobId, at });
    else if (assetId) links.push({ kind: "reference", assetId, at });
  }
  return links;
}

/** 歷史記錄自身可被血統引用的把手（抽屜解析與掛鉤 b 共用同一套鍵）。 */
export function historyEntryHandles(entry: {
  id: string;
  taskId?: string | null;
  results?: readonly { resultId?: string | null }[] | null;
}): { jobId?: string; assetIds: string[] } {
  // jobId 只認真任務 id：同步直出記錄的 entry.id 不是 job（沒有 generation_job 行），
  // 冒充 jobId 會讓「已刪除」態對不上真正的任務記錄——它統一走 `history-${id}` 資產把手。
  const jobId = cleanLineageHandle(entry.taskId);
  const assetIds: string[] = [];
  const asAsset = `history-${entry.id}`; // 資產包「存为资产」既有慣例（HistoryCard upsert id）。
  if (cleanLineageHandle(asAsset)) assetIds.push(asAsset);
  // 產物 artifact id 也是可被引用的把手（sourceResultId 指回的就是它）。
  for (const result of entry.results ?? []) {
    const resultId = cleanLineageHandle(result?.resultId);
    if (resultId && !assetIds.includes(resultId)) assetIds.push(resultId);
  }
  return { ...(jobId ? { jobId } : {}), assetIds };
}

/** 把記錄的血統 parents 寫進宿主欄位族用的統一時間源（掛鉤 b/c 登記時刻）。 */
export function lineageTimestamp(millis: number): string {
  const ms = Number.isFinite(millis) && millis > 0 ? millis : Date.now();
  return new Date(ms).toISOString();
}

// ─────────────────────────────────────────────── 鏈條構建（抽屜讀取端）

/** 池子為抽屜提供「把手 → 記錄」的解析與展示信息。 */
export interface LineageRecordView extends LineageHostFields {
  /** 該記錄自身的把手（判自引用與跳轉用）。 */
  selfHandles: { jobId?: string; assetId?: string };
  /** 一行描述（prompt 前綴 / 卡名）。 */
  label: string;
  /** 縮圖 URL（歷史結果圖 / 卡參考圖首張），無則 null。 */
  thumbnailUrl: string | null;
  /** 時間（毫秒），無法解析時 null。 */
  timeMs: number | null;
}

export interface LineagePool {
  /** 給一個血統把手，找回記錄；池查無返回 null（＝已刪除態的依據）。 */
  find(jobId: string | undefined, assetId: string | undefined): LineageRecordView | null;
}

export type LineageNodeStatus =
  | "root"
  | "resolved"
  /** parent 有把手但記錄查無（曾有引用）＝已刪除。 */
  | "deleted"
  /** 該級存在但沒有血統登記（回溯補不回的存量）＝來源不明。 */
  | "unknown-origin"
  /** 鏈條指回自己（自引用守衛，不遞歸）。 */
  | "self"
  /** 鏈條成環（祖先裡已出現同一把手）。 */
  | "cycle"
  /** 被深度/節點預算截斷。 */
  | "pruned";

export interface LineageTreeNode {
  /** null = 根（正在看的那條記錄）。 */
  link: LineageLink | null;
  status: LineageNodeStatus;
  depth: number;
  label: string;
  thumbnailUrl: string | null;
  timeMs: number | null;
  /** 該記錄登記的 parents 是否曾被上限砍尾。 */
  truncated: boolean;
  /** 可跳轉目標（resolved/Deleted/pruned 節點带把手；self/unknown-origin 無從跳）。 */
  jumpTo: { jobId?: string; assetId?: string } | null;
  children: LineageTreeNode[];
}

/** 默認展開層數（暴君裁決：3 層＋「繼續向上」）。 */
export const LINEAGE_DEFAULT_DEPTH = 3;
/** 「繼續向上」每次追加的層數。 */
export const LINEAGE_DEPTH_STEP = 3;
/** 全鏈節點預算：防病態圖把抽屜卡死；超預算的子鏈標 pruned。 */
export const LINEAGE_MAX_NODES = 200;

interface TreeBuildContext {
  pool: LineagePool;
  /** 共享可變預算：必須跨兄弟鏈與遞歸共用同一個對象，快照式 spread 會把深鏈的耗計漏掉。 */
  budget: { remaining: number };
  maxDepth: number;
}

function handleKeysOf(handles: { jobId?: string; assetId?: string }): string[] {
  const keys: string[] = [];
  if (handles.jobId) keys.push(`job:${handles.jobId}`);
  if (handles.assetId) keys.push(`asset:${handles.assetId}`);
  return keys;
}

function linkHandles(link: LineageLink): { jobId?: string; assetId?: string } {
  // nodeId 本期不產出也不解析（畫布不畫血統邊；池裡也沒有節點記錄）。
  return {
    ...(link.jobId ? { jobId: link.jobId } : {}),
    ...(link.assetId ? { assetId: link.assetId } : {}),
  };
}

function cloneHandles(handles: { jobId?: string; assetId?: string }): { jobId?: string; assetId?: string } | null {
  const cloned = {
    ...(handles.jobId ? { jobId: handles.jobId } : {}),
    ...(handles.assetId ? { assetId: handles.assetId } : {}),
  };
  return Object.keys(cloned).length ? cloned : null;
}

function linkMatchesHandles(link: LineageLink, handles: { jobId?: string; assetId?: string }): boolean {
  return Boolean((link.jobId && link.jobId === handles.jobId) || (link.assetId && link.assetId === handles.assetId));
}

function buildChildren(
  record: LineageRecordView,
  ctx: TreeBuildContext,
  depth: number,
  path: Set<string>,
): {
  children: LineageTreeNode[];
  truncated: boolean;
} {
  const own = readHostLineage(record);
  const parents = own?.parents ?? [];
  const children: LineageTreeNode[] = [];
  for (const link of parents) {
    const handles = linkHandles(link);
    const kindLabel = LINEAGE_KIND_LABEL[link.kind];
    const linkTimeMs = Number.isFinite(Date.parse(link.at)) ? Date.parse(link.at) : null;
    if (!handles.jobId && !handles.assetId) {
      children.push({ link, status: "unknown-origin", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: null, children: [] });
      continue;
    }
    if (linkMatchesHandles(link, record.selfHandles)) {
      children.push({ link, status: "self", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: null, children: [] });
      continue;
    }
    if (depth > ctx.maxDepth || ctx.budget.remaining <= 0) {
      children.push({ link, status: "pruned", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    const cycleKey = handleKeysOf(handles).find((key) => path.has(key));
    if (cycleKey) {
      children.push({ link, status: "cycle", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    ctx.budget.remaining -= 1;
    const found = ctx.pool.find(handles.jobId, handles.assetId);
    if (!found) {
      // 有把手、池查無、但血統登記確實在——曾有引用＝已刪除（與「來源不明」嚴格分開）。
      children.push({ link, status: "deleted", depth, label: kindLabel, thumbnailUrl: null, timeMs: linkTimeMs, truncated: false, jumpTo: cloneHandles(handles), children: [] });
      continue;
    }
    const nextPath = new Set(path);
    for (const key of handleKeysOf(found.selfHandles)) nextPath.add(key);
    const nested = buildChildren(found, ctx, depth + 1, nextPath);
    children.push({
      link,
      // 池找得到的祖先＝resolved（可看可跳）。它自己沒登記更高級鏈不降格本級——
      // 「來源不明」只屬於兩種場合：宿主面板無登記（rootHasLineage=false），
      // 或鏈中某級只有 kind 沒有把手（見上方的 unknown-origin 分支）。
      status: "resolved",
      depth,
      label: found.label || kindLabel,
      thumbnailUrl: found.thumbnailUrl,
      timeMs: found.timeMs ?? linkTimeMs,
      truncated: nested.truncated,
      jumpTo: cloneHandles(found.selfHandles),
      children: nested.children,
    });
  }
  return { children, truncated: own?.truncated ?? false };
}

/**
 * 以一條記錄為根，沿 parents 向上建鏈條樹（抽屜的讀取端）。
 *   - 根沒登記血統 → children=[]，調用方據 `rootHasLineage=false` 顯示「來源不明」；
 *   - 自引用標 self；成環標 cycle；超 maxDepth/預算標 pruned——都不誤報「已刪除」。
 */
export function buildLineageTree(
  root: LineageRecordView,
  pool: LineagePool,
  options: { maxDepth?: number; maxNodes?: number } = {},
): { tree: LineageTreeNode; rootHasLineage: boolean } {
  const ctx: TreeBuildContext = {
    pool,
    budget: { remaining: Math.max(1, options.maxNodes ?? LINEAGE_MAX_NODES) },
    maxDepth: options.maxDepth ?? LINEAGE_DEFAULT_DEPTH,
  };
  const sub = buildChildren(root, ctx, 1, new Set(handleKeysOf(root.selfHandles)));
  return {
    tree: {
      link: null,
      status: "root",
      depth: 0,
      label: root.label,
      thumbnailUrl: root.thumbnailUrl,
      timeMs: root.timeMs,
      truncated: sub.truncated,
      jumpTo: cloneHandles(root.selfHandles),
      children: sub.children,
    },
    rootHasLineage: Array.isArray(root.lineage),
  };
}

/** 把樹展平成可見行（缩進渲染用）：超出 visibleDepth 的鏈收合成一行「更深鏈條未展開」。 */
export function flattenLineageTree(tree: LineageTreeNode, visibleDepth: number): LineageTreeNode[] {
  const rows: LineageTreeNode[] = [];
  const walk = (node: LineageTreeNode) => {
    rows.push(node);
    if (!node.children.length) return;
    if (node.depth >= visibleDepth) {
      rows.push({
        link: null,
        status: "pruned",
        depth: node.depth + 1,
        label: "更深鏈條未展開",
        thumbnailUrl: null,
        timeMs: null,
        truncated: false,
        jumpTo: null,
        children: [],
      });
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return rows;
}