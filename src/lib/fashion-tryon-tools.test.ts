import test from "node:test";
import assert from "node:assert/strict";
import {
  FASHION_TOOL_IDS,
  FASHION_TRYON_TOOLS,
  FASHION_UPSTREAM_SOURCES,
  buildFashionCanvasArtifact,
  buildShotGridBatchPlan,
  getFashionToolDefinition,
  isFashionToolAvailable,
} from "./fashion-tryon-tools";

test("declares exactly the requested fashion domain tools", () => {
  assert.deepEqual(
    FASHION_TRYON_TOOLS.map((tool) => tool.id),
    FASHION_TOOL_IDS,
  );
  assert.equal(new Set(FASHION_TRYON_TOOLS.map((tool) => tool.id)).size, 8);
});

test("every tool declares the complete domain contract", () => {
  for (const tool of FASHION_TRYON_TOOLS) {
    assert.equal(tool.owner, "fashion-domain");
    assert.ok(tool.input.fields.length > 0, `${tool.id} input fields`);
    assert.ok(tool.output.fields.length > 0, `${tool.id} output fields`);
    assert.ok(tool.gates.length > 0, `${tool.id} gates`);
    assert.ok(tool.canvasArtifact.nodeKind, `${tool.id} Canvas node kind`);
    assert.ok(tool.canvasArtifact.artifactRole, `${tool.id} Canvas artifact role`);
    assert.ok(tool.upstreamEvidence.length > 0, `${tool.id} upstream evidence`);

    if (tool.availability === "unsupported") {
      assert.ok(tool.unsupported, `${tool.id} must explain unsupported state`);
      assert.equal(tool.unsupported?.notReplacedByPrompt, true);
      assert.ok(tool.unsupported?.reason.length);
      assert.ok(tool.unsupported?.requiredCapability.length);
    } else {
      assert.equal(tool.unsupported, null, `${tool.id} cannot be available and unsupported`);
    }
  }
});

test("only the existing batch path is marked available", () => {
  assert.deepEqual(
    FASHION_TOOL_IDS.filter(isFashionToolAvailable),
    ["shot_grid_batch"],
  );
  assert.equal(getFashionToolDefinition("virtual_tryon").availability, "unsupported");
  assert.match(getFashionToolDefinition("virtual_tryon").unsupported?.reason ?? "", /CatVTON|IDM-VTON/);
});

test("unsupported artifact metadata is blocked and exposes required capability", () => {
  const artifact = buildFashionCanvasArtifact("virtual_tryon", {
    artifactId: "tryon-1",
    workflowId: "wf-1",
    sourceArtifactIds: ["garment-1", "model-1"],
    sourceAssetRoles: ["garment_reference", "model_reference"],
  });

  assert.equal(artifact.artifactKind, "fashion_tryon");
  assert.equal(artifact.toolId, "virtual_tryon");
  assert.equal(artifact.status, "blocked");
  assert.ok(artifact.blockedReason);
  assert.ok(artifact.requiredCapabilities?.some((value) => /VTON|inference adapter/i.test(value)));
  assert.deepEqual(artifact.lineage.sourceArtifactIds, ["garment-1", "model-1"]);
  assert.deepEqual(artifact.lineage.sourceAssetRoles, ["garment_reference", "model_reference"]);
});

test("available batch artifact is ready and retains lineage metadata", () => {
  const artifact = buildFashionCanvasArtifact("shot_grid_batch", {
    artifactId: "grid-1",
    workflowId: "wf-2",
    sourceAssetRoles: ["garment_reference", "model_reference"],
  });

  assert.equal(artifact.status, "ready");
  assert.equal(artifact.blockedReason, undefined);
  assert.equal(artifact.requiredCapabilities, undefined);
  assert.ok(artifact.gateIds.includes("shots.batch_contract"));
  assert.deepEqual(artifact.lineage.sourceAssetRoles, ["garment_reference", "model_reference"]);
});

test("shot grid plan expands shot types without inventing identity locks", () => {
  const tasks = buildShotGridBatchPlan({
    garmentImage: "https://example.test/garment.png",
    modelImages: ["https://example.test/model.png"],
    shotTypes: ["full-body front", "detail crop"],
    model: "gpt-image-2",
    size: "1024x1536",
    countPerShot: 2,
    workflowId: "wf-grid",
  });

  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((task) => task.index), [0, 1]);
  assert.deepEqual(tasks.map((task) => task.count), [2, 2]);
  assert.deepEqual(tasks[0].referenceImages, [
    "https://example.test/garment.png",
    "https://example.test/model.png",
  ]);
  assert.equal(tasks[0].artifact.status, "ready");
  assert.match(tasks[0].prompt, /do not claim identity or garment locking/);
});

test("shot grid plan rejects missing or out-of-contract inputs", () => {
  assert.throws(
    () => buildShotGridBatchPlan({
      garmentImage: "",
      modelImages: ["model"],
      shotTypes: ["front"],
      model: "gpt-image-2",
      size: "1024x1024",
    }),
    /garmentImage is required/,
  );
  assert.throws(
    () => buildShotGridBatchPlan({
      garmentImage: "garment",
      modelImages: ["model"],
      shotTypes: ["front"],
      model: "gpt-image-2",
      size: "1024x1024",
      countPerShot: 5,
    }),
    /countPerShot must be an integer from 1 to 4/,
  );
});

test("source registry includes at least three upstream repositories", () => {
  assert.ok(FASHION_UPSTREAM_SOURCES.length >= 3);
  assert.ok(FASHION_UPSTREAM_SOURCES.some((source) => source.includes("CatVTON")));
  assert.ok(FASHION_UPSTREAM_SOURCES.some((source) => source.includes("IDM-VTON")));
  assert.ok(FASHION_UPSTREAM_SOURCES.some((source) => source.includes("BiRefNet")));
});
