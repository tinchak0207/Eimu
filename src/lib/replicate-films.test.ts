import test from "node:test";
import assert from "node:assert/strict";
import { REPLICATE_FILMS } from "./replicate-films.ts";
import { AGENT_TEMPLATES } from "./agent-templates/index.ts";

const ORIGINAL_TEMPLATE_IDS = [
  "agent-novel-film-pipeline",
  "agent-novel-ip-visual-pack",
  "agent-ecommerce-launch-pack",
  "agent-ecommerce-model-grid",
  "agent-shortdrama-visual-assets",
  "agent-shortdrama-poster-line",
  "agent-art-curation-series",
  "agent-art-style-immersion",
];

test("replicate films are exactly six sentences that include 换成", () => {
  assert.equal(REPLICATE_FILMS.length, 6);
  const ids = new Set<string>();
  for (const film of REPLICATE_FILMS) {
    assert.equal(ids.has(film.id), false, film.id);
    ids.add(film.id);
    assert.ok(film.title.length > 0, film.id);
    assert.ok(film.sentence.includes("换成"), film.id);
  }
});

test("click payload is the sentence itself", () => {
  for (const film of REPLICATE_FILMS) {
    const received: string[] = [];
    const onReplicate = (sentence: string) => {
      received.push(sentence);
    };
    onReplicate(film.sentence);
    assert.deepEqual(received, [film.sentence]);
  }
});

test("AGENT_TEMPLATES stays the original eight ids", () => {
  assert.deepEqual(
    AGENT_TEMPLATES.map((card) => card.id),
    ORIGINAL_TEMPLATE_IDS,
  );
});
