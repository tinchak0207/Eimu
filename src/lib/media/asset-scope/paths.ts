import { boundedSegment, isUsableAssetId, keySegment, toAssetKind } from "./normalize";
import type { AssetKind, AssetMountCopyMode, AssetMountCopyPlan, AssetMountCopyRejectReason, AssetMountRecord } from "./types";
import { MAX_PROJECT_ID_LENGTH } from "./types";

// ─────────────────────────────────────────── 挂用（项目资产库成员）

/**
 * REQ-B2b：挂用＝**copy-on-use**（暴君 09-23 裁定）——挂用记录是「来源 → 目标」的连接记录，
 * 目标项目里的**本地副本**由 `localCopyId` 指名（副本自足：来源删除不影响副本）。
 * 本档只做纯推导；副本本体的落地在 asset-library.mountAssetWithCopy。
 */

// ── 副本键（确定性、无分隔符、段内单射语义）

/**
 * 副本键杂凑：4 条 32 位元 FNV-1a 车道（不同播种）拼成 32 位十六进位。
 * 为何不用 node:crypto：本档前端也会载入（character-cards → 角色卡面板 → 画布），
 * 且 tsconfig target=ES2017（BigInt 字面量不可用）；Math.imul 版可前后端同码。
 * 128 位元在同帐号资产量级（≤数百）下碰撞机率可忽略，且**碰撞不得静默**：
 * 建副本前会验证同 id 卡是否真是这条来源的副本（asset-library 的
 * AssetMountCopyConflictError），不是就 409，不当成幂等重放。
 */
function fnv1aLane(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function copyKeyHash(input: string, namespace: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = "";
  for (const seed of seeds) {
    const lane = fnv1aLane(`${namespace}\u0000${input}`, seed);
    out += lane.toString(16).padStart(8, "0");
  }
  return out;
}

/**
 * 副本键的规范编码：`{namespace}:{len}:{projectId}:{kind}:{len}:{sourceKey}`。
 * 段长度前缀＝单射（`("x:card:y")` 与 `("x","y")` 不撞），namespace 再切开
 * 「资产卡副本」与「包内条目副本」两族——裸 `:` 拼接正是旧版撞键源。
 * **此字串只作杂凑输入，永不落成资产 id**（落地的 id 是十六进位，不含分隔符）。
 */
function canonicalCopyKey(namespace: string, projectId: string, assetKind: AssetKind, sourceKey: string): string {
  return `${namespace}:${keySegment(projectId)}:${assetKind}:${keySegment(sourceKey)}`;
}

/** 副本 id 前缀（`copy-` 家族；`cp-` 短前缀给包内条目以免与卡 id 混形）。 */
const COPY_ID_PREFIX = "copy-";

/**
 * 资产副本的确定性 id（同 `(projectId, assetKind, sourceAssetId)` → 恒同一个 id）。
 * 性质：**不含分隔符**（纯 `[a-z0-9-]`，可直接当资产卡 id）、长度固定 42 字元（卡 id 上限 100 内）、
 * 与 mount/share 键**不同形**（后两者以 `share:` / `mount:` 开头且含分隔符）。
 */
export function assetLocalCopyId(projectId: string, assetKind: AssetKind, sourceAssetId: string): string {
  const hash = copyKeyHash(canonicalCopyKey("copy", projectId, assetKind, sourceAssetId), "asset-copy");
  return `${COPY_ID_PREFIX}${assetKind}-${hash}`;
}

/** 包内条目的来源把手（只在杂凑输入内用：`{len}:{packId}#{index}`——包 id 与序号共同定位条目）。 */
export function assetPackItemSourceKey(packId: string, itemIndex: number): string {
  return `${keySegment(packId)}#${itemIndex}`;
}

/**
 * 包内条目复制成卡时的确定性 id（同 `(projectId, packId, itemIndex)` → 恒同一张卡）。
 * 与 `assetLocalCopyId` 用**不同 namespace**，故「卡的副本」与「包条目的副本」不可能撞键。
 */
export function assetPackItemCopyId(projectId: string, packId: string, itemIndex: number): string {
  const hash = copyKeyHash(
    canonicalCopyKey("pack-item", projectId, "card", assetPackItemSourceKey(packId, itemIndex)),
    "asset-copy",
  );
  return `${COPY_ID_PREFIX}card-${hash}`;
}

/** 资产包本身的本地副本 id（副本单位＝卡，包副本只是让目标项目有本地包记录）。 */
export function assetPackLocalCopyId(projectId: string, packId: string): string {
  return assetLocalCopyId(projectId, "pack", packId);
}

/**
 * 这个 id 是不是 copy-on-use 落地的**内部副本**（`copy-card-<32hex>` / `copy-pack-<32hex>`）。
 *
 * 为什么需要这个判据：副本与使用者资产同住一套 store，若不区分就会被当成可挂用条目列出，
 * 使用者（或 UI）再挂用一次＝在**同一个项目**里生出「副本的副本」→ 卡片额度无限膨胀（D5）。
 * 判据用**家族前缀 + 固定长度十六进位**（不是「有 lineage 就算是副本」：使用者资产也可能有血统）。
 */
export function isAssetLocalCopyId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^copy-(card|pack)-[0-9a-f]{32}$/.test(value.trim());
}

/** 挂用记录的确定性 id（段长度前缀 = 单射，禁裸 `:` 拼接）。 */
export function assetMountId(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 挂用的幂等键（与 id 分开命名：一个是记录主键，一个是计费/幂等链的键）。 */
export function assetMountIdempotencyRef(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `asset-mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 项目资产库列表的「已挂用」键（kind + id 同一种编码，禁与 id 拼接混用）。 */
export function mountedAssetKey(assetKind: AssetKind, assetId: string): string {
  return `${assetKind}:${keySegment(assetId)}`;
}

/** 卡副本清单的清洗收口（去重、保序、逐笔过 id 边界；非法值丢弃而非截断）。 */
function normalizeCopyIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (!isUsableAssetId(value)) continue;
    const id = value.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 清洗挂用记录（存档/读档唯一收口；id、idempotencyRef、localCopyId 一律重新推导）。 */
export function normalizeAssetMount(raw: unknown): AssetMountRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AssetMountRecord>;
  const assetKind = toAssetKind(r.assetKind);
  const assetId = isUsableAssetId(r.assetId) ? r.assetId.trim() : "";
  const projectId = boundedSegment(r.projectId, MAX_PROJECT_ID_LENGTH);
  if (!assetKind || !assetId || !projectId) return null;
  const cardCopyIds = normalizeCopyIdList(r.cardCopyIds);
  return {
    id: assetMountId(projectId, assetKind, assetId),
    projectId,
    assetKind,
    assetId,
    localCopyId: assetLocalCopyId(projectId, assetKind, assetId),
    ...(cardCopyIds.length ? { cardCopyIds } : {}),
    idempotencyRef: assetMountIdempotencyRef(projectId, assetKind, assetId),
    mountedAt: typeof r.mountedAt === "string" ? r.mountedAt : new Date().toISOString(),
  };
}

/**
 * 幂等挂用（纯函式）：
 * - 同 `(projectId, assetKind, assetId)` 已存在 → 原样返回 created:false，**不新增第二笔**，
 *   且 `localCopyId` 逐位相同（同一个来源在同一个项目里只有一份副本 = 幂等一份）。
 *   `cardCopyIds` 取**联集**（挂用期间来源追加条目、重放补建了新副本 → 清单必须跟上，
 *   否则解除时解锁不全 = D1「已解除但仍被注入」）；清单没变 → `updated:false`（零副作用）。
 * - 同键但三元组不同 → **conflict:true**（真碰撞/别名，呼叫端必须回 409，禁静默成功）。
 * 这是「跨项目复用不双扣 / 不建第二份副本」在作用域层的落点。
 */
export function applyAssetMount(
  mounts: readonly AssetMountRecord[],
  input: { projectId: string; assetKind: AssetKind; assetId: string; now?: string; cardCopyIds?: readonly string[] },
): {
  mounts: AssetMountRecord[];
  mount: AssetMountRecord;
  created: boolean;
  conflict: boolean;
  /** 既有记录的卡副本清单被这次呼叫扩充了（呼叫端据此决定要不要落盘）。 */
  updated: boolean;
} {
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    mountedAt: input.now ?? new Date().toISOString(),
    ...(input.cardCopyIds ? { cardCopyIds: [...input.cardCopyIds] } : {}),
  });
  if (!normalized) throw new Error("invalid asset mount");
  const existing = mounts.find((m) => m.id === normalized.id);
  if (!existing) {
    return { mounts: [...mounts, normalized], mount: normalized, created: true, conflict: false, updated: false };
  }
  if (!sameMountTriple(existing, normalized)) {
    return { mounts: [...mounts], mount: existing, created: false, conflict: true, updated: false };
  }
  const merged = normalizeCopyIdList([...(existing.cardCopyIds ?? []), ...(normalized.cardCopyIds ?? [])]);
  const updated = merged.length !== (existing.cardCopyIds?.length ?? 0);
  if (!updated) {
    // 同键重放：回**既有**那一笔（其 localCopyId 与推导值逐位相同 → 指向同一份副本）。
    return { mounts: [...mounts], mount: existing, created: false, conflict: false, updated: false };
  }
  const next: AssetMountRecord = { ...existing, cardCopyIds: merged };
  return {
    mounts: mounts.map((m) => (m.id === next.id ? next : m)),
    mount: next,
    created: false,
    conflict: false,
    updated: true,
  };
}

/** 挂用三元组逐栏等值。 */
function sameMountTriple(a: AssetMountRecord, b: AssetMountRecord): boolean {
  return a.projectId === b.projectId && a.assetKind === b.assetKind && a.assetId === b.assetId;
}

/**
 * **挂用 copy-on-use 与引用制的唯一分歧点**（纯函式、零 IO）：
 * 决定「这次挂用要不要建副本、副本 id 是什么、是不是幂等重放、是不是环」。
 * 呼叫端（asset-library.mountAssetWithCopy）只照计画执行，不另立规则。
 *
 * 环路守卫（递归挂用可回溯、环路必拒）：
 * 1. 副本 id === 来源 id → self_reference（会写出自引用血统边）；
 * 2. 来源的祖先链已含来源自己 → cyclic_lineage（既有资料成环，拒绝延伸）；
 * 3. 计画建的副本已在来源的祖先链里 → cyclic_lineage（副本会成为自己的祖先）。
 * 注意：**「把副本再挂回它来源所属的项目」不是环**（每次挂用产生的是新节点，
 * 其血统边指向来源链），故不在此拒绝——递归挂用是被允许且可回溯的。
 *
 * `established`（D4 裁定）：呼叫端**已**由 store 实测出「同键挂用记录存在 + 该次副本已落地」
 * 时设 true → 跳过 2/3 两条环路守卫。理由：既成事实不得被**事后**的血统编辑（例如把副本 id
 * 写进来源自己的 lineage）打成 400；这条路径是幂等重放，不是新的延伸。
 * 首次挂用一律 established=false，守卫一条不少。
 */
export function planAssetMountCopy(input: {
  projectId: string;
  assetKind: AssetKind;
  sourceAssetId: string;
  mode?: AssetMountCopyMode;
  /** 目标项目既有的副本 id 集（呼叫端由 store 读；缺省＝空）。 */
  existingCopyIds?: readonly string[];
  /** 来源的血统祖先把手（呼叫端完整解析后填入；缺省＝无祖先）。 */
  ancestorAssetIds?: readonly string[];
  /** 已成立的幂等重放（见上）：跳过环路守卫，其余语义不变。 */
  established?: boolean;
}): { ok: true; plan: AssetMountCopyPlan } | { ok: false; reason: AssetMountCopyRejectReason } {
  const mode = input.mode ?? "copy-on-use";
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.sourceAssetId,
  });
  if (!normalized) throw new Error("invalid asset mount");
  const localCopyId = normalized.localCopyId;
  if (localCopyId === normalized.assetId) return { ok: false, reason: "self_reference" };
  const ancestors = new Set<string>();
  for (const id of input.ancestorAssetIds ?? []) {
    if (typeof id === "string" && id) ancestors.add(id);
  }
  if (!input.established) {
    if (ancestors.has(normalized.assetId)) return { ok: false, reason: "cyclic_lineage" };
    if (ancestors.has(localCopyId)) return { ok: false, reason: "cyclic_lineage" };
  }
  const existingCopyId = input.existingCopyIds?.includes(localCopyId) ? localCopyId : null;
  const wantsCopy = mode === "copy-on-use";
  return {
    ok: true,
    plan: {
      mode,
      localCopyId: wantsCopy ? localCopyId : null,
      existingCopyId,
      shouldCreateCopy: wantsCopy && !existingCopyId,
      mountId: normalized.id,
      idempotencyRef: normalized.idempotencyRef,
      projectId: normalized.projectId,
      assetKind: normalized.assetKind,
      sourceAssetId: normalized.assetId,
    },
  };
}

/** 解除挂用（按确定性 id）。回是否真的移除了。 */
export function applyAssetUnmount(
  mounts: readonly AssetMountRecord[],
  mountId: string,
): { mounts: AssetMountRecord[]; removed: boolean } {
  const next = mounts.filter((m) => m.id !== mountId);
  return { mounts: next, removed: next.length !== mounts.length };
}

/** 某项目当前挂用的资产键集合（列表标记 mounted 用；键段与 id 同一种单射编码）。 */
export function mountedAssetKeys(mounts: readonly AssetMountRecord[], projectId: string): Set<string> {
  const keys = new Set<string>();
  for (const m of mounts) {
    if (m.projectId !== projectId) continue;
    keys.add(mountedAssetKey(m.assetKind, m.assetId));
  }
  return keys;
}
