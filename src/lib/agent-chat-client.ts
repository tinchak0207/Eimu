// Agent 聊天的传输层：只负责把请求打到站内的 agent 代理路由，不碰 React。
//
// 身份：token 和 user id 必须成对送出 —— `Authorization: Bearer <token>` 加
// `x-user-id`。agent 代理的 resolveAgentCaller → requireVerifiedUser →
// authenticateImageUser 是拿这两个头一起去问上游 /api/user/self 的：上游会拒绝
// 「令牌持有者 ≠ 头里声称的 id」，所以 id 不是干扰，它是校验的另一半。
// 少送 id，authenticateImageUser 在 `if (!auth || !userId)` 就 401，
// 已登录的用户也会被挡在门外（这正是 agent 一开就报 401 的原因）。
//
// 错误：统一丢 AgentChatError（带 code），UI 分支用 code 判断，不做字串比对。
// 安全：本模组永不 log token、ticket 或任何可能携带它们的 response body。

export type {
  AgentAttachment,
  AgentChatErrorCode,
  AgentSessionInfo,
  AgentSseTicket,
  AgentQuotaWire,
  AgentSessionSummary,
  SendAgentMessageOptions,
  DirectSendCapability,
  DirectSendContext,
  AgentInterruptMode,
  AgentPersonaMode,
  AgentCostMode,
  AgentInteractionMode,
  AgentSettings,
  AgentThinkingLevel,
} from "./agent-chat-client/types";
export {
  SSE_TICKET_TTL_MS,
  AgentChatError,
  isTerminalAuthError,
  DEFAULT_AGENT_SETTINGS,
  AGENT_THINKING_LEVELS,
  AGENT_THINKING_LEVEL_SETTINGS,
  AGENT_THINKING_LEVEL_LABELS,
  AGENT_THINKING_LEVEL_HINTS,
  AGENT_THINKING_LEVEL_STORAGE_KEY,
} from "./agent-chat-client/types";
export {
  isSteerUnavailableError,
  isSteerReplayRejected,
  steerReplayStatus,
  tryAuthHeaders,
} from "./agent-chat-client/auth";
export {
  DIRECT_SEND_TIMEOUT_MS,
  createDirectSendCapability,
  deriveMessagesUrl,
  collectClientEnvironment,
  requestSseTicket,
  buildEventsUrl,
} from "./agent-chat-client/transport";
export type { AgentSteerAck, AgentSteerOptions } from "./agent-chat-client/session";
export {
  patchAgentSessionMemory,
  listAgentSessions,
  listAgentSubagents,
  readAgentSubagentTranscript,
  stopAgentSubagent,
  createAgentSession,
  sendAgentMessage,
  syncDevicePermissionMode,
  toAgentAttachmentRef,
  uploadAgentAttachments,
  resolveAgentConfirm,
  replyAgentQuestion,
  deleteAgentSession,
  fetchAgentSessionMessages,
  steerAgentSession,
  abortAgentSession,
  fetchAgentQuota,
} from "./agent-chat-client/session";
export {
  readCachedAgentSettings,
  writeCachedAgentSettings,
  getAgentSettings,
  saveAgentSettings,
  agentThinkingLevelPatch,
  inferAgentThinkingLevel,
  readCachedAgentThinkingLevel,
  writeCachedAgentThinkingLevel,
  resolveAgentThinkingLevel,
} from "./agent-chat-client/settings";
