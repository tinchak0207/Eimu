import test from "node:test";
import assert from "node:assert/strict";
import {
  NOVEL_IP_VISUAL_TOOL_IDS,
  NOVEL_IP_VISUAL_TOOLS,
  getNovelIpVisualTool,
  type NovelIpVisualToolDefinition,
} from "./novel-ip-visual-tools.ts";

const EXPECTED_IDS = [
  "world_bible_extract",
  "emotion_board_matrix",
  "style_anchor_sref",
  "character_dna_turnaround",
  "story_sequence_consistency",
  "multi_aspect_reflow",
  "asset_provenance_archive",
] as const;

function assertToolContract(tool: NovelIpVisualToolDefinition): void {
  assert.match(tool.id, /^[a-z][a-z0-9_]+$/);
  assert.ok(tool.label.length >= 2);
  assert.ok(tool.purpose.length >= 10);
  assert.ok(tool.input.length >= 10);
  assert.ok(tool.output.length >= 10);
  assert.ok(tool.gate.length >= 2, `${tool.id} must declare gates`);
  assert.ok(tool.gate.every((gate) => gate.includes(".")), `${tool.id} gate ids need namespaces`);
  assert.ok(tool.unsupported.length >= 2, `${tool.id} must declare unsupported behavior`);

  const metadata = tool.canvasArtifactMetadata;
  assert.equal(metadata.artifactVersion, 1);
  assert.equal(metadata.sourceTool, tool.id);
  assert.ok(metadata.artifactKind.length > 2);
  assert.ok(metadata.nodeType.length > 2);
  assert.equal(metadata.locked, true);
  assert.deepEqual(metadata.sourceNodeIds, []);
  assert.deepEqual(metadata.sourceArtifactIds, []);
  assert.ok(metadata.provenance);
  assert.deepEqual(metadata.provenance.generationTaskIds, []);
  assert.deepEqual(metadata.provenance.sha256, []);
  assert.ok(Array.isArray(metadata.gateResults));
  assert.ok(Array.isArray(metadata.unsupported));

  assert.match(tool.owner.harness, /agent-gateway/);
  assert.ok(tool.owner.execution.length > 8);
  assert.ok(tool.owner.persistence.includes("canvas"));
  assert.ok(tool.researchBasis.length >= 2, `${tool.id} needs research basis`);
  assert.ok(tool.researchBasis.every((url) => url.startsWith("https://github.com/")));
}

test("novel/IP visual package exposes exactly the requested seven tools", () => {
  assert.deepEqual(NOVEL_IP_VISUAL_TOOL_IDS, EXPECTED_IDS);
  assert.equal(NOVEL_IP_VISUAL_TOOLS.length, EXPECTED_IDS.length);
  assert.equal(new Set(NOVEL_IP_VISUAL_TOOL_IDS).size, EXPECTED_IDS.length);
});

test("every novel/IP tool has the complete contract and Canvas artifact metadata", () => {
  for (const tool of NOVEL_IP_VISUAL_TOOLS) assertToolContract(tool);
});

test("tool lookup is the single registry projection", () => {
  for (const id of EXPECTED_IDS) assert.equal(getNovelIpVisualTool(id)?.id, id);
  assert.equal(getNovelIpVisualTool("not_a_novel_ip_tool"), undefined);
});

test("artifact provenance is initialized without secrets or fabricated evidence", () => {
  for (const tool of NOVEL_IP_VISUAL_TOOLS) {
    const { provenance } = tool.canvasArtifactMetadata;
    assert.doesNotMatch(JSON.stringify(tool.canvasArtifactMetadata), /token|cookie|password|private.?key|otp/i, tool.id);
    assert.deepEqual(provenance.sourceUrls, []);
    assert.deepEqual(provenance.sourceRepos, []);
    assert.deepEqual(provenance.generationTaskIds, []);
    assert.deepEqual(provenance.sha256, []);
  }
});

test("all declared tool ids are distinct from the forbidden shared template owner", () => {
  for (const tool of NOVEL_IP_VISUAL_TOOLS) {
    assert.doesNotMatch(tool.owner.harness, /agent-templates\.ts/);
    assert.doesNotMatch(tool.owner.execution, /agent-templates\.ts/);
    assert.doesNotMatch(tool.owner.persistence, /agent-templates\.ts/);
  }
});
