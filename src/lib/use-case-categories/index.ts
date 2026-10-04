import type { UseCaseCategory } from "./types";
import { ECOMMERCE_CATEGORY } from "./ecommerce";
import { CONTENT_CATEGORY } from "./content";
import { DESIGN_CATEGORY } from "./design";
import { PERSONAL_BRAND_CATEGORY } from "./personal-brand";
import { MARKETING_CATEGORY } from "./marketing";
import { ANIME_CATEGORY } from "./anime";
import { PHOTOGRAPHY_CATEGORY } from "./photography";
import { UI_CATEGORY } from "./ui";
import { EDUCATION_CATEGORY } from "./education";
import { GAMING_CATEGORY } from "./gaming";
import { ARCHITECTURE_CATEGORY } from "./architecture";
import { FASHION_CATEGORY } from "./fashion";
import { HEALTH_CATEGORY } from "./health";
import { FINANCE_CATEGORY } from "./finance";
import { TRAVEL_CATEGORY } from "./travel";
import { AUTOMOTIVE_CATEGORY } from "./automotive";
import { TRAINING_CATEGORY } from "./training";

export * from "./types";

export const USE_CASE_CATEGORIES: UseCaseCategory[] = [
  ECOMMERCE_CATEGORY,
  CONTENT_CATEGORY,
  DESIGN_CATEGORY,
  PERSONAL_BRAND_CATEGORY,
  MARKETING_CATEGORY,
  ANIME_CATEGORY,
  PHOTOGRAPHY_CATEGORY,
  UI_CATEGORY,
  EDUCATION_CATEGORY,
  GAMING_CATEGORY,
  ARCHITECTURE_CATEGORY,
  FASHION_CATEGORY,
  HEALTH_CATEGORY,
  FINANCE_CATEGORY,
  TRAVEL_CATEGORY,
  AUTOMOTIVE_CATEGORY,
  TRAINING_CATEGORY,
];

export function getUseCaseCategory(slug: string): UseCaseCategory | undefined {
  return USE_CASE_CATEGORIES.find((item) => item.slug === slug);
}

/** 旧门页前缀 → 行业 slug（next.config.mjs 的 301 用同一份清单）。 */
export const LEGACY_CATEGORY_PREFIXES = USE_CASE_CATEGORIES.map((item) => item.slug);
