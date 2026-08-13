import test from "node:test";
import assert from "node:assert/strict";
import { directVideoPrompt } from "./invisible-prompt-director";

test("appends quality tail when the prompt is bare", () => {
  const out = directVideoPrompt("a cat on a windowsill");
  assert.match(out, /no flicker/);
  assert.match(out, /Stable composition/);
  assert.match(out, /subject locked through the whole shot/);
});

test("does not duplicate the quality tail when already present", () => {
  const out = directVideoPrompt("a cat, cinematic, no flicker, stable composition");
  const matches = out.match(/no flicker/g);
  assert.equal(matches?.length, 1);
});

test("fills a missing camera slot with a neutral directive", () => {
  const out = directVideoPrompt("a runner crosses a bridge at dusk");
  assert.match(out, /Camera:/i);
});

test("does not inject a camera slot when the user already named one", () => {
  const out = directVideoPrompt("a dolly-in on a runner crossing a bridge at dusk");
  assert.doesNotMatch(out, /Camera: motivated, steady/i);
});

test("replaces slop adjectives with concrete vocabulary", () => {
  const out = directVideoPrompt("an epic cinematic scene, beautiful lighting, high quality");
  assert.doesNotMatch(out, /\bepic\b/);
  assert.doesNotMatch(out, /\bbeautiful\b/);
  assert.doesNotMatch(out, /high quality/);
  assert.match(out, /large-scale/);
});

test("fixes homograph traps", () => {
  const out = directVideoPrompt("wind tearing at her coat, she ducks behind the wall");
  assert.match(out, /whipping violently at|ripping through/i);
  assert.match(out, /crouch/i);
  assert.doesNotMatch(out, /\bducks?\b/i);
});

test("decomposes generic emotions into muscle physics", () => {
  const out = directVideoPrompt("she looks scared as the door opens");
  assert.match(out, /jaw clenches|nostrils flare|shallow breath/i);
  assert.doesNotMatch(out, /\bscared\b/i);
});

test("enforces positive phrasing on common negatives", () => {
  const out = directVideoPrompt("the boxer does not fall on his back");
  assert.doesNotMatch(out, /does not fall/i);
  assert.match(out, /stays clear of/i);
});

test("is age-blind", () => {
  const out = directVideoPrompt("a young man runs through the rain");
  assert.doesNotMatch(out, /\byoung man\b/i);
});

test("adds SFX-only tail when no audio and no existing cinematic markers", () => {
  const out = directVideoPrompt("a train departs the station", { generateAudio: false });
  assert.match(out, /SFX only, no music/i);
});

test("omits SFX-only tail when audio generation is enabled", () => {
  const out = directVideoPrompt("a train departs the station", { generateAudio: true });
  assert.doesNotMatch(out, /SFX only, no music/i);
});

test("adds the first-second layout beat for long clips", () => {
  const out = directVideoPrompt("two people argue in a kitchen", { durationSeconds: 8 });
  assert.match(out, /The first second establishes the layout/i);
});

test("skips the first-second beat for short clips", () => {
  const out = directVideoPrompt("two people argue in a kitchen", { durationSeconds: 2 });
  assert.doesNotMatch(out, /The first second establishes the layout/i);
});

test("appends positive locks against crowd/environment invention", () => {
  const out = directVideoPrompt("a crowd gathers in a square");
  assert.match(out, /No extra people, no duplicated furniture/i);
});

test("keeps an empty prompt empty", () => {
  assert.equal(directVideoPrompt("   "), "");
});

test("preserves the user's core intent", () => {
  const out = directVideoPrompt("a chef flambes a dish in a busy kitchen, flames leaping");
  assert.match(out, /chef flambes a dish/i);
});
