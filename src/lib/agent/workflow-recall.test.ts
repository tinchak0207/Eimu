import test from "node:test";
import assert from "node:assert/strict";
import { extractPromptSection, parseWorkflowRecallConfig } from "./workflow-recall.ts";

test("parseWorkflowRecallConfig restores copied workstation config safely", () => {
  const result = parseWorkflowRecallConfig(JSON.stringify({
    schemaVersion: 2,
    prompt: "  product poster  ",
    contextPrompt: "brand system",
    negativePrompt: "bad text",
    workflowPreset: "poster-variants",
    imageSize: "1536x1024",
    qualityProfile: "print",
    productionIntent: "campaign",
    seedHint: "launch-keyvisual",
    copies: 99,
    concurrency: 0,
    referenceImages: [
      { name: "hero.png", role: "composition", size: 1200 },
      { name: "invalid.png", role: "node-engine" },
    ],
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.prompt, "product poster");
  assert.equal(result.config.contextPrompt, "brand system");
  assert.equal(result.config.negativePrompt, "bad text");
  assert.equal(result.config.workflowPreset, "poster-variants");
  assert.equal(result.config.imageSize, "1536x1024");
  assert.equal(result.config.qualityProfile, "print");
  assert.equal(result.config.productionIntent, "campaign");
  assert.equal(result.config.seedHint, "launch-keyvisual");
  assert.equal(result.config.copies, 8);
  assert.equal(result.config.concurrency, 1);
  assert.deepEqual(result.config.referenceImageRolesByName, { "hero.png": "composition" });
});

test("parseWorkflowRecallConfig rejects malformed or empty recall payloads", () => {
  assert.deepEqual(parseWorkflowRecallConfig("{"), { ok: false, error: "配置 JSON 无法解析" });
  assert.deepEqual(parseWorkflowRecallConfig("{}"), { ok: false, error: "没有可导入的工作站配置" });
});

test("extractPromptSection restores raw prompt from a workflow prompt", () => {
  assert.equal(extractPromptSection([
    "Project context:",
    "brand system",
    "",
    "Prompt:",
    "product poster",
    "",
    "Workflow preset: 海报变体",
    "",
    "Avoid:",
    "bad text",
  ].join("\n")), "product poster");
  assert.equal(extractPromptSection("plain prompt"), "plain prompt");
});
