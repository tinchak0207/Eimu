/**
 * 3D 資產入資產包 + bpy 腳本指紋索引（Astra 3D 導演工作站 P1-5，片I，2026-09-06）。
 *
 * 職責（成本護欄核心——相似委託命中腳本模板即零 token 復用，不觸發渠道）：
 *   ① fingerprintScript —— bpy 腳本規範化（引號外去註釋 + 空白摺疊）後 FNV-1a 指紋。
 *   ② findTemplateByFingerprint —— 指紋命中既有 bpy_script 資產即回（含腳本全文+元數據），
 *      供上游「先命中再呼叫模型」。
 *   ③ saveSceneAssets —— bridge POST /v1/execute 產物（blend/glb）+ 腳本全文批量入
 *      資產包（kind scene_3d / bpy_script），冪等去重，回確定性存儲 id 清單。
 *
 * 輪子對照（禁自造輪子鐵律）：
 *   - 持久化 = 既有資產包真源 src/lib/asset-pack-store.ts（schema 枚舉/normalize 分支
 *     已同構追加 scene_3d / bpy_script 兩類，本檔不自建第二套存儲）。
 *   - 指紋 = blender-delegate.ts stableId 的 FNV-1a 同構（同一 offset basis 0x811c9dc5、
 *     prime 0x01000193、Math.imul 位運算）；因全倉 target ES2017 無 BigInt 字面量，
 *     64-bit 寬度以雙通道 32-bit FNV-1a（lane2 異基 0x1f2be47c）拼接實現（等價方案）。
 *   - 產物形狀真源 = src/lib/blender-tools.ts 的 BlenderArtifact（bridge 回傳
 *     {path,bytes,kind}）；分揀/畫布卡寫入側在 blender-delegate.ts（本檔不碰）。
 *
 * 與規格的兩處必要偏差（存儲面對齊既有真源）：
 *   - findTemplateByFingerprint / saveSceneAssets 首參補 userId：資產包是
 *     per-user 持久化（asset-pack-store 全接口帶 userId），無模組級用戶上下文可省。
 *   - 腳本全文存 item.content（bpy_script 複用既有 content 欄，與 prompt/recipe
 *     同構）；bridge 產物只有 {path,bytes,kind}，腳本全文由呼叫端從委託執行側帶入。
 */

import { MAX_ITEMS_PER_PACK, listAssetPacks, saveAssetPack } from "./asset-pack-store";
import type { AssetPack, AssetPackItem } from "./asset-pack-store";
import type { BlenderArtifact } from "./blender-tools";

/** 3D 資產包固定 id（同構 chat-assets / canvas-assets 的確定性包 id 慣例）。 */
export const BLENDER_ASSET_PACK_ID = "blender-3d-assets";
const PACK_TITLE = "3D 資產庫";

// ─────────────────────────────────────────── ① 腳本指紋

/** FNV-1a 32 常數（lane1 與 blender-delegate.ts stableId 逐字同構）。 */
const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
/** lane2 異基（0x811c9dc5 ^ 0x9e3779b9），雙通道合計 64-bit 指紋寬度。 */
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
 * 規範化：去註釋（僅引號外，感知 ' " ''' """ 與反斜線轉義）+ 每行 trim +
 * 行內空白摺疊（連續空白→單空格、丟空行、CRLF→LF）。
 *
 * 兩個判斷（規格授權自判）：
 *   - 保留縮進層級：Python 縮進即語義，全摺疊會把語義不同的腳本撞成同指紋
 *     （模板庫誤命中 = 復用錯腳本，比漏命中更貴）。
 *   - 變數名無關化不做：無 Python AST 支撐的字面改名會誤傷字符串字面量，
 *     誤判面大於收益。
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
    // 行內空白摺疊（連續空白→單空格）；只去尾隨空白，保留行首縮進
    // （Python 縮進即語義，trim() 會剝掉縮進造成誤命中）。
    const collapsed = line.replace(/[ \t\f\v]+/g, " ");
    const trimmed = collapsed.endsWith(" ") ? collapsed.slice(0, -1) : collapsed;
    if (trimmed) out.push(trimmed);
  }
  return out.join("\n");
}

/**
 * bpy 腳本指紋：規範化後雙通道 FNV-1a 32 拼接成 16 位 hex（64-bit 寬度）。
 * 確定性：同腳本必同指紋；去註釋/空白差異後仍同指紋；不同腳本異指紋（見測試）。
 */
export function fingerprintScript(script: string): string {
  const normalized = normalizeScript(script);
  const lane1 = fnv1a32(normalized, FNV_OFFSET_32);
  const lane2 = fnv1a32(normalized, FNV_OFFSET_32_LANE2);
  return lane1.toString(16).padStart(8, "0") + lane2.toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────── ② 指紋命中（先命中再呼叫模型）

/** 命中的腳本模板（含元數據 + 腳本全文，零 token 復用）。 */
export interface BpyScriptTemplate {
  packId: string;
  itemTitle: string;
  fingerprint: string;
  /** 腳本全文（AssetPackItem.content），直接可執行。 */
  script: string;
  artifactPath?: string;
  bytes?: number;
  sceneSummary?: string;
}

export type FindTemplateResult =
  | { ok: true; template: BpyScriptTemplate }
  | { ok: false; code: "invalid_fingerprint" | "not_found"; hint: string };

/**
 * 指紋查既有 bpy_script 資產：命中即回（含腳本全文與元數據）。
 * newest 優先（listAssetPacks 排序），只認「有腳本全文」的條目為可復用模板。
 */
export async function findTemplateByFingerprint(userId: number, fingerprint: string): Promise<FindTemplateResult> {
  const fp = typeof fingerprint === "string" ? fingerprint.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8,64}$/.test(fp)) {
    return {
      ok: false,
      code: "invalid_fingerprint",
      hint: "指紋格式非法（期望 8-64 位 hex）。請用 fingerprintScript(script) 生成後再查。",
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
    hint: "腳本模板庫未命中該指紋：走首次設計路徑（3D 導演產腳本，執行後自動入庫）。",
  };
}

// ─────────────────────────────────────────── ③ bridge 產物批量入庫

export interface SceneAssetSaveOptions {
  /** bridge scene_summary（可選，存進每個 item 的 sceneSummary）。 */
  scene_summary?: string;
  /** 委託單（可選；effect_description 作為標題基底）。 */
  delegation?: { effect_description?: string } | null;
  /** 本次執行的 bpy 腳本全文；提供時入庫為 bpy_script 資產並產指紋。 */
  script?: string;
  /** 腳本檔落盤路徑（如橋工作目錄 .py），可選。 */
  script_path?: string;
}

/** 確定性存儲 id（內容位址，同構 blender-delegate.stableId 用法：取出端可重算同 id）。 */
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
 * bridge 產物批量入資產包（upsert 固定包 blender-3d-assets，冪等去重）：
 *   - kind blend/glb → AssetPackItem kind "scene_3d"（artifactPath/bytes/sceneSummary，
 *     fingerprint 帶本次腳本指紋作「場景↔腳本」關聯）。
 *   - script 全文 → AssetPackItem kind "bpy_script"（content=腳本全文、fingerprint、
 *     bytes=腳本位元組數）。
 *   - png/mp4 不入（畫布場景卡側 blender-delegate.ts 已管，職責不重疊）。
 * 上限與資產包鐵律一致（MAX_ITEMS_PER_PACK，新資產優先保留）。
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
      hint: "沒有可入庫的 3D 資產：artifacts 缺 blend/glb 產物且未帶腳本全文。先跑 blender_render / blender_export_gltf 取得產物再入庫。",
    };
  }

  const summary = typeof opts.scene_summary === "string" ? opts.scene_summary.trim() : "";
  const titleBase = (opts.delegation?.effect_description ?? "").trim() || summary || "3D 場景資產";
  const fingerprint = script ? fingerprintScript(script) : undefined;

  const fresh: AssetPackItem[] = [];
  if (script) {
    fresh.push({
      kind: "bpy_script",
      title: `bpy 腳本 · ${titleBase}`.slice(0, 200),
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

  // 去重合併：fresh 先行註冊 key，existing 遇同 key 跳過（冪等重入庫=零新增）。
  // 注意不預種 existing 的 key——合併迴圈本身會重跑 existing 條目，預種會讓
  // 每個既有條目「自己撞自己」被丟掉（包永遠只剩本次新增）。
  // existingKeys 僅供 deduped 計數（fresh 撞既有 key = 本次重複入庫），不參與合併判定。
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
  const digest = `3D 資產庫：${scriptCount} 個 bpy 腳本模板、${sceneCount} 個場景資產（.blend/.glb）。相似委託先用 fingerprintScript 查指紋，命中即零 token 復用腳本模板。${summary ? `最近場景摘要：${summary}` : ""}`.slice(0, 500);

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
