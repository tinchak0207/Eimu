import assert from "node:assert/strict";
import test from "node:test";

import {
  USE_CASES,
  getUseCase,
  relatedUseCases,
  replaceAuthorUrl,
} from "./use-cases";
import { USE_CASE_CATEGORIES } from "./use-case-categories";

// 與 src/lib/use-case-categories/index.ts 的 17 個行業樞紐 slug 一致。
const CATEGORY_SLUGS = [
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

const WORKFLOW_SLUGS = [
  "novel-film-pipeline",
  "novel-ip-visual-pack",
  "ecommerce-launch-pack",
  "ecommerce-model-grid",
  "shortdrama-visual-assets",
  "shortdrama-poster-line",
  "art-curation-series",
  "art-style-immersion",
] as const;

test("USE_CASES only ships the evidence-led reddit guides", () => {
  assert.equal(USE_CASES.length, 25);
  for (const item of USE_CASES) assert.match(item.slug, /^reddit-/);
});

test("no guide slug collides with an industry hub slug or a legacy doorway slug", () => {
  const legacy = new RegExp(`^(${CATEGORY_SLUGS.join("|")})-\\d+$`);
  for (const item of USE_CASES) {
    assert.ok(!CATEGORY_SLUGS.includes(item.slug as (typeof CATEGORY_SLUGS)[number]));
    assert.doesNotMatch(item.slug, legacy);
    for (const related of item.relatedSlugs) assert.doesNotMatch(related, legacy, `${item.slug} still links ${related}`);
  }
});

test("every guide is tagged with a real industry hub", () => {
  for (const item of USE_CASES) {
    assert.ok(item.categorySlug, `${item.slug} is missing categorySlug`);
    assert.ok(
      CATEGORY_SLUGS.includes(item.categorySlug as (typeof CATEGORY_SLUGS)[number]),
      `${item.slug} has unknown categorySlug ${item.categorySlug}`,
    );
  }
});

test("keeps every use-case slug globally unique", () => {
  const slugs = USE_CASES.map((item) => item.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("getUseCase finds by slug and returns undefined for unknown or legacy slugs", () => {
  assert.equal(getUseCase("reddit-accurate-text-in-ai-images")?.slug, "reddit-accurate-text-in-ai-images");
  assert.equal(getUseCase("ecommerce-1"), undefined);
  assert.equal(getUseCase("does-not-exist"), undefined);
});

test("relatedUseCases resolves slugs, deduplicates, drops self and unknown slugs", () => {
  const source = {
    ...USE_CASES[0],
    relatedSlugs: [USE_CASES[1].slug, USE_CASES[1].slug, USE_CASES[0].slug, "no-such-slug"],
  };
  assert.deepEqual(
    relatedUseCases(source).map((item) => item.slug),
    [USE_CASES[1].slug],
  );
});

test("replaceAuthorUrl swaps the host and keeps the fallback when runtimeUrl is empty", () => {
  const author = { name: "Eimu", jobTitle: "AI 图片与视频创作平台", url: "https://eimu.dev" };
  assert.equal(replaceAuthorUrl(author, "https://example.com").url, "https://example.com");
  assert.equal(replaceAuthorUrl(author, "").url, "https://eimu.dev");
});

const HAN = /\p{Script=Han}/gu;
const hanCount = (text: string) => (text.match(HAN) ?? []).length;

test("ships exactly the 17 industry hubs", () => {
  assert.equal(USE_CASE_CATEGORIES.length, CATEGORY_SLUGS.length);
  assert.deepEqual(
    USE_CASE_CATEGORIES.map((category) => category.slug).sort(),
    [...CATEGORY_SLUGS].sort(),
  );
});

for (const category of USE_CASE_CATEGORIES) {
  test(`industry hub ${category.slug} is complete and links only to real pages`, () => {
    assert.ok(CATEGORY_SLUGS.includes(category.slug as (typeof CATEGORY_SLUGS)[number]));
    assert.ok(category.title.length <= 30, `${category.slug} title too long`);
    assert.ok(!category.title.includes("Eimu |") && !category.title.includes("| Eimu"));
    assert.ok(category.intro.length >= 2 && category.intro.length <= 3);
    assert.equal(category.scenarios.length, 6);
    assert.ok(category.checklist.length >= 5 && category.checklist.length <= 7);
    assert.ok(category.faqs.length >= 4 && category.faqs.length <= 6);
    assert.equal(category.updated, "2026-09-27");

    const ids = category.scenarios.map((scenario) => scenario.id);
    assert.equal(new Set(ids).size, ids.length);
    const legacy = category.scenarios.map((scenario) => scenario.legacySlug).sort();
    assert.deepEqual(legacy, [1, 2, 3, 4, 5, 6].map((n) => `${category.slug}-${n}`).sort());

    for (const scenario of category.scenarios) {
      assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(scenario.body.length >= 2 && scenario.body.length <= 4, `${scenario.id} body`);
      assert.ok(scenario.prompts.length >= 2 && scenario.prompts.length <= 3, `${scenario.id} prompts`);
      for (const prompt of scenario.prompts) assert.ok(hanCount(prompt.prompt) >= 50, `${scenario.id} prompt too short`);
    }

    for (const slug of category.workflowSlugs) assert.ok(WORKFLOW_SLUGS.includes(slug as (typeof WORKFLOW_SLUGS)[number]), slug);
    for (const slug of category.relatedCategorySlugs) {
      assert.ok(CATEGORY_SLUGS.includes(slug as (typeof CATEGORY_SLUGS)[number]), slug);
      assert.notEqual(slug, category.slug);
    }
    assert.ok(category.relatedGuideSlugs.length >= 2 && category.relatedGuideSlugs.length <= 4);
    for (const slug of category.relatedGuideSlugs) assert.ok(getUseCase(slug), `${category.slug} links missing guide ${slug}`);

    const allText = JSON.stringify(category);
    assert.ok(hanCount(allText) >= 2500, `${category.slug} only has ${hanCount(allText)} Han characters`);
    for (const banned of ["无需摄影棚", "赋能", "助力", "一站式", "全方位", "轻松搞定", "释放创意", "无限可能", "据统计", "免费", "3 币"]) {
      assert.ok(!allText.includes(banned), `${category.slug} contains banned phrase ${banned}`);
    }
  });
}
