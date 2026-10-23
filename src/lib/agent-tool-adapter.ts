import type { GenerationCommand, SubmittedGenerationCommand } from "./generation-core/command-service";
import type { AgentToolHandler, AgentToolHandlerContext } from "./agent-tool-contract";
import type { AgentToolDefinition } from "./agent-tool-contract";
import { AGENT_TOOL_DEFINITIONS } from "./agent-tool-contract";
import { AgentToolRegistry } from "./agent-tool-registry";

export interface GenerationSubmitter {
  (command: GenerationCommand, context: AgentToolHandlerContext): Promise<SubmittedGenerationCommand>;
}

export interface CanvasToolRuntime {
  readState(context: AgentToolHandlerContext): Promise<unknown>;
  dispatchOps(
    input: { request_id: string; ops: unknown[]; label?: string },
    context: AgentToolHandlerContext,
  ): Promise<{ ok: boolean; created_node_ids?: string[]; error?: string }>;
}

function definition(toolId: string): AgentToolDefinition {
  const found = AGENT_TOOL_DEFINITIONS.find((candidate) => candidate.id === toolId);
  if (!found) throw new Error(`Missing core agent tool definition: ${toolId}`);
  return found;
}

function generationHandler(toolId: "image_generate" | "image_edit", submit: GenerationSubmitter): AgentToolHandler {
  return async (rawInput, context) => {
    const input = rawInput as Record<string, unknown>;
    const kind = toolId === "image_edit" ? "image_edit" : "image_generate";
    const command: GenerationCommand = {
      tenantId: context.tenantId ?? context.sessionId,
      source: "web",
      kind,
      modelId: typeof input.model === "string" && input.model ? input.model : "gpt-image-2.5-flare",
      prompt: String(input.prompt ?? ""),
      size: typeof input.size === "string" ? input.size : null,
      quality: typeof input.quality === "string" ? input.quality : null,
      requestedCount: typeof input.n === "number" ? input.n : 1,
      workflow: toolId === "image_edit" ? { metadata: { source_image: input.image } } : undefined,
    };
    const submitted = await submit(command, context);
    return {
      status: "succeeded",
      artifact: {
        kind: "generation_job",
        id: submitted.job.id,
        taskId: submitted.job.id,
        metadata: { status: submitted.job.status, request_hash: submitted.requestHash },
      },
    };
  };
}

function canvasStateHandler(runtime: CanvasToolRuntime): AgentToolHandler {
  return async (_input, context) => {
    const state = await runtime.readState(context);
    return {
      status: "succeeded",
      artifact: { kind: "canvas_snapshot", id: context.sessionId, metadata: { state } },
    };
  };
}

function canvasOpsHandler(runtime: CanvasToolRuntime): AgentToolHandler {
  return async (rawInput, context) => {
    const input = rawInput as { request_id: string; ops: unknown[]; label?: string };
    const result = await runtime.dispatchOps(input, context);
    if (!result.ok) return { status: "failed", code: "canvas_ops_failed", message: result.error ?? "Canvas operation was rejected." };
    return {
      status: "succeeded",
      artifact: {
        kind: "canvas_ops",
        id: input.request_id,
        metadata: { request_id: input.request_id, created_node_ids: result.created_node_ids ?? [], ok: true },
      },
    };
  };
}

export interface AgentToolRuntime {
  submitGeneration?: GenerationSubmitter;
  canvas?: CanvasToolRuntime;
}

/** Registers existing gateway tools; missing upstreams stay explicitly unsupported. */
export function createCoreAgentToolRegistry(runtime: AgentToolRuntime = {}): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(definition("image_generate"), runtime.submitGeneration ? generationHandler("image_generate", runtime.submitGeneration) : undefined);
  registry.register(definition("image_edit"), runtime.submitGeneration ? generationHandler("image_edit", runtime.submitGeneration) : undefined);
  registry.register(definition("image_upscale"));
  registry.register(definition("canvas_get_state"), runtime.canvas ? canvasStateHandler(runtime.canvas) : undefined);
  registry.register(definition("canvas_apply_ops"), runtime.canvas ? canvasOpsHandler(runtime.canvas) : undefined);
  return registry;
}
