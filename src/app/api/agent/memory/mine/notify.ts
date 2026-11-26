import { callAgentGateway } from "@/lib/agent/agent-gateway";

/**
 * 通知 gateway：该账号的记忆刚被用户改／删——失效召回缓存，并把在线会话 L0 里已删的条目摘掉。
 * best-effort：网关不可达不影响删除本身（缓存 5 分钟后自愈），所以吞错。
 */
export async function notifyGatewayMemoryChanged(key: string, change: { ids?: string[]; all?: boolean; texts?: string[] }): Promise<void> {
  try {
    await callAgentGateway("/agent/v1/memory/changed", { method: "POST", key, body: change });
  } catch {
    /* 见上：不挡用户操作 */
  }
}
