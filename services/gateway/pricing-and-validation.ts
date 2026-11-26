// pricing-and-validation.ts - 实作 PRD §14.2 的四项确认
interface ModelPricing {
  base_cost: number;
  per_second?: number;
  per_image?: number;
  per_char?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // TTS（配音）计价：按字符计费，base_cost 为每次调用的起步价。
  // 上游暂不可用（2026-08-27 实测：Groq playai-tts 已下线、Orpheus 需条款接受
  // 且无中文音色；平台 /v1/models 无任何 TTS 条目），故先定义为 0 币
  // （诚实报错版本不产生费用）；上游接入后在此调整单价。
  'tts-zh': { base_cost: 0, per_char: 0.001 },
  'flux-1.1-pro': { base_cost: 0.04, per_image: 0.04 },
  'flux-pro': { base_cost: 0.05, per_image: 0.05 },
  'flux-dev': { base_cost: 0.025, per_image: 0.025 },
  'flux-schnell': { base_cost: 0.003, per_image: 0.003 },
  'sd3-large': { base_cost: 0.035, per_image: 0.035 },
  'sd3-medium': { base_cost: 0.015, per_image: 0.015 },
  'runway-gen3': { base_cost: 0.05, per_second: 0.01 },
  'luma-ai': { base_cost: 0.08, per_second: 0.015 },
  'kling': { base_cost: 0.06, per_second: 0.012 },
  'minimax': { base_cost: 0.04, per_second: 0.008 },
};

export function estimateNodeCost(node: any): number {
  const model = node.metadata?.model || 'flux-schnell';
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0.1;
  let cost = pricing.base_cost;
  if (pricing.per_second && node.metadata?.duration_seconds) {
    cost += pricing.per_second * node.metadata.duration_seconds;
  }
  if (pricing.per_image && node.metadata?.count) {
    cost += pricing.per_image * (node.metadata.count - 1);
  }
  if (pricing.per_char && node.metadata?.text) {
    const chars = String(node.metadata.text).length;
    cost += pricing.per_char * chars;
  }
  return Math.round(cost * 1000) / 1000;
}

interface ModelRefImageConstraints {
  max_ref_images: number;
  supported_formats: string[];
  max_size_mb: number;
}

const MODEL_REF_CONSTRAINTS: Record<string, ModelRefImageConstraints> = {
  'flux-1.1-pro': { max_ref_images: 5, supported_formats: ['png', 'jpg', 'jpeg', 'webp'], max_size_mb: 10 },
  'flux-pro': { max_ref_images: 5, supported_formats: ['png', 'jpg', 'jpeg', 'webp'], max_size_mb: 10 },
  'flux-dev': { max_ref_images: 3, supported_formats: ['png', 'jpg', 'jpeg', 'webp'], max_size_mb: 8 },
  'flux-schnell': { max_ref_images: 2, supported_formats: ['png', 'jpg', 'jpeg'], max_size_mb: 5 },
  'sd3-large': { max_ref_images: 4, supported_formats: ['png', 'jpg', 'jpeg', 'webp'], max_size_mb: 10 },
  'sd3-medium': { max_ref_images: 3, supported_formats: ['png', 'jpg', 'jpeg'], max_size_mb: 8 },
  'runway-gen3': { max_ref_images: 1, supported_formats: ['png', 'jpg', 'jpeg'], max_size_mb: 10 },
  'luma-ai': { max_ref_images: 1, supported_formats: ['png', 'jpg', 'jpeg'], max_size_mb: 8 },
  'kling': { max_ref_images: 2, supported_formats: ['png', 'jpg', 'jpeg', 'webp'], max_size_mb: 10 },
  'minimax': { max_ref_images: 1, supported_formats: ['png', 'jpg', 'jpeg'], max_size_mb: 5 },
};

export function validateRefImages(model: string, refImages: string[]): { valid: boolean; error?: string } {
  const constraints = MODEL_REF_CONSTRAINTS[model];
  if (!constraints) return { valid: false, error: `MODEL_REF_UNSUPPORTED: ${model}` };
  if (refImages.length > constraints.max_ref_images) {
    return { valid: false, error: `REF_IMAGE_LIMIT_EXCEEDED: max ${constraints.max_ref_images}, got ${refImages.length}` };
  }
  for (const img of refImages) {
    const ext = img.split('.').pop()?.toLowerCase() || '';
    if (!constraints.supported_formats.includes(ext) && !img.startsWith('data:image/')) {
      return { valid: false, error: `REF_IMAGE_FORMAT_UNSUPPORTED: [${constraints.supported_formats.join(', ')}]` };
    }
  }
  return { valid: true };
}

interface ConfirmationRequest {
  confirmation_id: string;
  workflow_id: string;
  node_id: string;
  estimated_coins: number;
  node_title: string;
  expires_at: number;
  metadata: any;
}

const pendingConfirmations = new Map<string, ConfirmationRequest>();

export function createConfirmation(workflowId: string, nodeId: string, node: any): ConfirmationRequest {
  const confirmationId = `conf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const estimatedCoins = estimateNodeCost(node);
  const request: ConfirmationRequest = {
    confirmation_id: confirmationId,
    workflow_id: workflowId,
    node_id: nodeId,
    estimated_coins: estimatedCoins,
    node_title: node.title || node.metadata?.prompt?.substring(0, 30) || 'Untitled',
    expires_at: Date.now() + 5 * 60 * 1000,
    metadata: { model: node.metadata?.model || 'flux-schnell', prompt: node.metadata?.prompt || '' }
  };
  pendingConfirmations.set(confirmationId, request);
  setTimeout(() => pendingConfirmations.delete(confirmationId), 5 * 60 * 1000);
  return request;
}

export function resolveConfirmation(confirmationId: string, approved: boolean): { valid: boolean; workflow_id?: string; node_id?: string; error?: string } {
  const request = pendingConfirmations.get(confirmationId);
  if (!request) return { valid: false, error: 'CONFIRMATION_NOT_FOUND' };
  if (Date.now() > request.expires_at) {
    pendingConfirmations.delete(confirmationId);
    return { valid: false, error: 'CONFIRMATION_EXPIRED' };
  }
  pendingConfirmations.delete(confirmationId);
  if (!approved) return { valid: false, error: 'SPEND_DECLINED' };
  return { valid: true, workflow_id: request.workflow_id, node_id: request.node_id };
}

interface WorkflowEvent {
  event_id: string;
  event_type: string;
  session_id: string;
  workflow_id: string;
  node_id: string;
  role?: string;
  status?: string;
  occurred_at: number;
  request_id?: string;
  metadata?: any;
}

const workflowEvents = new Map<string, WorkflowEvent[]>();
const eventIdSet = new Set<string>();

function generateEventId(): string {
  let eventId: string;
  do {
    eventId = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 11)}`;
  } while (eventIdSet.has(eventId));
  eventIdSet.add(eventId);
  return eventId;
}

export function appendWorkflowEvent(event: Omit<WorkflowEvent, 'event_id' | 'occurred_at'>): WorkflowEvent {
  const fullEvent: WorkflowEvent = { ...event, event_id: generateEventId(), occurred_at: Date.now() };
  const workflowId = event.workflow_id;
  if (!workflowEvents.has(workflowId)) workflowEvents.set(workflowId, []);
  workflowEvents.get(workflowId)!.push(fullEvent);
  return fullEvent;
}

export function getWorkflowEvents(workflowId: string, sinceEventId?: string): WorkflowEvent[] {
  const events = workflowEvents.get(workflowId) || [];
  if (!sinceEventId) return events;
  const sinceIndex = events.findIndex(e => e.event_id === sinceEventId);
  return sinceIndex === -1 ? events : events.slice(sinceIndex + 1);
}

/** TTS（配音）估价：按字符计，定价权威在此模块，工具侧不得硬编码。 */
export function estimateTtsCoins(model: string, text: string): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0.1;
  const chars = (text || '').length;
  return Math.round((pricing.base_cost + (pricing.per_char ?? 0) * chars) * 1000) / 1000;
}

export { MODEL_PRICING, MODEL_REF_CONSTRAINTS };
