import {
  AGENT_TOOL_DEFINITIONS,
  type AgentArtifactKind,
  type AgentJsonSchema,
  type AgentToolDefinition,
  type AgentToolExecutionContext,
  type AgentToolExecutionResult,
  type AgentToolHandler,
} from "./agent-tool-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesSchema(value: unknown, schema: AgentJsonSchema, path = "input"): string | null {
  if (schema.type === "object") {
    if (!isRecord(value)) return `${path} must be an object`;
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties || !(key in schema.properties)) return `${path}.${key} is not supported`;
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        const error = matchesSchema(value[key], child, `${path}.${key}`);
        if (error) return error;
      }
    }
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = matchesSchema(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    return null;
  }
  const typeMatches =
    (schema.type === "string" && typeof value === "string") ||
    (schema.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (schema.type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (schema.type === "boolean" && typeof value === "boolean") ||
    (schema.type === "null" && value === null);
  if (!typeMatches) return `${path} must be ${schema.type}`;
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) return `${path} has an invalid value`;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above maximum`;
  }
  return null;
}

function makeAudit(
  definition: AgentToolDefinition,
  context: AgentToolExecutionContext,
  status: AgentToolExecutionResult["status"],
  startedAt: Date,
  finishedAt: Date,
  extra: { reason?: string; approved: boolean; grantedCapabilities: readonly string[]; artifactKind?: AgentArtifactKind },
) {
  return {
    invocationId: context.invocationId,
    toolId: definition.id,
    domain: definition.domain,
    sessionId: context.sessionId,
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    ...(extra.reason ? { reason: extra.reason } : {}),
    requiredCapabilities: definition.requiredCapabilities,
    grantedCapabilities: extra.grantedCapabilities,
    approval: definition.gate.approval,
    approved: extra.approved,
    ...(extra.artifactKind ? { artifactKind: extra.artifactKind } : {}),
  };
}

export class AgentToolRegistry {
  private readonly definitions = new Map<string, AgentToolDefinition>();
  private readonly handlers = new Map<string, AgentToolHandler>();

  register(definition: AgentToolDefinition, handler?: AgentToolHandler): void {
    if (this.definitions.has(definition.id)) throw new Error(`Agent tool already registered: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    if (handler) this.handlers.set(definition.id, handler);
  }

  registerMany(entries: readonly { definition: AgentToolDefinition; handler?: AgentToolHandler }[]): void {
    for (const entry of entries) this.register(entry.definition, entry.handler);
  }

  get(toolId: string): AgentToolDefinition | undefined {
    return this.definitions.get(toolId);
  }

  list(): AgentToolDefinition[] {
    return [...this.definitions.values()];
  }

  async execute(toolId: string, input: unknown, context: AgentToolExecutionContext): Promise<AgentToolExecutionResult> {
    const definition = this.definitions.get(toolId);
    const startedAt = context.now?.() ?? new Date();
    const grantedCapabilities = context.capabilities ?? [];
    if (!definition) {
      const finishedAt = context.now?.() ?? new Date();
      return {
        status: "unsupported",
        error: { code: "tool_not_registered", message: `Tool ${toolId} is not registered.` },
        audit: {
          invocationId: context.invocationId,
          toolId,
          domain: "workflow",
          sessionId: context.sessionId,
          ...(context.tenantId ? { tenantId: context.tenantId } : {}),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          status: "unsupported",
          reason: "tool_not_registered",
          requiredCapabilities: [],
          grantedCapabilities,
          approval: "none",
          approved: false,
        },
      };
    }

    const finish = (status: AgentToolExecutionResult["status"], code: string, message: string, approved = false): AgentToolExecutionResult => {
      const finishedAt = context.now?.() ?? new Date();
      return {
        status,
        error: { code, message },
        audit: makeAudit(definition, context, status, startedAt, finishedAt, { reason: code, approved, grantedCapabilities }),
      };
    };

    const inputError = matchesSchema(input, definition.inputSchema);
    if (inputError) return finish("failed", "invalid_input", inputError);
    const missingCapability = definition.requiredCapabilities.find((capability) => !grantedCapabilities.includes(capability));
    if (missingCapability) return finish("unsupported", "capability_missing", `Required capability is unavailable: ${missingCapability}`);
    const approved = context.approved === true;
    const requiresApproval =
      definition.gate.approval === "required" ||
      (definition.gate.approval === "conditional" &&
        Boolean(definition.gate.approvalCapability) &&
        grantedCapabilities.includes(definition.gate.approvalCapability!));
    if (requiresApproval && !approved) return finish("rejected", "approval_required", definition.gate.reason ?? "User approval is required.");
    const handler = this.handlers.get(toolId);
    if (!handler) return finish("unsupported", "upstream_unavailable", `No upstream adapter is registered for ${toolId}.`, approved);

    try {
      const outcome = await handler(input, { ...context, definition });
      const finishedAt = context.now?.() ?? new Date();
      return {
        ...(outcome.status === "succeeded"
          ? { status: "succeeded" as const, artifact: outcome.artifact }
          : { status: outcome.status, error: { code: outcome.code, message: outcome.message } }),
        audit: makeAudit(definition, context, outcome.status, startedAt, finishedAt, {
          reason: outcome.status === "succeeded" ? undefined : outcome.code,
          approved,
          grantedCapabilities,
          ...(outcome.status === "succeeded" ? { artifactKind: outcome.artifact.kind } : {}),
        }),
      } as AgentToolExecutionResult;
    } catch {
      return finish("failed", "adapter_failed", "The registered upstream adapter failed without exposing provider details.", approved);
    }
  }
}

export function createAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.registerMany(AGENT_TOOL_DEFINITIONS.map((definition) => ({ definition })));
  return registry;
}
