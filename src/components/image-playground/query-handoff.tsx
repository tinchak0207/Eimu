import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { PromptInputMode } from "@/components/PromptInput";

/** 卡片的四个面。第四个面 agent 与 edit / upscale 同级，见 PromptInput。 */
export type PlaygroundMode = PromptInputMode;

/** 查询交接独立订阅：客户端历史导航也能接住，静态首页只让这一空组件等待查询。 */
export function AgentQueryHandoff({ onApply }: { onApply: (params: URLSearchParams) => void }) {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  useEffect(() => {
    const params = new URLSearchParams(query);
    onApply(params);
    if (params.get("agent") === "1") {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, [query, onApply]);
  return null;
}
