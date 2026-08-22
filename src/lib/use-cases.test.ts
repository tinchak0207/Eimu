import assert from "node:assert/strict";
import test from "node:test";

import {
  USE_CASES,
  getUseCase,
  relatedUseCases,
  replaceAuthorUrl,
} from "./use-cases";

const BASE_DOMAINS = [
  "ecommerce",
  "content",
  "design",
  "personal-brand",
  "marketing",
  "anime",
  "photography",
  "ui",
  "education",
  "gaming",
  "architecture",
  "fashion",
  "health",
  "finance",
  "travel",
  "automotive",
  "training",
] as const;

test("aggregates all use cases without losing entries", () => {
  assert.ok(USE_CASES.length >= 102);
  assert.equal(USE_CASES.filter((item) => !item.slug.startsWith("reddit-")).length, 102);
});

test("keeps every base domain shard with exactly six entries", () => {
  for (const domain of BASE_DOMAINS) {
    const entries = USE_CASES.filter((item) => item.slug.startsWith(domain + "-"));
    assert.equal(entries.length, 6, domain + " should ship exactly 6 entries");
  }
});

test("keeps every use-case slug globally unique", () => {
  const slugs = USE_CASES.map((item) => item.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("getUseCase finds by slug and returns undefined for unknown slugs", () => {
  assert.equal(getUseCase("ecommerce-1")?.slug, "ecommerce-1");
  assert.equal(getUseCase("training-6")?.slug, "training-6");
  assert.match(String(getUseCase("reddit-accurate-text-in-ai-images")?.slug), /^reddit-/);
  assert.equal(getUseCase("does-not-exist"), undefined);
});

test("relatedUseCases resolves slugs, deduplicates, drops self and unknown slugs", () => {
  const source = {
    ...USE_CASES[0],
    relatedSlugs: ["ecommerce-2", "ecommerce-2", USE_CASES[0].slug, "no-such-slug"],
  };
  assert.deepEqual(
    relatedUseCases(source).map((item) => item.slug),
    ["ecommerce-2"],
  );
});

test("replaceAuthorUrl swaps the host and keeps the fallback when runtimeUrl is empty", () => {
  const author = { name: "Eimu", jobTitle: "AI 图片与视频创作平台", url: "https://eimu.dev" };
  assert.equal(replaceAuthorUrl(author, "https://example.com").url, "https://example.com");
  assert.equal(replaceAuthorUrl(author, "").url, "https://eimu.dev");
});
