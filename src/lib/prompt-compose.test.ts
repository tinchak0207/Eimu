import test from "node:test";
import assert from "node:assert/strict";
import { replacePromptStyleSuffix } from "./prompt-compose";

const REALISTIC = "photorealistic, DSLR photography";
const ANIME = "anime style illustration, vibrant colors";

test("replaces a selected style suffix instead of accumulating conflicting styles", () => {
  assert.equal(
    replacePromptStyleSuffix(`orange cat\n\n${REALISTIC}`, ANIME, [REALISTIC, ANIME]),
    `orange cat\n\n${ANIME}`,
  );
});

test("removes the automatic style suffix when switching back to default", () => {
  assert.equal(
    replacePromptStyleSuffix(`orange cat\n\n${REALISTIC}`, undefined, [REALISTIC, ANIME]),
    "orange cat",
  );
});
