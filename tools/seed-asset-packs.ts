/**
 * 资产包进货 seed（片 AG，2026-09-06）。
 *
 * 模式复制真源：tools/seed-generation-suppliers.ts（tsx 工具骨架：src/lib 相对
 * import → main() 幂等 upsert → main().catch 收尾 exitCode=1）。白名单改动仅三处：
 *   ① 数据源：SQL 渠道表 → kunpeng-vendor 素材（src/lib/kunpeng-style-assets.ts
 *      161 条风格 + src/lib/kunpeng-prompt-templates.ts 2 条模板，MIT，commit pin
 *      已在源档头注明）+ skills/blender-director/verify/ 两支实跑验证过的 bpy 5.2 脚本。
 *   ② 写入接入点：supplier_capability SQL → saveAssetPack / saveSceneAssets
 *      （asset-pack-store 真源写路径，与生产 /api/assets 同一条 merge/upsert 链）。
 *   ③ 幂等语义：saveAssetPack 按 pack id upsert、saveSceneAssets 指纹去重，
 *      重跑零新增（同构 seed 的 ON CONFLICT 语义）。
 * 交互逻辑/储存层/上限铁律一行不动（MAX_ITEMS_PER_PACK=50 由 store normalize 截断，
 * 本脚本自行按 ≤40/包切片，不依赖静默截断）。
 *
 * 用法（repo 根目录）：
 *   IMAGE_DATA_BASE_URL=... IMAGE_DATA_API_KEY=... \
 *     npx tsx tools/seed-asset-packs.ts --user-ids 82,4
 *   - 无 IMAGE_DATA_* 时落本地 memory store（仅冒烟，进程退出即丢——真进货必须带
 *     VPS image-data-api 凭证或 BLOB_READ_WRITE_TOKEN）。
 *   - 目标用户：资产包是 per-user 库（asset_search 按呼叫者 userId 查），进货必须
 *     指定 userId。830 E2E 残留在 userId=4（HARNESS_API_KEY 绑定户）；真实主用户
 *     走 B key 绑定户。清单见片 AG 回报。
 */

import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listAssetPacks, saveAssetPack } from "../src/lib/asset-pack-store";
import type { AssetPack, AssetPackItem } from "../src/lib/asset-pack-store";
import { saveSceneAssets } from "../src/lib/blender-asset-store";
import {
  buildKunpengStylePrompt,
  KUNPENG_SOURCE,
  KUNPENG_STYLE_ASSETS,
  kunpengStyleSummary,
} from "../src/lib/kunpeng-style-assets";
import { KUNPENG_PROMPT_TEMPLATES } from "../src/lib/kunpeng-prompt-templates";

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

// ─────────────────────────────────────────── 进货单①：kunpeng 风格 prompt 包

/** 每包 item 上限取保守值（store 硬上限 50，切片留余量，重跑 merge 不顶掉既有）。 */
const MAX_ITEMS_PER_SEED_PACK = 40;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const SOURCE_NOTE = `来源 pengfeiqiao/kunpeng v2.9.16 commit ${KUNPENG_SOURCE.sourceCommit}（${KUNPENG_SOURCE.license}）`;

function stylePackId(category: string, index: number): string {
  return `kunpeng-styles-${category}-${index}`;
}

const CATEGORY_TITLES: Record<string, string> = {
  "live-action": "真人摄影风格库",
  "2d-animation": "2D 动画风格库",
};

function buildStylePacks(): AssetPack[] {
  const packs: AssetPack[] = [];
  for (const category of ["live-action", "2d-animation"] as const) {
    const styles = KUNPENG_STYLE_ASSETS.filter((s) => s.category === category);
    const chunks = chunk(styles, MAX_ITEMS_PER_SEED_PACK);
    chunks.forEach((batch, index) => {
      const packIndex = index + 1;
      const items: AssetPackItem[] = batch.map((style) => ({
        kind: "prompt",
        title: `${style.name}（${style.id}）`.slice(0, 200),
        content: buildKunpengStylePrompt(style),
        note: kunpengStyleSummary(style).slice(0, 200),
        source: { type: "manual", id: "kunpeng-seed" },
      }));
      const pack: AssetPack = {
        id: stylePackId(category, packIndex),
        title: `鲲鹏${CATEGORY_TITLES[category]} ${packIndex}/${chunks.length}`.slice(0, 200),
        digest:
          `风格 prompt 包（${CATEGORY_TITLES[category]}，第 ${packIndex}/${chunks.length} 批，共 ${styles.length} 条，本包 ${items.length} 条）。` +
          `每条 item=一条成品风格块（英文 promptSuffix + 中文视觉 DNA/镜头语言），image_generate 前用 asset_activate 取 content 直接追加/融合进六槽英文 prompt。` +
          `${SOURCE_NOTE}。`
            .slice(0, 500),
        items,
        tags: ["风格", "kunpeng", category, "prompt"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      packs.push(pack);
    });
  }
  return packs;
}

function buildPromptTemplatePack(): AssetPack {
  const items: AssetPackItem[] = KUNPENG_PROMPT_TEMPLATES.map((tpl) => ({
    kind: "prompt",
    title: `${tpl.title}（${tpl.engine}）`.slice(0, 200),
    content: tpl.body,
    note: tpl.description.slice(0, 200),
    source: { type: "manual", id: "kunpeng-seed" },
  }));
  return {
    id: "kunpeng-prompt-templates",
    title: "鲲鹏提示词模板（seedance/gpt-image-2）",
    digest:
      `官方级提示词模板正文（seedance 单镜头视频 + gpt-image-2 单镜头生图，共 ${items.length} 条）。` +
      `写分镜/生图 prompt 前用 asset_activate 取 content 当骨架，槽位替换后送生成。${SOURCE_NOTE}。`.slice(0, 500),
    items,
    tags: ["模板", "kunpeng", "prompt", "分镜"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────── 进货单②：3D 资产（blender-3d-assets）

/** bpy 模板进货单：skills/blender-director/verify/ 实跑验证过的脚本（片B verify 实锤）。 */
const BLENDER_TEMPLATE_FILES = [
  {
    file: "verify_blockout.py",
    summary:
      "阶段①blockout 灰盒模板：COL_Layout/Lights/Cameras 集合结构 + 1.75m 人体比例灰盒 + CAM_SH01_3Q 50mm + 三点布光 + Eevee 1280 验证帧（bridge 实跑 PASS）",
  },
  {
    file: "verify_keyframe.py",
    summary:
      "阶段④骨架动画 keyframe 模板：ARM_Blocky 骨架 + L1 walk 5-KF 直迁（hip ±28°/knee 48°包络）+ Blender 5.2 slotted action channelbags + Eevee 首末帧出图（bridge 实跑 PASS）",
  },
] as const;

function verifyScriptPath(file: string): string {
  return fileURLToPath(new URL(`../skills/blender-director/verify/${file}`, import.meta.url));
}

async function seedBlenderTemplates(userId: number): Promise<void> {
  for (const tpl of BLENDER_TEMPLATE_FILES) {
    const script = await fsp.readFile(verifyScriptPath(tpl.file), "utf8");
    const result = await saveSceneAssets(userId, [], {
      script,
      scene_summary: tpl.summary,
      delegation: { effect_description: `3D 导演模板 · ${tpl.file}` },
    });
    if (!result.ok) {
      throw new Error(`blender 模板入库失败（${tpl.file}）：${result.hint}`);
    }
    console.log(
      `[asset-pack-seed] user ${userId}: blender-3d-assets += ${tpl.file}（landed=${result.items.length}, deduped=${result.deduped}）`,
    );
  }
}

// ─────────────────────────────────────────── main（幂等 upsert，重跑零新增）

async function seedUser(userId: number): Promise<void> {
  const before = await listAssetPacks(userId);
  console.log(`[asset-pack-seed] user ${userId}: 现有 ${before.length} 包 → 开始进货`);

  const packs = [...buildStylePacks(), buildPromptTemplatePack()];
  for (const pack of packs) {
    await saveAssetPack(userId, pack);
    console.log(`[asset-pack-seed] user ${userId}: ${pack.id}「${pack.title}」 items=${pack.items.length}`);
  }
  await seedBlenderTemplates(userId);

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
