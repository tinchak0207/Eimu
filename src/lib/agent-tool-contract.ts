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
    description:
      "Submit an image or video generation command to the existing generation-core owner (kind=image|video, default image). " +
      "Video only accepts the >=10s tiers (seedance-2.0 10-15s, seedance-2.5 10-30s); an image size must come from the site whitelist. " +
      "Async: the harness auto-continues the task, so never poll for the result.",
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
    description:
      "Read the current canvas snapshot (nodes/connections/selection/viewport summary) through the existing canvas state owner. " +
      "When the summary carries `dsl` (the reversible WorkflowDslSource[] declaration), edit that dsl and send it back with workflow_write to add/remove/edit workflow steps. " +
      "When it carries `workflow_versions`, that is the per-node version history for workflow_history / workflow_rollback.",
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
    description:
      "Dispatch existing CanvasAgentOp operations and await the frontend result callback. " +
      "USE workflow_write FOR WORKFLOW EDITS: to change a production-line step's content or structure (nodes present in `dsl`), read `dsl`, edit `steps` and send the whole thing back with workflow_write (idempotent). " +
      "Use canvas_apply_ops only for what a DSL cannot express (node position/size/hand-wired connections). " +
      "NEVER hand-assemble add_node + connect_nodes to build a whole production-line structure (it bypasses the compiler and breaks reversibility). " +
      "TEMPLATE INSERTION: when the canvas carries a user template (node ids prefixed tpl-), write generation into the template's existing -gen node via update_node {metadata.prompt/model/size} then run_generation on that id. " +
      "To add one step/role, put add_node AND connect_nodes in the SAME batch, wiring the new node into the existing graph (at least one inbound edge from an existing node; cross-lane fan-in is legal and needs no prior delete_connections). " +
      "A new node sharing (type, role) with an open template slot, or an un-wired floating generation node, is rejected with the exact wiring fix (code=TEMPLATE_SLOT_OPEN) — add the wiring and retry, do not route around it. " +
      "DEVIATION: deviate_from_template=true is ignored unless accompanied by deviate_token issued by the gateway after the user actually approved via the question tool.",
    inputSchema: {
      type: "object",
      required: ["request_id", "ops"],
      additionalProperties: false,
      properties: {
        request_id: { type: "string", minLength: 1 },
        ops: { type: "array", items: { type: "object" } },
        label: { type: "string", maxLength: 200 },
        deviate_from_template: { type: "boolean", description: "Only honored together with a gateway-issued deviate_token." },
        deviate_reason: { type: "string", maxLength: 500 },
        deviate_token: { type: "string", description: "Gateway-issued token, returned after the user approved deviation via the question tool." },
      },
    },
    outputArtifact: {
      kind: "canvas_ops",
      description: "The acknowledged operation request and created node ids.",
      canvas: { eventNames: ["canvas.ops"], resultTarget: "none", metadataFields: ["request_id", "created_node_ids", "ok"] },
    },
    requiredCapabilities: ["canvas.write"],
    // Canvas mutation automation is a product mainline: no human approval gate. Undo/redo covers reverts.
    gate: { approval: "none" },
  },
];
