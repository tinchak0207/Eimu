import test from "node:test";
import assert from "node:assert/strict";
import {
  ART_EXISTING_TOOL_INVENTORY,
  ART_RESEARCH_SOURCES,
  ART_TOOL_DEFINITIONS,
  ART_WORKFLOWS,
  getArtToolDefinition,
  getArtWorkflowDefinition,
  unsupportedToolMessage,
  validateArtToolDefinition,
  type ArtToolId,
} from "./tool-registry";

const TOOL_IDS: ArtToolId[] = [
  "moodboard_diverge_converge",
  "style_dna_extract",
  "canonical_key_art_lock",
  "sketch_lock",
  "style_aligned_batch",
  "outlier_audit_regenerate",
  "style_lora_train_optional",
  "exhibition_delivery_manifest",
];

const EXPECTED_UNSUPPORTED = new Set<ArtToolId>([
  "style_aligned_batch",
  "outlier_audit_regenerate",
  "style_lora_train_optional",
]);

test("registers exactly the eight art workflow tools", () => {
  assert.deepEqual(ART_TOOL_DEFINITIONS.map((tool) => tool.id), TOOL_IDS);
  assert.equal(new Set(ART_TOOL_DEFINITIONS.map((tool) => tool.id)).size, TOOL_IDS.length);
});

test("inventory names existing generation, reference, Canvas, and agent owners", () => {
  assert.ok(ART_EXISTING_TOOL_INVENTORY.length >= 5);
  for (const item of ART_EXISTING_TOOL_INVENTORY) {
    assert.ok(item.id.length > 2);
    assert.ok(item.owner.includes("src/"), item.id);
    assert.ok(item.capability.length > 8, item.id);
  }
  assert.ok(ART_EXISTING_TOOL_INVENTORY.some((item) => item.id === "generate_image"));
  assert.ok(ART_EXISTING_TOOL_INVENTORY.some((item) => item.id === "canvas_apply_ops"));
  assert.ok(ART_EXISTING_TOOL_INVENTORY.some((item) => item.id === "canvas_reference_nodes"));
});

test("every tool has input, output, gates, upstream, and Canvas metadata", () => {
  for (const tool of ART_TOOL_DEFINITIONS) {
    assert.deepEqual(validateArtToolDefinition(tool), [], tool.id);
    for (const field of Object.values(tool.input)) {
      assert.ok(field.type && field.description, `${tool.id} input field`);
    }
    for (const field of Object.values(tool.output)) {
      assert.ok(field.type && field.description, `${tool.id} output field`);
    }
    assert.ok(tool.gates.some((gate) => gate.blocking), `${tool.id} must have a blocking gate`);
    assert.ok(tool.canvas.fields.includes("workflow_id"), `${tool.id} Canvas workflow id`);
    assert.ok(tool.canvas.fields.some((field) => /status|approval|lock/i.test(field)), `${tool.id} Canvas status`);
  }
});

test("unsupported algorithms are explicit and never represented as prompt-only support", () => {
  for (const id of EXPECTED_UNSUPPORTED) {
    const tool = getArtToolDefinition(id);
    assert.ok(tool);
    assert.equal(tool.support, "unsupported", id);
    assert.ok(tool.unsupported.length > 0, id);
    assert.match(tool.unsupported.join(" "), /未接|未提供|not installed|no local/i, id);
    assert.match(tool.upstream.join(" "), /not installed|no local|未接/i, id);
    assert.match(unsupportedToolMessage(tool) ?? "", new RegExp(`${id} unsupported`));
  }
});

test("style DNA remains conditional because extraction has evidence and approval gates", () => {
  const tool = getArtToolDefinition("style_dna_extract");
  assert.ok(tool);
  assert.equal(tool.support, "conditional");
  assert.ok(tool.unsupported.length > 0);
  assert.ok(tool.gates.some((gate) => gate.id === "style-dna-evidence" && gate.blocking));
  assert.ok(tool.gates.some((gate) => gate.id === "style-dna-approval" && gate.blocking));
});

test("workflow order exposes the two requested handoff chains", () => {
  const curatorial = getArtWorkflowDefinition("curatorial-creation");
  const research = getArtWorkflowDefinition("style-deep-research");
  assert.ok(curatorial);
  assert.ok(research);
  assert.deepEqual(curatorial.toolOrder, [
    "moodboard_diverge_converge",
    "canonical_key_art_lock",
    "sketch_lock",
    "exhibition_delivery_manifest",
  ]);
  assert.deepEqual(research.toolOrder, [
    "style_dna_extract",
    "style_aligned_batch",
    "outlier_audit_regenerate",
    "style_lora_train_optional",
  ]);
});

test("research provenance has at least three traceable upstream sources", () => {
  assert.ok(ART_RESEARCH_SOURCES.length >= 3);
  for (const source of ART_RESEARCH_SOURCES) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.use.length > 10);
  }
  assert.ok(ART_RESEARCH_SOURCES.some((source) => /StoryDiffusion/i.test(source.url)));
  assert.ok(ART_RESEARCH_SOURCES.some((source) => /Style.?Aligned/i.test(source.url)));
  assert.ok(ART_RESEARCH_SOURCES.some((source) => /CLIP/i.test(source.url)));
  assert.ok(ART_RESEARCH_SOURCES.some((source) => /lora/i.test(source.url)));
});
