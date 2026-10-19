import { REDDIT_USE_CASES } from "./reddit-use-cases";
import { REDDIT_TECHNICAL_USE_CASES } from "./reddit-use-cases-technical";
import { REDDIT_EDITING_USE_CASES } from "./reddit-use-cases-editing";
import { REDDIT_COMMERCE_USE_CASES } from "./reddit-use-cases-commerce";
import { REDDIT_USE_CASES_STAGING } from "./reddit-use-cases-staging";
import { REDDIT_SCALE_USE_CASES } from "./reddit-use-cases-scale";

import type { UseCase, UseCaseAuthor } from "./use-cases/types";

export * from "./use-cases/types";

/**
 * 只收 Reddit 深度指南。旧的 102 个 `<行业>-<n>` 模板门页已并入行业枢纽页
 * （src/lib/use-case-categories），旧 URL 由 next.config.mjs 301 过去。
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
 * 替换 author.url 的域名为 runtime 域名。
 * 保留原始硬编码作为 fallback（不传 runtimeUrl 或传空字串时不替换）。
 *
 * 用法：在 Server Component 中 await getSiteUrl() 后传入。
 */
export function replaceAuthorUrl(author: UseCaseAuthor, runtimeUrl: string): UseCaseAuthor {
  if (!runtimeUrl) return author;
  return {
    ...author,
    url: author.url.replace(/^https?:\/\/[^\/+]+/, runtimeUrl),
  };
}
