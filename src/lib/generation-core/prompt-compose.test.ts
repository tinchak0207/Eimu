import test from "node:test";
import assert from "node:assert/strict";
import { replacePromptSnippet, replacePromptStyleSuffix } from "./prompt-compose";

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

const TEMPLATE_1 = "一只帅气的猫，赛博朋克霓虹";
const TEMPLATE_2 = "橘猫在窗台晒太阳，治愈系";

test("clicking a second suggestion template replaces the first, keeping plain text", () => {
  assert.equal(
    replacePromptSnippet(replacePromptSnippet("我的猫", null, TEMPLATE_1), TEMPLATE_1, TEMPLATE_2),
    `我的猫\n\n${TEMPLATE_2}`,
  );
});

test("replacing the only suggestion leaves just the new template", () => {
  assert.equal(
    replacePromptSnippet(TEMPLATE_1, TEMPLATE_1, TEMPLATE_2),
    TEMPLATE_2,
  );
});

test("plain text survives when the previous template was manually edited away", () => {
  assert.equal(
    replacePromptSnippet("我的猫\n\n手改过的内容", TEMPLATE_1, TEMPLATE_2),
    `我的猫\n\n手改过的内容\n\n${TEMPLATE_2}`,
  );
});
