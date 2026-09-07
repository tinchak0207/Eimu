/**
 * OpenAsset 十二庫索引進貨 seed（片 AI，2026-09-07）。
 *
 * 模式複製真源：tools/seed-asset-packs.ts（tsx 工具骨架：src/lib 相對 import →
 * main() 冪等 upsert → main().catch 收尾 exitCode=1）。白名單改動僅數據源：
 * kunpeng 素材 + blender verify 模板 → .asset-cache/indices/*.json（AH-1/2/3/4
 * 十二庫索引，12197 條）。交互邏輯/儲存層一行不動（MAX_PACKS_PER_USER=100/戶、
 * MAX_ITEMS_PER_PACK=50 由 store 鐵閘把關；本腳本自行按 ≤40/包切片，並在
 * 「現有包數+本批包數」超出 100 時預檢整體拒跑，不依賴靜默截斷）。
 *
 * 100 包/戶硬閘下的體量取捨（全量 12197 條最少需 ~244 包，數學不可行，按 top
 * 分類裁剪並逐庫如實印出未入條數）：
 *   - 提示詞類全量：comfyui-templates(617)、video-gen-prompts(180)、
 *     seedance-prompts(29)、nano-banana-prompts(129)
 *   - 3D 大庫 top 分類：kenney:nature 全量、cmu-mocap:walk 前 14 片、
 *     toxsam:Architecture 全量、polyhaven-hdris night 全量+indoor 前 6 片、
 *     polyhaven-textures wood 全量、polyhaven-models props 前 3 片
 *   - 小庫全量：kaykit×2、mhr、camera-shakes（曲線數據全文內嵌 item.content）、
 *     physically-based
 *
 * 包命名規範：<庫slug>:<分類>（單分類超 40 條按字母序切片標後綴 .1/.2）。
 * license+來源逐包記 digest。GLB/BVH 本體條目 artifactPath 記 .asset-cache
 * 相對路徑+bytes+format（local-repo）；registry/api-url 條目 artifactPath/
 * imageUrl 記 source URL（storage 標記，按需拉取）；提示詞類 item.content 記
 * prompt 全文+分類+source。
 *
 * 用法（repo 根目錄）：
 *   IMAGE_DATA_BASE_URL=... IMAGE_DATA_API_KEY=... BLOB_READ_WRITE_TOKEN=... \
 *     npx tsx tools/seed-openasset-packs.ts --user-ids 4,82
 *   - 三 env 缺 BLOB_READ_WRITE_TOKEN 時 hasBlobStore()=false → 靜默落本地
 *     memory store（僅冒煙，進程退出即丟——真進貨必須三 env 同帶，見片 AG2 三錘）。
 *   - 目標用戶：資產包是 per-user 庫（asset_search 按呼叫者 userId 查），進貨必須
 *     指定 userId。4=HARNESS 綁定戶（E2E 殘留）、82=B key 綁定戶。
 */

import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MAX_PACKS_PER_USER,
  listAssetPacks,
  saveAssetPack,
} from "../src/lib/asset-pack-store";
import type { AssetPack, AssetPackItem } from "../src/lib/asset-pack-store";

// ─────────────────────────────────────────── 參數

function parseUserIds(): number[] {
  const raw = (process.argv.find((a) => a.startsWith("--user-ids=")) ?? "").split("=")[1]
    ?? process.env.ASSET_PACK_SEED_USER_IDS
    ?? "";
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) {
    throw new Error(
      "缺少進貨目標：用 --user-ids=82,4（逗號分隔 userId）或 env ASSET_PACK_SEED_USER_IDS 指定。資產包是 per-user 庫，不指定等於沒進貨。",
    );
  }
  return [...new Set(ids)];
}

// ─────────────────────────────────────────── 數據源：.asset-cache/indices/*.json

/** 每包 item 上限取保守值（store 硬上限 50，切片留餘量，重跑 merge 不頂掉既有）。 */
const MAX_ITEMS_PER_SEED_PACK = 40;

type RawItem = Record<string, unknown>;

interface IndexDoc {
  meta: RawItem;
  items: RawItem[];
}

async function loadIndex(file: string): Promise<IndexDoc> {
  const path = fileURLToPath(new URL(`../.asset-cache/indices/${file}`, import.meta.url));
  const parsed = JSON.parse(await fsp.readFile(path, "utf8")) as RawItem;
  const meta = parsed.meta && typeof parsed.meta === "object" ? (parsed.meta as RawItem) : parsed;
  const items = Array.isArray(parsed.items) ? (parsed.items as RawItem[]) : [];
  return { meta, items };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const str = (item: RawItem, key: string): string =>
  typeof item[key] === "string" ? (item[key] as string) : "";
const num = (item: RawItem, key: string): number | undefined => {
  const value = item[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
const strArr = (item: RawItem, key: string): string[] =>
  Array.isArray(item[key])
    ? (item[key] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "misc"
  );
}

/** 按字母序切片的排序鍵（kenney=name、cmu=id、提示詞庫=id/title）。 */
function sortKeyOf(item: RawItem): string {
  return str(item, "name") || str(item, "id") || str(item, "title") || str(item, "file");
}
function byNameAsc(a: RawItem, b: RawItem): number {
  return sortKeyOf(a).localeCompare(sortKeyOf(b), "en");
}

const SEED_TAG = "openasset";

function manualSource(id: string): AssetPackItem["source"] {
  return { type: "manual", id };
}

function sceneItem(
  id: string,
  fields: { title: string; artifactPath: string; bytes?: number; summary: string; note: string },
): AssetPackItem {
  return {
    kind: "scene_3d",
    title: fields.title.slice(0, 200),
    artifactPath: fields.artifactPath,
    ...(fields.bytes !== undefined ? { bytes: fields.bytes } : {}),
    sceneSummary: fields.summary.slice(0, 500),
    note: fields.note.slice(0, 200),
    source: manualSource(id),
  };
}

function refItem(
  id: string,
  fields: { title: string; imageUrl: string; note: string },
): AssetPackItem {
  return {
    kind: "reference",
    title: fields.title.slice(0, 200),
    imageUrl: fields.imageUrl.trim(),
    note: fields.note.slice(0, 200),
    source: manualSource(id),
  };
}

function promptItem(
  id: string,
  fields: { title: string; content: string; note: string },
): AssetPackItem {
  return {
    kind: "prompt",
    title: fields.title.slice(0, 200),
    content: fields.content,
    note: fields.note.slice(0, 200),
    source: manualSource(id),
  };
}

interface CatGroup {
  cat: string;
  items: AssetPackItem[];
  /** 包數預算上限（超出按字母序丟棄並計入 dropped，如實回報）。 */
  maxPacks?: number;
}

function buildCatPacks(
  slug: string,
  libraryTitle: string,
  licenseLine: string,
  libTags: string[],
  groups: CatGroup[],
): { packs: AssetPack[]; droppedItems: number } {
  const packs: AssetPack[] = [];
  let droppedItems = 0;
  for (const group of groups) {
    const chunks = chunk(group.items, MAX_ITEMS_PER_SEED_PACK);
    const kept = group.maxPacks !== undefined ? chunks.slice(0, group.maxPacks) : chunks;
    droppedItems += group.items.length - kept.reduce((n, c) => n + c.length, 0);
    const catSlug = slugify(group.cat);
    const sliced = kept.length > 1;
    kept.forEach((batch, index) => {
      const hint =
        batch[0] && batch[0].kind === "prompt"
          ? "item.content 為提示詞/參數/曲線全文，asset_activate 直接取用。"
          : "item.artifactPath 為 .asset-cache 本地相對路徑或遠端 source URL，按需拉取入 blender。";
      packs.push({
        id: `${slug}:${catSlug}${sliced ? `.${index + 1}` : ""}`,
        title: `${libraryTitle}・${group.cat}${sliced ? ` ${index + 1}/${kept.length}` : ""}`.slice(0, 200),
        digest:
          `${libraryTitle}「${group.cat}」分類共 ${group.items.length} 條${
            sliced ? `，第 ${index + 1}/${kept.length} 批，本包 ${batch.length} 條` : `，本包 ${batch.length} 條`
          }。${licenseLine}。${hint}`.slice(0, 500),
        items: batch,
        tags: [...new Set([slug, SEED_TAG, ...libTags, catSlug])]
          .map((t) => t.slice(0, 50))
          .slice(0, 20),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }
  return { packs, droppedItems };
}

function licenseLineOf(meta: RawItem): string {
  const license = str(meta, "license") || "未標明";
  const source = str(meta, "source_url");
  const note = str(meta, "license_note");
  return `${license} · 來源 ${source || "見索引"}${note ? ` · ${note.slice(0, 120)}` : ""}`;
}

/** 分類分組（category 欄；< minCat 條的小分類併入 misc，省包數預算）。 */
function groupByCategory(items: RawItem[], minCat: number): CatGroupInput[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const cat = str(it, "category") || "misc";
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const groups = new Map<string, RawItem[]>();
  for (const it of items) {
    const raw = str(it, "category") || "misc";
    const cat = counts.get(raw)! < minCat ? "misc" : raw;
    const list = groups.get(cat) ?? [];
    list.push(it);
    groups.set(cat, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en"))
    .map(([cat, list]) => ({ cat, items: [...list].sort(byNameAsc) }));
}

type CatGroupInput = { cat: string; items: RawItem[] };

// ─────────────────────────────────────────── 進貨單：十五庫 → 分類包

interface LibraryStat {
  slug: string;
  packs: number;
  items: number;
  dropped: number;
}

/** 本地-repo GLB/FBX/BVH 本體 → scene_3d；依賴檔（png/bin/npz/pt/license）→ reference。 */
function localFileItem(sourceId: string, repoLabel: string, it: RawItem): AssetPackItem {
  const format = str(it, "format");
  const body = /^(glb|gltf|fbx|bvh)$/i.test(format);
  const fields = {
    title: str(it, "name"),
    artifactPath: str(it, "path_or_url"),
    bytes: num(it, "bytes"),
    summary: `${repoLabel} ${str(it, "category")} · ${format} 本體（local-repo）`,
    note: `${format} · ${str(it, "category")} · local-repo`,
  };
  return body
    ? sceneItem(sourceId, fields)
    : refItem(sourceId, { title: fields.title, imageUrl: fields.artifactPath, note: fields.note });
}

async function buildKenneyPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("kenney.json");
  const items = doc.items
    .filter((it) => str(it, "category") === "nature") // 預算取捨：只入 nature kit（329 條全量）
    .sort(byNameAsc)
    .map((it) => localFileItem("openasset-kenney", "Kenney nature kit", it));
  const result = buildCatPacks("kenney", "Kenney 3D 套件", licenseLineOf(doc.meta), ["3d", "glb"], [
    { cat: "nature", items },
  ]);
  return { slug: "kenney", result, total: items.length };
}

async function buildToxsamPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("toxsam-open-source-3d-assets.json");
  const items = doc.items
    .filter((it) => str(it, "category") === "Architecture") // 預算取捨：只入 Architecture（307 條全量）
    .sort(byNameAsc)
    .map((it) =>
      sceneItem("openasset-toxsam", {
        title: str(it, "name"),
        artifactPath: str(it, "path_or_url"),
        bytes: num(it, "bytes"),
        summary: `ToxSam ${str(it, "category")} GLB（registry-url 遠端本體，按需拉取）`,
        note: `glb · ${str(it, "category")} · registry-url`,
      }),
    );
  const result = buildCatPacks("toxsam", "ToxSam CC0 模型", licenseLineOf(doc.meta), ["3d", "glb"], [
    { cat: "Architecture", items },
  ]);
  return { slug: "toxsam", result, total: items.length };
}

function buildKaykitPacks(
  file: string,
  slug: string,
  libraryTitle: string,
  sourceId: string,
): Promise<LibraryBuild> {
  return (async () => {
    const doc = await loadIndex(file);
    const total = doc.items.length;
    const grouped = groupByCategory(doc.items, 10);
    const result = buildCatPacks(
      slug,
      libraryTitle,
      licenseLineOf(doc.meta),
      ["3d", "kaykit"],
      grouped.map(({ cat, items }) => ({
        cat,
        items: items.map((it) => localFileItem(sourceId, libraryTitle, it)),
      })),
    );
    return { slug, result, total };
  })();
}

async function buildMhrPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("mhr.json");
  const items = [...doc.items].sort(byNameAsc).map((it) =>
    localFileItem("openasset-mhr", "MHR 人體參數化骨架", it),
  );
  const result = buildCatPacks("mhr", "MHR 人體骨架（Meta）", licenseLineOf(doc.meta), ["3d", "rig"], [
    { cat: "all", items },
  ]);
  return { slug: "mhr", result, total: items.length };
}

async function buildCmuPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("cmu-mocap.json");
  const items = doc.items
    .filter((it) => str(it, "category") === "walk") // 預算取捨：只入 walk 分類，前 14 片（560/864）
    .sort(byNameAsc)
    .map((it) =>
      sceneItem("openasset-cmu", {
        title: `${str(it, "id")} ${str(it, "description")}`,
        artifactPath: `.asset-cache/cmu-mocap/${str(it, "file")}`,
        summary: `${str(it, "description")}（subject ${num(it, "subject") ?? "?"}：${str(it, "subject_category")}）`,
        note: `bvh · ${str(it, "category")} · ${str(it, "id")}`,
      }),
    );
  const result = buildCatPacks(
    "cmu-mocap",
    "CMU 動捕庫",
    licenseLineOf(doc.meta),
    ["mocap", "bvh"],
    [{ cat: "walk", items, maxPacks: 14 }],
  );
  return { slug: "cmu-mocap", result, total: items.length };
}

async function buildCameraShakePacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("camera-shakes.json");
  const dataPath = fileURLToPath(new URL("../.asset-cache/indices/camera-shakes-data.json", import.meta.url));
  const curves = JSON.parse(await fsp.readFile(dataPath, "utf8")) as Record<string, unknown>;
  const items = [...doc.items]
    .sort(byNameAsc)
    .map((it) =>
      promptItem("openasset-camera-shakes", {
        title: `${str(it, "name")} 相機震動曲線`,
        content: JSON.stringify(curves[str(it, "key")] ?? {}),
        note: `${num(it, "fps") ?? "?"}fps · ${num(it, "frames") ?? "?"} 幀 · ${num(it, "channels") ?? "?"} 通道 · data_ref=${str(it, "data_ref")}`,
      }),
    );
  const result = buildCatPacks(
    "camera-shakes",
    "相機震動曲線（Shakify）",
    licenseLineOf(doc.meta),
    ["blender", "camera"],
    [{ cat: "presets", items }],
  );
  return { slug: "camera-shakes", result, total: items.length };
}

function polyhavenRef(
  sourceId: string,
  it: RawItem,
  url: string,
  note: string,
): AssetPackItem {
  return refItem(sourceId, {
    title: str(it, "name"),
    imageUrl: url,
    note: `${(strArr(it, "categories") || []).slice(0, 3).join("/")}${note ? ` · ${note}` : ""}`,
  });
}

async function buildPolyhavenPacks(): Promise<LibraryBuild> {
  const hdri = await loadIndex("polyhaven-hdris.json");
  const textures = await loadIndex("polyhaven-textures.json");
  const models = await loadIndex("polyhaven-models.json");

  const nightItems = hdri.items
    .filter((it) => strArr(it, "categories").includes("night"))
    .sort(byNameAsc)
    .map((it) => {
      const dl = (it.download_url_template ?? {}) as RawItem;
      return polyhavenRef("openasset-polyhaven", it, str(dl, "hdr_1k") || str(dl, "files_api"), "hdri hdr_1k");
    });
  const nightSet = new Set(hdri.items.filter((it) => strArr(it, "categories").includes("night")));
  const indoorItems = hdri.items
    .filter((it) => strArr(it, "categories").includes("indoor") && !nightSet.has(it)) // 前 6 片（240/301）
    .sort(byNameAsc)
    .map((it) => {
      const dl = (it.download_url_template ?? {}) as RawItem;
      return polyhavenRef("openasset-polyhaven", it, str(dl, "hdr_1k") || str(dl, "files_api"), "hdri hdr_1k");
    });
  const woodItems = textures.items
    .filter((it) => strArr(it, "categories").includes("wood"))
    .sort(byNameAsc)
    .map((it) => {
      const dl = (it.pbr_set_url_template ?? {}) as RawItem;
      return polyhavenRef("openasset-polyhaven", it, str(dl, "albedo") || str(dl, "files_api"), `pbr set · max ${str(it, "max_resolution") || "1k"}`);
    });
  const propsItems = models.items
    .filter((it) => strArr(it, "categories").includes("props"))
    .sort(byNameAsc)
    .map((it) => {
      const dl = (it.download_url_template ?? {}) as RawItem;
      return polyhavenRef(
        "openasset-polyhaven",
        it,
        str(dl, "files_api") || str(dl, "hdr_1k"),
        `model · ${num(it, "polycount") ?? "?"} tris`,
      );
    });

  const license = licenseLineOf(hdri.meta);
  const result = buildCatPacks("polyhaven", "Poly Haven CC0 素材", license, ["hdri", "texture", "model"], [
    { cat: "hdri-night", items: nightItems },
    { cat: "hdri-indoor", items: indoorItems, maxPacks: 6 },
    { cat: "texture-wood", items: woodItems },
    { cat: "model-props", items: propsItems, maxPacks: 3 },
  ]);
  const total = nightItems.length + indoorItems.length + woodItems.length + propsItems.length;
  return { slug: "polyhaven", result, total };
}

async function buildPbrPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("physically-based.json");
  const metal = doc.items.filter((it) => strArr(it, "category").includes("Metal"));
  const manmade = doc.items.filter((it) => strArr(it, "category").includes("Manmade"));
  const rest = doc.items.filter(
    (it) => !strArr(it, "category").includes("Metal") && !strArr(it, "category").includes("Manmade"),
  );
  const toPrompt = (it: RawItem) =>
    promptItem("openasset-pbr", {
      title: str(it, "name"),
      content: JSON.stringify(it),
      note: `${strArr(it, "category").join("/")} · ${strArr(it, "tags").join(",")}`,
    });
  const result = buildCatPacks(
    "physically-based",
    "物理材質參數庫",
    licenseLineOf(doc.meta),
    ["render", "material"],
    [
      { cat: "metal", items: [...metal].sort(byNameAsc).map(toPrompt) },
      { cat: "manmade", items: [...manmade].sort(byNameAsc).map(toPrompt) },
      { cat: "misc", items: [...rest].sort(byNameAsc).map(toPrompt) },
    ],
  );
  const total = metal.length + manmade.length + rest.length;
  return { slug: "physically-based", result, total };
}

async function buildComfyuiPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("comfyui-templates.json");
  const byCat = (cat: string, maxPacks?: number): { cat: string; items: AssetPackItem[]; maxPacks?: number } => ({
    cat,
    maxPacks,
    items: doc.items
      .filter((it) => str(it, "category") === cat)
      .sort(byNameAsc)
      .map((it) => {
        const models = [...new Set([...strArr(it, "models_required"), ...strArr(it, "models_from_index")])];
        return promptItem("openasset-comfyui", {
          title: str(it, "title") || str(it, "name"),
          content: `【${str(it, "title")}】${str(it, "description")}\nworkflow: ${str(it, "workflow_path")}\n模型依賴: ${models.join(", ") || "無"}`,
          note: `${str(it, "category")} · ${str(it, "module_title")}`,
        });
      }),
  });
  // 預算取捨：image 分類只入前 6 片（240/333），video/3d/audio 全量。
  const result = buildCatPacks("comfyui", "ComfyUI 工作流模板", licenseLineOf(doc.meta), ["workflow"], [
    byCat("video"),
    byCat("image", 6),
    byCat("3d"),
    byCat("audio"),
  ]);
  const total = doc.items.length;
  return { slug: "comfyui", result, total };
}

async function buildVideoGenPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("video-gen-prompts.json");
  const counts = new Map<string, number>();
  for (const it of doc.items) {
    const cat = str(it, "category") || "uncategorized";
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const groups = new Map<string, RawItem[]>();
  for (const it of doc.items) {
    const raw = str(it, "category") || "uncategorized";
    const cat = (counts.get(raw) ?? 0) >= 20 ? raw : "uncategorized"; // ≥20 條的分類獨立成包
    const list = groups.get(cat) ?? [];
    list.push(it);
    groups.set(cat, list);
  }
  const toPrompt = (it: RawItem) =>
    promptItem("openasset-video-gen", {
      title: `${str(it, "title")}（${str(it, "id")}）`,
      content: [str(it, "prompt_text") || str(it, "prompt"), str(it, "negative_prompt") ? `Negative: ${str(it, "negative_prompt")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      note: `${str(it, "category") || "uncategorized"}${str(it, "subcategory") ? ` / ${str(it, "subcategory")}` : ""}`,
    });
  const result = buildCatPacks(
    "video-gen-prompts",
    "視頻生成提示詞庫",
    licenseLineOf(doc.meta),
    ["prompt", "video"],
    [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "en"))
      .map(([cat, list]) => ({ cat, items: [...list].sort(byNameAsc).map(toPrompt) })),
  );
  return { slug: "video-gen-prompts", result, total: doc.items.length };
}

async function buildSeedancePacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("seedance-prompts.json");
  const items = [...doc.items].sort(byNameAsc).map((it) =>
    promptItem("openasset-seedance", {
      title: str(it, "title"),
      content: [str(it, "prompt"), str(it, "example_video_url") ? `示例視頻: ${str(it, "example_video_url")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      note: `${str(it, "category")} · ${str(it, "description")}`,
    }),
  );
  const result = buildCatPacks("seedance-prompts", "Seedance 提示詞庫", licenseLineOf(doc.meta), ["prompt", "video"], [
    { cat: "styles", items },
  ]);
  return { slug: "seedance-prompts", result, total: items.length };
}

async function buildNanoBananaPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("nano-banana-prompts.json");
  const grouped = groupByCategory(doc.items, 10); // <10 條分類併入 misc（Featured 9 + Product Marketing 9）
  const result = buildCatPacks(
    "nano-banana-prompts",
    "Nano Banana 生圖提示詞",
    licenseLineOf(doc.meta),
    ["prompt", "image"],
    grouped.map(({ cat, items }) => ({
      cat,
      items: items.map((it) =>
        promptItem("openasset-nano-banana", {
          title: `${str(it, "title")}（#${str(it, "id")}）`,
          content: str(it, "prompt"),
          note: `${str(it, "category")} · ${str(it, "description")}`,
        }),
      ),
    })),
  );
  return { slug: "nano-banana-prompts", result, total: doc.items.length };
}

interface LibraryBuild {
  slug: string;
  result: { packs: AssetPack[]; droppedItems: number };
  total: number;
}

async function buildOpenAssetPacks(): Promise<{ packs: AssetPack[]; stats: LibraryStat[] }> {
  const builds = await Promise.all([
    buildKenneyPacks(),
    buildToxsamPacks(),
    buildKaykitPacks("kaykit-character-adventures.json", "kaykit-adventures", "KayKit 冒險角色包", "openasset-kaykit-adv"),
    buildKaykitPacks("kaykit-character-skeletons.json", "kaykit-skeletons", "KayKit 骷髏角色包", "openasset-kaykit-skel"),
    buildMhrPacks(),
    buildCmuPacks(),
    buildCameraShakePacks(),
    buildPolyhavenPacks(),
    buildPbrPacks(),
    buildComfyuiPacks(),
    buildVideoGenPacks(),
    buildSeedancePacks(),
    buildNanoBananaPacks(),
  ]);
  const packs: AssetPack[] = [];
  const stats: LibraryStat[] = [];
  for (const build of builds) {
    packs.push(...build.result.packs);
    stats.push({
      slug: build.slug,
      packs: build.result.packs.length,
      items: build.total - build.result.droppedItems,
      dropped: build.result.droppedItems,
    });
  }
  return { packs, stats };
}

// ─────────────────────────────────────────── main（幂等 upsert，重跑零新增）

async function seedUser(userId: number): Promise<void> {
  const before = await listAssetPacks(userId);
  const { packs, stats } = await buildOpenAssetPacks();
  console.log(`[asset-pack-seed] user ${userId}: 現有 ${before.length} 包 → 本批計畫 ${packs.length} 包（store 上限 ${MAX_PACKS_PER_USER}）`);
  for (const stat of stats) {
    console.log(
      `[asset-pack-seed]   ${stat.slug}: ${stat.packs} 包 / ${stat.items} 條入庫，未入 ${stat.dropped} 條（100 包硬閘裁剪）`,
    );
  }
  const existingIds = new Set(before.map((p) => p.id));
  const newPackCount = packs.filter((p) => !existingIds.has(p.id)).length;
  if (before.length + newPackCount > MAX_PACKS_PER_USER) {
    throw new Error(
      `包數預算超限：user ${userId} 現有 ${before.length} 包 + 本批新包 ${newPackCount} 個 > 上限 ${MAX_PACKS_PER_USER}。先縮減庫選擇再跑（saveAssetPack 第 101 個新包會拋 AssetPackLimitError）。`,
    );
  }
  for (const pack of packs) {
    await saveAssetPack(userId, pack);
    console.log(`[asset-pack-seed] user ${userId}: ${pack.id}「${pack.title}」 items=${pack.items.length}`);
  }
  const after = await listAssetPacks(userId);
  const total = after.reduce((n, p) => n + p.items.length, 0);
  console.log(`[asset-pack-seed] user ${userId}: 完成，現有 ${after.length} 包 / ${total} items`);
}

async function main() {
  const userIds = parseUserIds();
  for (const userId of userIds) {
    await seedUser(userId);
  }
  console.log(`[asset-pack-seed] all done: users=[${userIds.join(",")}]`);
}

main().catch(async (error) => {
  console.error("[asset-pack-seed] failed", error);
  process.exitCode = 1;
});
