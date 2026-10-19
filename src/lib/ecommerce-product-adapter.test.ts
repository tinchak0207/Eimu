import test from "node:test";
import assert from "node:assert/strict";
import {
  ECOMMERCE_PRODUCT_TOOLS,
  ECOMMERCE_TOOL_IDS,
  ECOMMERCE_UPSTREAM_SOURCES,
  buildEcommerceToolPlan,
} from "./ecommerce-product-adapter";

test("source registry records four upstream capability references", () => {
  assert.ok(ECOMMERCE_UPSTREAM_SOURCES.length >= 3);
  assert.ok(ECOMMERCE_UPSTREAM_SOURCES.some((source) => source.url.includes("ComfyUI-RMBG")));
  assert.ok(ECOMMERCE_UPSTREAM_SOURCES.some((source) => source.url.includes("ComfyUI_IPAdapter_plus")));
  assert.ok(ECOMMERCE_UPSTREAM_SOURCES.some((source) => source.url.includes("controlnet_aux")));
  assert.ok(ECOMMERCE_UPSTREAM_SOURCES.some((source) => source.url.includes("Real-ESRGAN")));
});

test("catalog exposes the eight ecommerce launch tools with complete contracts", () => {
  assert.deepEqual(ECOMMERCE_TOOL_IDS, [
    "product_lock",
    "background_remove",
    "scene_pack_batch",
    "product_conditioned_generation",
    "pose_conditioned_inpaint",
    "detail_page_manifest",
    "aspect_reflow",
    "upscale_audit",
  ]);

  for (const toolId of ECOMMERCE_TOOL_IDS) {
    const definition = ECOMMERCE_PRODUCT_TOOLS[toolId];
    assert.ok(definition, toolId);
    assert.ok(definition.inputs.length > 0, toolId);
    assert.ok(definition.outputs.length > 0, toolId);
    assert.ok(definition.gates.length > 0, toolId);
    assert.ok(Array.isArray(definition.unsupported), toolId);
    assert.ok(definition.canvas.workflowId.startsWith("ecommerce."), toolId);
    assert.deepEqual(definition.ownership, {
      queue: "generation-core",
      billing: "generation-core",
      history: "generation-core",
      canvas: "canvas",
    });
  }
});

test("mapped generation tools expose an honest generation-core mapping", () => {
  for (const toolId of ["product_conditioned_generation", "scene_pack_batch"] as const) {
    const definition = ECOMMERCE_PRODUCT_TOOLS[toolId];
    assert.equal(definition.support, "mapped");
    assert.equal(definition.mapping?.owner, "generation-core");
    assert.equal(definition.mapping?.kind, "image_generate");
    assert.deepEqual(definition.unsupported, []);
  }
});

test("upstream-dependent tools stay unsupported instead of simulating success", () => {
  for (const toolId of [
    "background_remove",
    "pose_conditioned_inpaint",
    "aspect_reflow",
    "upscale_audit",
  ] as const) {
    const definition = ECOMMERCE_PRODUCT_TOOLS[toolId];
    assert.equal(definition.support, "unsupported");
    assert.ok(definition.unsupported.length > 0);
    assert.equal(definition.mapping, undefined);

    const plan = buildEcommerceToolPlan({ tool: toolId, input: {} });
    assert.equal(plan.status, "unsupported");
    assert.equal(plan.generation, undefined);
    assert.ok(plan.unsupported.length > 0);
  }
});

test("product_lock compiles a product reference artifact without pretending to edit pixels", () => {
  const plan = buildEcommerceToolPlan({
    tool: "product_lock",
    input: {
      productArtifactId: "artifact-product-1",
      productImageUrl: "https://cdn.example/product.png",
      productName: "Glass serum bottle",
    },
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.generation, undefined);
  assert.equal(plan.artifacts.outputs[0]?.artifactId, "product-lock:artifact-product-1");
  assert.equal(plan.artifacts.outputs[0]?.kind, "json");
  assert.equal(plan.canvas.nodeType, "reference");
  assert.equal(plan.canvas.nodeMetadata.referenceRole, "product");
});

test("product-conditioned generation maps the product lock into the existing generation owner", () => {
  const plan = buildEcommerceToolPlan({
    tool: "product_conditioned_generation",
    input: {
      productLockArtifactId: "product-lock:artifact-product-1",
      productReferenceUrl: "https://cdn.example/product.png",
      prompt: "hero shot on a pale stone plinth",
      modelId: "gpt-image-2",
      aspectRatio: "1:1",
    },
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.generation?.kind, "image_generate");
  assert.equal(plan.generation?.owner, "generation-core");
  assert.equal(plan.generation?.command.kind, "image_generate");
  assert.equal(plan.generation?.command.responseFormat, "url");
  assert.equal(plan.generation?.modelId, "gpt-image-2");
  assert.equal(plan.generation?.workflow.references?.[0]?.referenceRole, "product");
  assert.equal(plan.generation?.workflow.metadata?.ecommerceTool, "product_conditioned_generation");
  assert.equal(plan.canvas.nodeMetadata.referenceRole, "product");
  assert.equal(plan.gates.find((gate) => gate.id === "generation_capability")?.state, "pending");
});

test("scene_pack_batch maps each scene to generation-core while preserving batch metadata", () => {
  const plan = buildEcommerceToolPlan({
    tool: "scene_pack_batch",
    input: {
      productLockArtifactId: "product-lock:artifact-product-1",
      productReferenceUrl: "https://cdn.example/product.png",
      scenes: ["hero on stone", "bathroom shelf", "handheld detail"],
      modelId: "gpt-image-2",
      aspectRatio: "4:5",
    },
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.generationBatch?.owner, "generation-core");
  assert.equal(plan.generationBatch?.commands.length, 3);
  assert.deepEqual(plan.generationBatch?.commands.map((command) => command.requestedCount), [1, 1, 1]);
  assert.equal(plan.generationBatch?.commands[1]?.workflow.metadata?.batchIndex, 1);
  assert.equal(plan.generationBatch?.commands[1]?.workflow.metadata?.batchTotal, 3);
  assert.equal(plan.canvas.nodeMetadata.batchTotal, 3);
});

test("artifact-only detail page manifests require product lock and ordered deliverables", () => {
  const plan = buildEcommerceToolPlan({
    tool: "detail_page_manifest",
    input: {
      productLockArtifactId: "product-lock:artifact-product-1",
      deliverables: ["hero", "benefits", "specifications"],
    },
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.generation, undefined);
  assert.equal(plan.artifacts.outputs[0]?.kind, "manifest");
  assert.deepEqual(plan.artifacts.outputs[0]?.metadata?.deliverables, ["hero", "benefits", "specifications"]);
});

test("missing required inputs fail before any generation or billing handoff", () => {
  const plan = buildEcommerceToolPlan({
    tool: "product_conditioned_generation",
    input: { prompt: "hero shot" },
  });

  assert.equal(plan.status, "invalid");
  assert.ok(plan.issues.some((issue) => issue.param === "productLockArtifactId"));
  assert.equal(plan.generation, undefined);
});
