import { REDDIT_USE_CASES } from "./reddit-use-cases";
import { REDDIT_TECHNICAL_USE_CASES } from "./reddit-use-cases-technical";
import { REDDIT_EDITING_USE_CASES } from "./reddit-use-cases-editing";
import { REDDIT_COMMERCE_USE_CASES } from "./reddit-use-cases-commerce";
import { REDDIT_USE_CASES_STAGING } from "./reddit-use-cases-staging";
import { REDDIT_SCALE_USE_CASES } from "./reddit-use-cases-scale";

import type { UseCase, UseCaseAuthor } from "./use-cases/types";

export * from "./use-cases/types";

/**
 * 只收 Reddit 深度指南。舊的 102 個 `<行業>-<n>` 模板門頁已併入行業樞紐頁
 * （src/lib/use-case-categories），舊 URL 由 next.config.mjs 301 過去。
 */
export const USE_CASES: UseCase[] = [
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
