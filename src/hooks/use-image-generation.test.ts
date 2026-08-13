import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

test("image generation hook handles non-json server errors without a json parse crash", () => {
  const source = read("src/hooks/use-image-generation.ts");

  assert.match(source, /async function readGenerationResponse/);
  assert.match(source, /const text = await response\.text\(\)/);
  assert.match(source, /JSON\.parse\(text\)/);
  assert.doesNotMatch(source, /const data = await response\.json\(\)/);
});

test("image generation hook sends user auth and refreshes balance after completion", () => {
  const hook = read("src/hooks/use-image-generation.ts");
  const playground = read("src/components/ImagePlayground.tsx");

  assert.match(hook, /getStoredToken/);
  assert.match(hook, /Authorization: `Bearer \$\{token\}`/);
  assert.match(hook, /"x-user-id": String\(user\.id\)/);
  assert.match(playground, /await startGeneration/);
  assert.doesNotMatch(playground, /setTimeout\(\(\) => \{\s*refresh\(\)/);
});

test("image generation hook sends reference images as multipart form data", () => {
  const hook = read("src/hooks/use-image-generation.ts");
  const imageTypes = read("src/lib/image-types.ts");

  assert.match(imageTypes, /ReferenceImage/);
  assert.match(hook, /referenceImages/);
  assert.match(hook, /buildWorkflowPrompt/);
  assert.match(hook, /createGenerationWorkflow/);
  assert.match(hook, /new FormData\(\)/);
  assert.match(hook, /body\.append\("referenceImages"/);
  assert.match(hook, /body\.append\("workflow"/);
  assert.match(hook, /body:\s*requestBody/);
  assert.doesNotMatch(hook, /JSON\.stringify\(\{[\s\S]{0,120}referenceImages/);
});

test("image generation hook persists professional workflow metadata", () => {
  const hook = read("src/hooks/use-image-generation.ts");
  const cache = read("src/lib/generation-cache.ts");
  const client = read("src/lib/new-api-client.ts");

  assert.match(hook, /negativePrompt/);
  assert.match(hook, /workflowPreset/);
  assert.match(hook, /workflowPresetLabel/);
  assert.match(hook, /WORKFLOW_SCHEMA_VERSION/);
  assert.match(hook, /estimatedCredits/);
  assert.match(hook, /workflow,/);
  assert.match(hook, /recentWorkflows/);
  assert.match(hook, /fetchStoredHistory/);
  assert.match(hook, /selectPersistedHistoryForUser/);
  assert.match(hook, /setRecentWorkflows/);
  assert.match(cache, /workflow\?: GenerationWorkflowMetadata/);
  assert.match(cache, /workflow: input\.workflow/);
  assert.match(client, /workflow\?: GenerationWorkflowMetadata/);
});
