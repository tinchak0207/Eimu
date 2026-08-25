export type AgentToolDomain = "generation" | "canvas" | "workflow" | "question";

export type AgentToolId =
  | "image_generate"
  | "image_edit"
  | "image_upscale"
  | "canvas_get_state"
  | "canvas_apply_ops";

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface AgentJsonSchema {
  type: JsonSchemaType;
  description?: string;
  properties?: Record<string, AgentJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: AgentJsonSchema;
  enum?: readonly (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export type AgentApprovalPolicy = "none" | "conditional" | "required";

export interface AgentToolGate {
  approval: AgentApprovalPolicy;
  approvalCapability?: string;
  reason?: string;
}

export type AgentArtifactKind =
  | "generation_job"
  | "image"
  | "video"
  | "canvas_snapshot"
  | "canvas_ops"
  | "none";

export interface AgentCanvasArtifactMapping {
  eventNames: readonly string[];
  nodeType?: string;
  resultTarget?: "result" | "source" | "none";
  metadataFields: readonly string[];
}

export interface AgentToolOutputArtifact {
  kind: AgentArtifactKind;
  description: string;
  canvas: AgentCanvasArtifactMapping;
}

export interface AgentToolDefinition {
  id: AgentToolId | (string & {});
  domain: AgentToolDomain;
  description: string;
  inputSchema: AgentJsonSchema;
  outputArtifact: AgentToolOutputArtifact;
  requiredCapabilities: readonly string[];
  gate: AgentToolGate;
}

export type AgentToolExecutionStatus = "succeeded" | "unsupported" | "rejected" | "failed";

export interface AgentToolAuditMetadata {
  invocationId: string;
  toolId: string;
  domain: AgentToolDomain;
  sessionId: string;
  tenantId?: string;
  startedAt: string;
  finishedAt: string;
  status: AgentToolExecutionStatus;
  reason?: string;
  requiredCapabilities: readonly string[];
  grantedCapabilities: readonly string[];
  approval: AgentApprovalPolicy;
  approved: boolean;
  artifactKind?: AgentArtifactKind;
}

export interface AgentToolArtifact {
  kind: AgentArtifactKind;
  id: string;
  taskId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentToolExecutionResult {
  status: AgentToolExecutionStatus;
  artifact?: AgentToolArtifact;
  error?: { code: string; message: string };
  audit: AgentToolAuditMetadata;
}

export interface AgentToolExecutionContext {
  invocationId: string;
  sessionId: string;
  tenantId?: string;
  capabilities?: readonly string[];
  approved?: boolean;
  now?: () => Date;
}

export interface AgentToolHandlerContext extends AgentToolExecutionContext {
  definition: AgentToolDefinition;
}

export type AgentToolHandler = (
  input: unknown,
  context: AgentToolHandlerContext,
) => Promise<AgentToolHandlerOutcome> | AgentToolHandlerOutcome;

export type AgentToolHandlerOutcome =
  | { status: "succeeded"; artifact: AgentToolArtifact }
  | { status: "unsupported"; code: string; message: string }
  | { status: "failed"; code: string; message: string };

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    id: "image_generate",
    domain: "generation",
    description: "Submit an image generation command to the existing generation-core owner.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        model: { type: "string" },
        size: { type: "string" },
        quality: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 4 },
      },
    },
    outputArtifact: {
      kind: "generation_job",
      description: "Durable generation job; completed media is later projected by the existing task/artifact owner.",
      canvas: {
        eventNames: ["canvas.plan", "canvas.node.created", "canvas.node.updated"],
        nodeType: "image",
        resultTarget: "result",
        metadataFields: ["prompt", "model", "size", "count", "imageTaskId", "content", "status"],
      },
    },
    requiredCapabilities: ["generation.submit"],
    gate: { approval: "conditional", approvalCapability: "billing.confirm", reason: "Billing or policy may require the existing confirmation flow." },
  },
  {
    id: "image_edit",
    domain: "generation",
    description: "Submit an image edit command through the existing generation-core owner.",
    inputSchema: {
      type: "object",
      required: ["prompt", "image"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        image: { type: "string", minLength: 1 },
        model: { type: "string" },
        size: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 4 },
      },
    },
    outputArtifact: {
      kind: "generation_job",
      description: "Durable edit job; output media is projected by the existing artifact owner.",
      canvas: {
        eventNames: ["canvas.plan", "canvas.node.created", "canvas.node.updated"],
        nodeType: "image",
        resultTarget: "result",
        metadataFields: ["prompt", "source_image", "imageTaskId", "content", "status"],
      },
    },
    requiredCapabilities: ["generation.submit"],
    gate: { approval: "conditional", approvalCapability: "billing.confirm", reason: "Editing may reserve billable generation capacity." },
  },
  {
    id: "image_upscale",
    domain: "generation",
    description: "Upscale an existing image when a real upstream adapter is registered.",
    inputSchema: {
      type: "object",
      required: ["image"],
      additionalProperties: false,
      properties: { image: { type: "string", minLength: 1 }, scale: { type: "number", minimum: 1 } },
    },
    outputArtifact: {
      kind: "image",
      description: "An upstream-produced image artifact.",
      canvas: { eventNames: ["canvas.plan", "canvas.node.created", "canvas.node.updated"], nodeType: "image", resultTarget: "result", metadataFields: ["source_image", "content", "status"] },
    },
    requiredCapabilities: ["generation.upscale"],
    gate: { approval: "conditional", approvalCapability: "billing.confirm" },
  },
  {
    id: "canvas_get_state",
    domain: "canvas",
    description: "Read the current snapshot through the existing canvas state owner.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputArtifact: {
      kind: "canvas_snapshot",
      description: "The current CanvasProject-compatible snapshot.",
      canvas: { eventNames: [], resultTarget: "source", metadataFields: ["session_id", "node_count", "connection_count"] },
    },
    requiredCapabilities: ["canvas.read"],
    gate: { approval: "none" },
  },
  {
    id: "canvas_apply_ops",
    domain: "canvas",
    description: "Dispatch existing CanvasAgentOp operations and await the frontend result callback.",
    inputSchema: {
      type: "object",
      required: ["request_id", "ops"],
      additionalProperties: false,
      properties: {
        request_id: { type: "string", minLength: 1 },
        ops: { type: "array", items: { type: "object" } },
        label: { type: "string", maxLength: 200 },
      },
    },
    outputArtifact: {
      kind: "canvas_ops",
      description: "The acknowledged operation request and created node ids.",
      canvas: { eventNames: ["canvas.ops"], resultTarget: "none", metadataFields: ["request_id", "created_node_ids", "ok"] },
    },
    requiredCapabilities: ["canvas.write"],
    gate: { approval: "required", approvalCapability: "canvas.confirm", reason: "Canvas mutations require an explicit user gate." },
  },
];
