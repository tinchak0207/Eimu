/**
 * OpenAsset 十二库索引进货 seed（片 AI，2026-09-07）。
 *
 * 模式复制真源：tools/seed-asset-packs.ts（tsx 工具骨架：src/lib 相对 import →
 * main() 幂等 upsert → main().catch 收尾 exitCode=1）。白名单改动仅数据源：
 * kunpeng 素材 + blender verify 模板 → .asset-cache/indices/*.json（AH-1/2/3/4
 * 十二库索引，12197 条）。交互逻辑/储存层一行不动（MAX_PACKS_PER_USER=100/户、
 * MAX_ITEMS_PER_PACK=50 由 store 铁闸把关；本脚本自行按 ≤40/包切片，并在
 * 「现有包数+本批包数」超出 100 时预检整体拒跑，不依赖静默截断）。
 *
 * 100 包/户硬闸下的体量取舍（全量 12197 条最少需 ~244 包，数学不可行，按 top
 * 分类裁剪并逐库如实印出未入条数）：
 *   - 提示词类全量：comfyui-templates(617)、video-gen-prompts(180)、
 *     seedance-prompts(29)、nano-banana-prompts(129)
 *   - 3D 大库 top 分类：kenney:nature 全量、cmu-mocap:walk 前 14 片、
 *     toxsam:Architecture 全量、polyhaven-hdris night 全量+indoor 前 6 片、
 *     polyhaven-textures wood 全量、polyhaven-models props 前 3 片
 *   - 小库全量：kaykit×2、mhr、camera-shakes（曲线数据全文内嵌 item.content）、
 *     physically-based
 *
 * 包命名规范：<库slug>:<分类>（单分类超 40 条按字母序切片标后缀 .1/.2）。
 * license+来源逐包记 digest。GLB/BVH 本体条目 artifactPath 记 .asset-cache
 * 相对路径+bytes+format（local-repo）；registry/api-url 条目 artifactPath/
 * imageUrl 记 source URL（storage 标记，按需拉取）；提示词类 item.content 记
 * prompt 全文+分类+source。
 *
 * 用法（repo 根目录）：
 *   IMAGE_DATA_BASE_URL=... IMAGE_DATA_API_KEY=... BLOB_READ_WRITE_TOKEN=... \
 *     npx tsx tools/seed-openasset-packs.ts --user-ids 4,82
 *   - 三 env 缺 BLOB_READ_WRITE_TOKEN 时 hasBlobStore()=false → 静默落本地
 *     memory store（仅冒烟，进程退出即丢——真进货必须三 env 同带，见片 AG2 三锤）。
 *   - 目标用户：资产包是 per-user 库（asset_search 按呼叫者 userId 查），进货必须
 *     指定 userId。4=HARNESS 绑定户（E2E 残留）、82=B key 绑定户。
 */

import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MAX_PACKS_PER_USER,
  listAssetPacks,
  saveAssetPack,
} from "../src/lib/asset-pack-store";
import type { AssetPack, AssetPackItem } from "../src/lib/asset-pack-store";

// ─────────────────────────────────────────── 参数

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
      "缺少进货目标：用 --user-ids=82,4（逗号分隔 userId）或 env ASSET_PACK_SEED_USER_IDS 指定。资产包是 per-user 库，不指定等于没进货。",
    );
  }
  return [...new Set(ids)];
}

// ─────────────────────────────────────────── 数据源：.asset-cache/indices/*.json

/** 每包 item 上限取保守值（store 硬上限 50，切片留余量，重跑 merge 不顶掉既有）。 */
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

/** 按字母序切片的排序键（kenney=name、cmu=id、提示词库=id/title）。 */
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
  /** 包数预算上限（超出按字母序丢弃并计入 dropped，如实回报）。 */
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
          ? "item.content 为提示词/参数/曲线全文，asset_activate 直接取用。"
          : "item.artifactPath 为 .asset-cache 本地相对路径或远端 source URL，按需拉取入 blender。";
      packs.push({
        id: `${slug}:${catSlug}${sliced ? `.${index + 1}` : ""}`,
        title: `${libraryTitle}・${group.cat}${sliced ? ` ${index + 1}/${kept.length}` : ""}`.slice(0, 200),
        digest:
          `${libraryTitle}「${group.cat}」分类共 ${group.items.length} 条${
            sliced ? `，第 ${index + 1}/${kept.length} 批，本包 ${batch.length} 条` : `，本包 ${batch.length} 条`
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
  const license = str(meta, "license") || "未标明";
  const source = str(meta, "source_url");
  const note = str(meta, "license_note");
  return `${license} · 来源 ${source || "见索引"}${note ? ` · ${note.slice(0, 120)}` : ""}`;
}

/** 分类分组（category 栏；< minCat 条的小分类并入 misc，省包数预算）。 */
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

// ─────────────────────────────────────────── 进货单：十五库 → 分类包

interface LibraryStat {
  slug: string;
  packs: number;
  items: number;
  dropped: number;
}

/** 本地-repo GLB/FBX/BVH 本体 → scene_3d；依赖档（png/bin/npz/pt/license）→ reference。 */
function localFileItem(sourceId: string, repoLabel: string, it: RawItem): AssetPackItem {
  const format = str(it, "format");
  const body = /^(glb|gltf|fbx|bvh)$/i.test(format);
  const fields = {
    title: str(it, "name"),
    artifactPath: str(it, "path_or_url"),
    bytes: num(it, "bytes"),
    summary: `${repoLabel} ${str(it, "category")} · ${format} 本体（local-repo）`,
    note: `${format} · ${str(it, "category")} · local-repo`,
  };
  return body
    ? sceneItem(sourceId, fields)
    : refItem(sourceId, { title: fields.title, imageUrl: fields.artifactPath, note: fields.note });
}

async function buildKenneyPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("kenney.json");
  const items = doc.items
    .filter((it) => str(it, "category") === "nature") // 预算取舍：只入 nature kit（329 条全量）
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
    .filter((it) => str(it, "category") === "Architecture") // 预算取舍：只入 Architecture（307 条全量）
    .sort(byNameAsc)
    .map((it) =>
      sceneItem("openasset-toxsam", {
        title: str(it, "name"),
        artifactPath: str(it, "path_or_url"),
        bytes: num(it, "bytes"),
        summary: `ToxSam ${str(it, "category")} GLB（registry-url 远端本体，按需拉取）`,
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
    localFileItem("openasset-mhr", "MHR 人体参数化骨架", it),
  );
  const result = buildCatPacks("mhr", "MHR 人体骨架（Meta）", licenseLineOf(doc.meta), ["3d", "rig"], [
    { cat: "all", items },
  ]);
  return { slug: "mhr", result, total: items.length };
}

async function buildCmuPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("cmu-mocap.json");
  const items = doc.items
    .filter((it) => str(it, "category") === "walk") // 预算取舍：只入 walk 分类，前 14 片（560/864）
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
    "CMU 动捕库",
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
        title: `${str(it, "name")} 相机震动曲线`,
        content: JSON.stringify(curves[str(it, "key")] ?? {}),
        note: `${num(it, "fps") ?? "?"}fps · ${num(it, "frames") ?? "?"} 帧 · ${num(it, "channels") ?? "?"} 通道 · data_ref=${str(it, "data_ref")}`,
      }),
    );
  const result = buildCatPacks(
    "camera-shakes",
    "相机震动曲线（Shakify）",
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
    "物理材质参数库",
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
          content: `【${str(it, "title")}】${str(it, "description")}\nworkflow: ${str(it, "workflow_path")}\n模型依赖: ${models.join(", ") || "无"}`,
          note: `${str(it, "category")} · ${str(it, "module_title")}`,
        });
      }),
  });
  // 预算取舍：image 分类只入前 6 片（240/333），video/3d/audio 全量。
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
    const cat = (counts.get(raw) ?? 0) >= 20 ? raw : "uncategorized"; // ≥20 条的分类独立成包
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
    "视频生成提示词库",
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
      content: [str(it, "prompt"), str(it, "example_video_url") ? `示例视频: ${str(it, "example_video_url")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      note: `${str(it, "category")} · ${str(it, "description")}`,
    }),
  );
  const result = buildCatPacks("seedance-prompts", "Seedance 提示词库", licenseLineOf(doc.meta), ["prompt", "video"], [
    { cat: "styles", items },
  ]);
  return { slug: "seedance-prompts", result, total: items.length };
}

async function buildNanoBananaPacks(): Promise<LibraryBuild> {
  const doc = await loadIndex("nano-banana-prompts.json");
  const grouped = groupByCategory(doc.items, 10); // <10 条分类并入 misc（Featured 9 + Product Marketing 9）
  const result = buildCatPacks(
    "nano-banana-prompts",
    "Nano Banana 生图提示词",
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
    buildKaykitPacks("kaykit-character-adventures.json", "kaykit-adventures", "KayKit 冒险角色包", "openasset-kaykit-adv"),
    buildKaykitPacks("kaykit-character-skeletons.json", "kaykit-skeletons", "KayKit 骷髅角色包", "openasset-kaykit-skel"),
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
  console.log(`[asset-pack-seed] user ${userId}: 现有 ${before.length} 包 → 本批计画 ${packs.length} 包（store 上限 ${MAX_PACKS_PER_USER}）`);
  for (const stat of stats) {
    console.log(
      `[asset-pack-seed]   ${stat.slug}: ${stat.packs} 包 / ${stat.items} 条入库，未入 ${stat.dropped} 条（100 包硬闸裁剪）`,
    );
  }
  const existingIds = new Set(before.map((p) => p.id));
  const newPackCount = packs.filter((p) => !existingIds.has(p.id)).length;
  if (before.length + newPackCount > MAX_PACKS_PER_USER) {
    throw new Error(
      `包数预算超限：user ${userId} 现有 ${before.length} 包 + 本批新包 ${newPackCount} 个 > 上限 ${MAX_PACKS_PER_USER}。先缩减库选择再跑（saveAssetPack 第 101 个新包会抛 AssetPackLimitError）。`,
    );
  }
  for (const pack of packs) {
    await saveAssetPack(userId, pack);
    console.log(`[asset-pack-seed] user ${userId}: ${pack.id}「${pack.title}」 items=${pack.items.length}`);
  }
  const after = await listAssetPacks(userId);
  const total = after.reduce((n, p) => n + p.items.length, 0);
  console.log(`[asset-pack-seed] user ${userId}: 完成，现有 ${after.length} 包 / ${total} items`);
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
