import assert from "node:assert/strict";
import test from "node:test";

import { REDDIT_USE_CASES } from "./reddit-use-cases";
import { REDDIT_TECHNICAL_USE_CASES } from "./reddit-use-cases-technical";
import { REDDIT_EDITING_USE_CASES } from "./reddit-use-cases-editing";
import { REDDIT_COMMERCE_USE_CASES } from "./reddit-use-cases-commerce";
import { REDDIT_USE_CASES_STAGING } from "./reddit-use-cases-staging";
import { REDDIT_SCALE_USE_CASES } from "./reddit-use-cases-scale";
import { USE_CASES, getUseCase, relatedUseCases } from "./use-cases";

const ALL_REDDIT_USE_CASES = [
  ...REDDIT_USE_CASES,
  ...REDDIT_TECHNICAL_USE_CASES,
  ...REDDIT_EDITING_USE_CASES,
  ...REDDIT_COMMERCE_USE_CASES,
  ...REDDIT_USE_CASES_STAGING,
  ...REDDIT_SCALE_USE_CASES,
];

test("ships evidence-led Reddit use-case pages", () => {
  assert.equal(ALL_REDDIT_USE_CASES.length, 25);
  assert.equal(new Set(ALL_REDDIT_USE_CASES.map((item) => item.slug)).size, ALL_REDDIT_USE_CASES.length);
  assert.equal(new Set(ALL_REDDIT_USE_CASES.map((item) => item.keyword.toLowerCase())).size, ALL_REDDIT_USE_CASES.length);

  const searchTerms = ALL_REDDIT_USE_CASES.flatMap((item) => [item.keyword, ...(item.searchVariants ?? [])]).map((item) => item.toLowerCase());
  assert.equal(new Set(searchTerms).size, searchTerms.length);

  for (const item of ALL_REDDIT_USE_CASES) {
    assert.match(item.slug, /^reddit-/);
    assert.ok(item.redditEvidence && item.redditEvidence.length >= 2);
    assert.ok(item.workflowSteps && item.workflowSteps.length >= 3);
    assert.ok(item.fitBoundary && item.fitBoundary.length >= 40);
    assert.ok(item.searchVariants && item.searchVariants.length >= 3);
    assert.equal(getUseCase(item.slug)?.slug, item.slug);
    assert.equal(new Set(item.redditEvidence.map((evidence) => evidence.url)).size, item.redditEvidence.length);

    for (const evidence of item.redditEvidence) {
      assert.match(evidence.url, /^https:\/\/(?:www\.)?reddit\.com\/r\//);
      assert.ok(evidence.quote.length >= 20);
      assert.ok(evidence.title.length >= 10);
    }

    for (const relatedSlug of item.relatedSlugs) {
      assert.ok(getUseCase(relatedSlug), `${item.slug} has unresolved related slug ${relatedSlug}`);
    }
  }
});

test("keeps Reddit pages additive to the existing catalog", () => {
  assert.equal(USE_CASES.length, 127);
  assert.equal(USE_CASES.filter((item) => item.slug.startsWith("reddit-")).length, 25);
});

test("deduplicates related links and removes self-links", () => {
  const source = { ...USE_CASES[0], relatedSlugs: ["ecommerce-2", "ecommerce-2", USE_CASES[0].slug] };
  assert.deepEqual(relatedUseCases(source).map((item) => item.slug), ["ecommerce-2"]);
});
