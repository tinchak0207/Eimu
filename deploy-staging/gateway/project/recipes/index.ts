// S11z：13 个配方的唯一索引（设计文档 §6 / §10 S11z）。
//
// 配方的 id 由各配方文件自己声明；本档只做汇总，不手写第二份 id 清单。
// 与旧模板 id 是否一致由 recipes.test.ts 从 workflow-templates/index.ts 现算集合比对：
// 集合相等即 13 个 id 完全相同，多一个/少一个都会失败。
import type { Recipe } from "../types"

import { singleImageRecipe } from "./single_image"
import { characterSheetRecipe } from "./character_sheet"
import { sceneSetupRecipe } from "./scene_setup"
import { singleVideoRecipe } from "./single_video"
import { featureFilmRecipe } from "./feature_film"
import { novelFilmRecipe } from "./novel_film"
import { novelIpRecipe } from "./novel_ip"
import { ecomLaunchRecipe } from "./ecom_launch"
import { ecomModelRecipe } from "./ecom_model"
import { shortdramaVisualRecipe } from "./shortdrama_visual"
import { shortdramaPosterRecipe } from "./shortdrama_poster"
import { artCurationRecipe } from "./art_curation"
import { artStyleRecipe } from "./art_style"

export {
  singleImageRecipe,
  characterSheetRecipe,
  sceneSetupRecipe,
  singleVideoRecipe,
  featureFilmRecipe,
  novelFilmRecipe,
  novelIpRecipe,
  ecomLaunchRecipe,
  ecomModelRecipe,
  shortdramaVisualRecipe,
  shortdramaPosterRecipe,
  artCurationRecipe,
  artStyleRecipe,
}

/** 全部配方（键 = recipe.id；apply_recipe 与测试共用这一份）。 */
const ALL_RECIPES: readonly Recipe[] = [
  singleImageRecipe,
  characterSheetRecipe,
  sceneSetupRecipe,
  singleVideoRecipe,
  featureFilmRecipe,
  novelFilmRecipe,
  novelIpRecipe,
  ecomLaunchRecipe,
  ecomModelRecipe,
  shortdramaVisualRecipe,
  shortdramaPosterRecipe,
  artCurationRecipe,
  artStyleRecipe,
]

export const RECIPES: Record<string, Recipe> = Object.fromEntries(ALL_RECIPES.map((r) => [r.id, r]))

/** 配方注册表（S2 patch 引擎 `recipes` 选项的形状）。 */
export function getRecipe(id: string): Recipe | undefined {
  return Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : undefined
}
