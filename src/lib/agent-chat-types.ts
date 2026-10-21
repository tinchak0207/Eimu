// Agent 聊天的线路契约：网关 SSE 事件 → 前端可渲染的模型。
//
// 这个文件是「唯一的事实来源」，对齐 /opt/agent-harness/gateway/index.ts 的
// serializeSse()：每一帧都是 `id: <n>` + `event: <name>` + `data: <json>`，
// 且 data 一律被注入 `event_id`（= 那个 id）。前端只认这里宣告的栏位；
// 网关多送的栏位一律忽略，少送的栏位一律当 undefined 处理，不抛错 ——
// 一个没见过的栏位不该让整个对话白屏。
//
// 站上目前没有任何 SSE 消费者（全站都是轮询），所以没有既有模式可抄；
// 反过来说也没有既有包袱，这里定的形状就是后续所有 agent UI 的地基。

export type {
  AgentQuestionRequest,
  AgentQuestionReplied,
  AgentQuestionRejected,
  AgentEventName,
  AgentMessageDelta,
  AgentReasoningDelta,
  AgentToolInvoke,
  AgentToolResult,
  AgentToolAuthScope,
  AgentToolProgress,
  AgentImageDone,
  AgentVideoDone,
  AgentAudioDone,
  AgentDirectorDone,
  AgentImageFailed,
  AgentTurnDone,
  AgentTurnStatus,
  AgentContextCompacted,
  AgentTurnPlan,
  AgentConfirmRequest,
  AgentConfirmResolved,
  AgentQuotaChanged,
  AgentSessionError,
  AgentSessionClosed,
  AgentCanvasPlan,
  AgentCanvasNodeCreated,
  AgentCanvasNodeUpdated,
  AgentCanvasNodeConnected,
  AgentCanvasNodeGenerating,
  AgentCanvasNodeDeleted,
  AgentCanvasNodeDisconnected,
  AgentCanvasDeriveStarted,
  AgentCanvasBudgetUpdated,
  AgentSubagentStarted,
  AgentSubagentDelta,
  AgentSubagentDone,
  AgentSubagentTool,
  AgentSseEvent,
  AgentSteerStatus,
  AgentSteerStatusEvent,
} from "./agent-chat-types/types-events";
export { AGENT_EVENT_NAMES, isAgentEventName, AGENT_STEER_STATUSES, AGENT_STEER_QUEUE_TTL_MS } from "./agent-chat-types/types-events";
export type {
  AgentTranscriptItem,
  AgentUserTurnItem,
  AgentAttachmentRef,
  AgentAssistantTextItem,
  AgentToolCallItem,
  AgentToolAuthorization,
  AgentImageItem,
  AgentVideoItem,
  AgentAudioItem,
  AgentDirectorItem,
  AgentNoticeItem,
  AgentSubagentItem,
  AgentSubagentToolEntry,
  AgentSubagentReportItem,
  AgentPlanItem,
  AgentPendingConfirm,
  AgentPendingQuestion,
  AgentQuotaState,
  AgentChatState,
} from "./agent-chat-types/types-core";
export { EMPTY_AGENT_CHAT_STATE } from "./agent-chat-types/types-core";
export type {
  AgentSubagentRunTool,
  AgentSubagentRunArtifact,
  AgentSubagentRunTranscriptInfo,
  AgentSubagentRunSummary,
  AgentSubagentTranscriptEntry,
  AgentSubagentTranscriptPage,
  OpenCodeMessageInfo,
  OpenCodeMessage,
  AgentSessionHistoryResponse,
} from "./agent-chat-types/types-agent";
export { parseAuthOptions, detectBinaryText, parseAgentSseEvent } from "./agent-chat-types/sse-parse";
