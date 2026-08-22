import { REDDIT_USE_CASES } from "./reddit-use-cases";
import { REDDIT_TECHNICAL_USE_CASES } from "./reddit-use-cases-technical";
import { REDDIT_EDITING_USE_CASES } from "./reddit-use-cases-editing";
import { REDDIT_COMMERCE_USE_CASES } from "./reddit-use-cases-commerce";
import { REDDIT_USE_CASES_STAGING } from "./reddit-use-cases-staging";
import { REDDIT_SCALE_USE_CASES } from "./reddit-use-cases-scale";
import { BASE_ECOMMERCE_USE_CASES } from "./use-cases/base-ecommerce";
import { BASE_CONTENT_USE_CASES } from "./use-cases/base-content";
import { BASE_DESIGN_USE_CASES } from "./use-cases/base-design";
import { BASE_PERSONAL_BRAND_USE_CASES } from "./use-cases/base-personal";
import { BASE_MARKETING_USE_CASES } from "./use-cases/base-marketing";
import { BASE_ANIME_USE_CASES } from "./use-cases/base-anime";
import { BASE_PHOTOGRAPHY_USE_CASES } from "./use-cases/base-photography";
import { BASE_UI_USE_CASES } from "./use-cases/base-ui";
import { BASE_EDUCATION_USE_CASES } from "./use-cases/base-education";
import { BASE_GAMING_USE_CASES } from "./use-cases/base-gaming";
import { BASE_ARCHITECTURE_USE_CASES } from "./use-cases/base-architecture";
import { BASE_FASHION_USE_CASES } from "./use-cases/base-fashion";
import { BASE_HEALTH_USE_CASES } from "./use-cases/base-health";
import { BASE_FINANCE_USE_CASES } from "./use-cases/base-finance";
import { BASE_TRAVEL_USE_CASES } from "./use-cases/base-travel";
import { BASE_AUTOMOTIVE_USE_CASES } from "./use-cases/base-automotive";
import { BASE_TRAINING_USE_CASES } from "./use-cases/base-training";

import type { UseCase, UseCaseAuthor } from "./use-cases/types";

export * from "./use-cases/types";

const BASE_USE_CASES: UseCase[] = [
  ...BASE_ECOMMERCE_USE_CASES,
  ...BASE_CONTENT_USE_CASES,
  ...BASE_DESIGN_USE_CASES,
  ...BASE_PERSONAL_BRAND_USE_CASES,
  ...BASE_MARKETING_USE_CASES,
  ...BASE_ANIME_USE_CASES,
  ...BASE_PHOTOGRAPHY_USE_CASES,
  ...BASE_UI_USE_CASES,
  ...BASE_EDUCATION_USE_CASES,
  ...BASE_GAMING_USE_CASES,
  ...BASE_ARCHITECTURE_USE_CASES,
  ...BASE_FASHION_USE_CASES,
  ...BASE_HEALTH_USE_CASES,
  ...BASE_FINANCE_USE_CASES,
  ...BASE_TRAVEL_USE_CASES,
  ...BASE_AUTOMOTIVE_USE_CASES,
  ...BASE_TRAINING_USE_CASES,
];

export const USE_CASES: UseCase[] = [
  ...BASE_USE_CASES,
  ...REDDIT_USE_CASES,
  ...REDDIT_TECHNICAL_USE_CASES,
  ...REDDIT_EDITING_USE_CASES,
  ...REDDIT_COMMERCE_USE_CASES,
  ...REDDIT_USE_CASES_STAGING,
  ...REDDIT_SCALE_USE_CASES,
];

export function getUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((item) => item.slug === slug);
}

export function relatedUseCases(useCase: UseCase): UseCase[] {
  return [...new Set(useCase.relatedSlugs)]
    .filter((slug) => slug !== useCase.slug)
    .map((slug) => getUseCase(slug))
    .filter((item): item is UseCase => Boolean(item));
}

/**
 * 替換 author.url 的域名為 runtime 域名。
 * 保留原始硬編碼作為 fallback（不傳 runtimeUrl 或傳空字串時不替換）。
 *
 * 用法：在 Server Component 中 await getSiteUrl() 後傳入。
 */
export function replaceAuthorUrl(author: UseCaseAuthor, runtimeUrl: string): UseCaseAuthor {
  if (!runtimeUrl) return author;
  return {
    ...author,
    url: author.url.replace(/^https?:\/\/[^\/+]+/, runtimeUrl),
  };
}
