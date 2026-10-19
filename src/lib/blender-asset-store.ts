/**
 * 3D 资产入资产包 + bpy 脚本指纹索引（Astra 3D 导演工作站 P1-5，片I，2026-09-06）。
 *
 * 职责（成本护栏核心——相似委托命中脚本模板即零 token 复用，不触发渠道）：
 *   ① fingerprintScript —— bpy 脚本规范化（引号外去注释 + 空白折叠）后 FNV-1a 指纹。
 *   ② findTemplateByFingerprint —— 指纹命中既有 bpy_script 资产即回（含脚本全文+元数据），
 *      供上游「先命中再呼叫模型」。
 *   ③ saveSceneAssets —— bridge POST /v1/execute 产物（blend/glb）+ 脚本全文批量入
 *      资产包（kind scene_3d / bpy_script），幂等去重，回确定性存储 id 清单。
 *
 * 轮子对照（禁自造轮子铁律）：
 *   - 持久化 = 既有资产包真源 src/lib/asset-pack-store.ts（schema 枚举/normalize 分支
 *     已同构追加 scene_3d / bpy_script 两类，本档不自建第二套存储）。
 *   - 指纹 = blender-delegate.ts stableId 的 FNV-1a 同构（同一 offset basis 0x811c9dc5、
 *     prime 0x01000193、Math.imul 位运算）；因全仓 target ES2017 无 BigInt 字面量，
 *     64-bit 宽度以双通道 32-bit FNV-1a（lane2 异基 0x1f2be47c）拼接实现（等价方案）。
 *   - 产物形状真源 = src/lib/blender-tools.ts 的 BlenderArtifact（bridge 回传
 *     {path,bytes,kind}）；分拣/画布卡写入侧在 blender-delegate.ts（本档不碰）。
 *
 * 与规格的两处必要偏差（存储面对齐既有真源）：
 *   - findTemplateByFingerprint / saveSceneAssets 首参补 userId：资产包是
 *     per-user 持久化（asset-pack-store 全接口带 userId），无模组级用户上下文可省。
 *   - 脚本全文存 item.content（bpy_script 复用既有 content 栏，与 prompt/recipe
 *     同构）；bridge 产物只有 {path,bytes,kind}，脚本全文由呼叫端从委托执行侧带入。
 */

import { MAX_ITEMS_PER_PACK, listAssetPacks, saveAssetPack } from "./asset-pack-store";
import type { AssetPack, AssetPackItem } from "./asset-pack-store";
import type { BlenderArtifact } from "./blender-tools";

/** 3D 资产包固定 id（同构 chat-assets / canvas-assets 的确定性包 id 惯例）。 */
export const BLENDER_ASSET_PACK_ID = "blender-3d-assets";
const PACK_TITLE = "3D 资产库";

// ─────────────────────────────────────────── ① 脚本指纹

/** FNV-1a 32 常数（lane1 与 blender-delegate.ts stableId 逐字同构）。 */
const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
/** lane2 异基（0x811c9dc5 ^ 0x9e3779b9），双通道合计 64-bit 指纹宽度。 */
const FNV_OFFSET_32_LANE2 = 0x1f2be47c;

function fnv1a32(input: string, offsetBasis: number): number {
  let h = offsetBasis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME_32);
  }
  return h >>> 0;
}

/**
 * 规范化：去注释（仅引号外，感知 ' " ''' """ 与反斜线转义）+ 每行 trim +
 * 行内空白折叠（连续空白→单空格、丢空行、CRLF→LF）。
 *
 * 两个判断（规格授权自判）：
 *   - 保留缩进层级：Python 缩进即语义，全折叠会把语义不同的脚本撞成同指纹
 *     （模板库误命中 = 复用错脚本，比漏命中更贵）。
 *   - 变数名无关化不做：无 Python AST 支撑的字面改名会误伤字符串字面量，
 *     误判面大于收益。
 */
export function normalizeScript(script: string): string {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inString: "'" | '"' | "'''" | '"""' | null = null;
  for (const rawLine of lines) {
    let line = "";
    for (let i = 0; i < rawLine.length; i += 1) {
      const ch = rawLine[i];
      if (inString !== null) {
        const quote = inString[0];
        if (inString.length === 1 && ch === "\\" && i + 1 < rawLine.length) {
          line += ch + rawLine[i + 1];
          i += 1;
          continue;
        }
        if (inString.length === 3 && ch === quote && rawLine.slice(i, i + 3) === inString) {
          line += inString;
          i += 2;
          inString = null;
          continue;
        }
        if (inString.length === 1 && ch === quote) {
          line += ch;
          inString = null;
          continue;
        }
        line += ch;
        continue;
      }
      if (ch === "#") break;
      const triple = rawLine.slice(i, i + 3);
      if (triple === "'''" || triple === '"""') {
        inString = triple;
        line += triple;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inString = ch;
        line += ch;
        continue;
      }
      line += ch;
    }
    // 行内空白折叠（连续空白→单空格）；只去尾随空白，保留行首缩进
    // （Python 缩进即语义，trim() 会剥掉缩进造成误命中）。
    const collapsed = line.replace(/[ \t\f\v]+/g, " ");
    const trimmed = collapsed.endsWith(" ") ? collapsed.slice(0, -1) : collapsed;
    if (trimmed) out.push(trimmed);
  }
  return out.join("\n");
}

/**
 * bpy 脚本指纹：规范化后双通道 FNV-1a 32 拼接成 16 位 hex（64-bit 宽度）。
 * 确定性：同脚本必同指纹；去注释/空白差异后仍同指纹；不同脚本异指纹（见测试）。
 */
export function fingerprintScript(script: string): string {
  const normalized = normalizeScript(script);
  const lane1 = fnv1a32(normalized, FNV_OFFSET_32);
  const lane2 = fnv1a32(normalized, FNV_OFFSET_32_LANE2);
  return lane1.toString(16).padStart(8, "0") + lane2.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────── ② 指纹命中（先命中再呼叫模型）

/** 命中的脚本模板（含元数据 + 脚本全文，零 token 复用）。 */
export interface BpyScriptTemplate {
  packId: string;
  itemTitle: string;
  fingerprint: string;
  /** 脚本全文（AssetPackItem.content），直接可执行。 */
  script: string;
  artifactPath?: string;
  bytes?: number;
  sceneSummary?: string;
}

export type FindTemplateResult =
  | { ok: true; template: BpyScriptTemplate }
  | { ok: false; code: "invalid_fingerprint" | "not_found"; hint: string };

/**
 * 指纹查既有 bpy_script 资产：命中即回（含脚本全文与元数据）。
 * newest 优先（listAssetPacks 排序），只认「有脚本全文」的条目为可复用模板。
 */
export async function findTemplateByFingerprint(userId: number, fingerprint: string): Promise<FindTemplateResult> {
  const fp = typeof fingerprint === "string" ? fingerprint.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8,64}$/.test(fp)) {
    return {
      ok: false,
      code: "invalid_fingerprint",
      hint: "指纹格式非法（期望 8-64 位 hex）。请用 fingerprintScript(script) 生成后再查。",
    };
  }
  const packs = await listAssetPacks(userId);
  for (const pack of packs) {
    for (const item of pack.items) {
      if (item.kind !== "bpy_script") continue;
      const itemFp = (item.fingerprint ?? "").toLowerCase();
      if (itemFp !== fp) continue;
      if (typeof item.content !== "string" || item.content === "") continue;
      return {
        ok: true,
        template: {
          packId: pack.id,
          itemTitle: item.title,
          fingerprint: itemFp,
          script: item.content,
          ...(item.artifactPath ? { artifactPath: item.artifactPath } : {}),
          ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
          ...(item.sceneSummary ? { sceneSummary: item.sceneSummary } : {}),
        },
      };
    }
  }
  return {
    ok: false,
    code: "not_found",
    hint: "脚本模板库未命中该指纹：走首次设计路径（3D 导演产脚本，执行后自动入库）。",
  };
}

// ─────────────────────────────────────────── ③ bridge 产物批量入库

export interface SceneAssetSaveOptions {
  /** bridge scene_summary（可选，存进每个 item 的 sceneSummary）。 */
  scene_summary?: string;
  /** 委托单（可选；effect_description 作为标题基底）。 */
  delegation?: { effect_description?: string } | null;
  /** 本次执行的 bpy 脚本全文；提供时入库为 bpy_script 资产并产指纹。 */
  script?: string;
  /** 脚本档落盘路径（如桥工作目录 .py），可选。 */
  script_path?: string;
}

/** 确定性存储 id（内容位址，同构 blender-delegate.stableId 用法：取出端可重算同 id）。 */
export interface SavedSceneAssetRef {
  id: string;
  kind: "scene_3d" | "bpy_script";
  artifact_path?: string;
  fingerprint?: string;
}

export type SceneAssetSaveResult =
  | { ok: true; pack_id: string; items: SavedSceneAssetRef[]; deduped: number }
  | { ok: false; code: "no_assets"; hint: string };

function isValidArtifact(a: unknown): a is BlenderArtifact {
  return (
    !!a &&
    typeof a === "object" &&
    typeof (a as BlenderArtifact).path === "string" &&
    (a as BlenderArtifact).path !== "" &&
    typeof (a as BlenderArtifact).kind === "string" &&
    typeof (a as BlenderArtifact).bytes === "number" &&
    Number.isFinite((a as BlenderArtifact).bytes)
  );
}

function itemKey(item: AssetPackItem): string {
  if (item.kind === "bpy_script" && item.fingerprint) return `bpy_script:${item.fingerprint.toLowerCase()}`;
  if (item.kind === "scene_3d" && item.artifactPath) return `scene_3d:${item.artifactPath}`;
  return `${item.kind}:${item.title}`;
}

function itemId(item: AssetPackItem): string {
  const raw = `${item.kind}|${item.artifactPath ?? ""}|${item.fingerprint ?? ""}|${item.bytes ?? 0}`;
  return `bl3d-${fnv1a32(raw, FNV_OFFSET_32).toString(16).padStart(8, "0")}${fnv1a32(raw, FNV_OFFSET_32_LANE2).toString(16).padStart(8, "0")}`;
}

/**
 * bridge 产物批量入资产包（upsert 固定包 blender-3d-assets，幂等去重）：
 *   - kind blend/glb → AssetPackItem kind "scene_3d"（artifactPath/bytes/sceneSummary，
 *     fingerprint 带本次脚本指纹作「场景↔脚本」关联）。
 *   - script 全文 → AssetPackItem kind "bpy_script"（content=脚本全文、fingerprint、
 *     bytes=脚本位元组数）。
 *   - png/mp4 不入（画布场景卡侧 blender-delegate.ts 已管，职责不重叠）。
 * 上限与资产包铁律一致（MAX_ITEMS_PER_PACK，新资产优先保留）。
 */
export async function saveSceneAssets(
  userId: number,
  artifacts: readonly BlenderArtifact[],
  opts: SceneAssetSaveOptions = {},
): Promise<SceneAssetSaveResult> {
  const cleanArtifacts = (Array.isArray(artifacts) ? artifacts : []).filter(isValidArtifact);
  const sceneTargets = cleanArtifacts.filter((a) => a.kind === "blend" || a.kind === "glb");
  const script = typeof opts.script === "string" && opts.script.trim() !== "" ? opts.script : "";
  if (sceneTargets.length === 0 && !script) {
    return {
      ok: false,
      code: "no_assets",
      hint: "没有可入库的 3D 资产：artifacts 缺 blend/glb 产物且未带脚本全文。先跑 blender_render / blender_export_gltf 取得产物再入库。",
    };
  }

  const summary = typeof opts.scene_summary === "string" ? opts.scene_summary.trim() : "";
  const titleBase = (opts.delegation?.effect_description ?? "").trim() || summary || "3D 场景资产";
  const fingerprint = script ? fingerprintScript(script) : undefined;

  const fresh: AssetPackItem[] = [];
  if (script) {
    fresh.push({
      kind: "bpy_script",
      title: `bpy 脚本 · ${titleBase}`.slice(0, 200),
      content: script,
      ...(opts.script_path && opts.script_path.trim() !== "" ? { artifactPath: opts.script_path.trim() } : {}),
      bytes: Buffer.byteLength(script, "utf8"),
      ...(fingerprint ? { fingerprint } : {}),
      ...(summary ? { sceneSummary: summary } : {}),
      source: { type: "manual", id: "blender-delegation" },
    });
  }
  for (const a of sceneTargets) {
    fresh.push({
      kind: "scene_3d",
      title: `${a.kind.toUpperCase()} · ${titleBase}`.slice(0, 200),
      artifactPath: a.path,
      bytes: Math.max(0, Math.round(a.bytes)),
      ...(fingerprint ? { fingerprint } : {}),
      ...(summary ? { sceneSummary: summary } : {}),
      source: { type: "manual", id: "blender-delegation" },
    });
  }

  const existing = (await listAssetPacks(userId)).find((p) => p.id === BLENDER_ASSET_PACK_ID);

  // 去重合并：fresh 先行注册 key，existing 遇同 key 跳过（幂等重入库=零新增）。
  // 注意不预种 existing 的 key——合并回圈本身会重跑 existing 条目，预种会让
  // 每个既有条目「自己撞自己」被丢掉（包永远只剩本次新增）。
  // existingKeys 仅供 deduped 计数（fresh 撞既有 key = 本次重复入库），不参与合并判定。
  const existingKeys = new Set<string>((existing?.items ?? []).map(itemKey));
  const seen = new Set<string>();
  const merged: AssetPackItem[] = [];
  let deduped = 0;
  const landed: AssetPackItem[] = [];
  for (const item of [...fresh, ...(existing?.items ?? [])]) {
    if (merged.length >= MAX_ITEMS_PER_PACK) break;
    const key = itemKey(item);
    if (seen.has(key)) {
      if (fresh.includes(item)) deduped += 1;
      continue;
    }
    seen.add(key);
    merged.push(item);
    if (fresh.includes(item)) {
      if (existingKeys.has(key)) deduped += 1;
      landed.push(item);
    }
  }

  const scriptCount = merged.filter((i) => i.kind === "bpy_script").length;
  const sceneCount = merged.filter((i) => i.kind === "scene_3d").length;
  const digest = `3D 资产库：${scriptCount} 个 bpy 脚本模板、${sceneCount} 个场景资产（.blend/.glb）。相似委托先用 fingerprintScript 查指纹，命中即零 token 复用脚本模板。${summary ? `最近场景摘要：${summary}` : ""}`.slice(0, 500);

  const pack: AssetPack = {
    id: BLENDER_ASSET_PACK_ID,
    title: PACK_TITLE,
    digest,
    items: merged,
    tags: ["3d", "blender"],
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveAssetPack(userId, pack);

  return {
    ok: true,
    pack_id: BLENDER_ASSET_PACK_ID,
    items: landed.map((item) => ({
      id: itemId(item),
      kind: item.kind as "scene_3d" | "bpy_script",
      ...(item.artifactPath ? { artifact_path: item.artifactPath } : {}),
      ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
    })),
    deduped,
  };
}
