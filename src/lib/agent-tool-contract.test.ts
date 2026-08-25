import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOOL_DEFINITIONS, type AgentToolDefinition } from "./agent-tool-contract";
import { createCoreAgentToolRegistry } from "./agent-tool-adapter";
import { AgentToolRegistry } from "./agent-tool-registry";

const base = { invocationId: "inv-1", sessionId: "session-1", tenantId: "tenant-1" };

function capabilities(...values: string[]) {
  return { ...base, capabilities: values };
}

test("core registry exposes gateway tool ids and canvas mapping", () => {
  const registry = createCoreAgentToolRegistry();
  assert.deepEqual(registry.list().map((tool) => tool.id), [
    "image_generate",
    "image_edit",
    "image_upscale",
    "canvas_get_state",
    "canvas_apply_ops",
  ]);
  assert.equal(AGENT_TOOL_DEFINITIONS.find((tool) => tool.id === "canvas_apply_ops")?.outputArtifact.canvas.eventNames[0], "canvas.ops");
});

test("domain agents can register a new tool without creating a second catalog", async () => {
  const registry = new AgentToolRegistry();
  const definition: AgentToolDefinition = {
    id: "domain.review_asset",
    domain: "workflow",
    description: "Review an asset with a domain-owned upstream.",
    inputSchema: { type: "object", required: ["asset_id"], additionalProperties: false, properties: { asset_id: { type: "string", minLength: 1 } } },
    outputArtifact: { kind: "none", description: "No media artifact.", canvas: { eventNames: [], resultTarget: "none", metadataFields: ["decision"] } },
    requiredCapabilities: ["workflow.review"],
    gate: { approval: "none" },
  };
  registry.register(definition, async () => ({ status: "succeeded", artifact: { kind: "none", id: "review-1", metadata: { decision: "pass" } } }));
  const result = await registry.execute("domain.review_asset", { asset_id: "asset-1" }, capabilities("workflow.review"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.artifact?.metadata?.decision, "pass");
  assert.equal(result.audit.toolId, "domain.review_asset");
});

test("missing upstream is explicit unsupported and carries audit metadata", async () => {
  const result = await createCoreAgentToolRegistry().execute("image_generate", { prompt: "a studio portrait" }, capabilities("generation.submit"));
  assert.equal(result.status, "unsupported");
  assert.equal(result.error?.code, "upstream_unavailable");
  assert.equal(result.artifact, undefined);
  assert.equal(result.audit.status, "unsupported");
  assert.equal(result.audit.invocationId, "inv-1");
});

test("generation adapter delegates to the existing generation command owner", async () => {
  let command: Record<string, unknown> | undefined;
  const registry = createCoreAgentToolRegistry({
    submitGeneration: async (next) => {
      command = next as unknown as Record<string, unknown>;
      return { created: true, requestHash: "hash-1", job: { id: "job-1", status: "queued" } } as never;
    },
  });
  const result = await registry.execute("image_generate", { prompt: "a red chair", model: "gpt-image-2", n: 2 }, capabilities("generation.submit"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.artifact?.kind, "generation_job");
  assert.equal(result.artifact?.id, "job-1");
  assert.equal(command?.modelId, "gpt-image-2");
  assert.equal(command?.requestedCount, 2);
  assert.equal(result.audit.artifactKind, "generation_job");
});

test("canvas mutation is gated before the existing dispatch owner is called", async () => {
  let called = false;
  const registry = createCoreAgentToolRegistry({
    canvas: {
      readState: async () => ({ nodes: [] }),
      dispatchOps: async () => {
        called = true;
        return { ok: true };
      },
    },
  });
  const input = { request_id: "ops-1", ops: [{ type: "select_nodes", ids: [] }] };
  const result = await registry.execute("canvas_apply_ops", input, capabilities("canvas.write", "canvas.confirm"));
  assert.equal(result.status, "rejected");
  assert.equal(result.error?.code, "approval_required");
  assert.equal(called, false);
});

test("canvas mutation returns the existing canvas ops artifact after explicit approval", async () => {
  const registry = createCoreAgentToolRegistry({
    canvas: {
      readState: async () => ({ nodes: [] }),
      dispatchOps: async (input) => ({ ok: true, created_node_ids: [input.request_id + "-node"] }),
    },
  });
  const result = await registry.execute(
    "canvas_apply_ops",
    { request_id: "ops-1", ops: [{ type: "select_nodes", ids: [] }] },
    { ...capabilities("canvas.write", "canvas.confirm"), approved: true },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.artifact?.kind, "canvas_ops");
  assert.deepEqual(result.artifact?.metadata?.created_node_ids, ["ops-1-node"]);
});
