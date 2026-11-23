import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Icon } from "./icons";
import { cn } from "../../lib/cn";
import type { AgentItem } from "./types";
type AgentSubagentItem = Extract<AgentItem, { kind: "subagent" }>;
import {
  STICK_BOTTOM_PX,
  STATUS_DOT,
  STATUS_WORD,
  STATUS_WORD_TONE,
  SubagentTranscriptLines,
  useSubagentTranscript,
} from "./AgentSubagentBar";

/**
 * 子代理整屏视图（2026-10-25）。
 *
 * 点 AgentSubagentBar 的行进入：全宽替换主转录区，看这一路子代理的完整转录。
 * 转录取数复用 AgentSubagentBar 导出的 useSubagentTranscript——轮询／offset／
 * 停止只有那一份实现，这里不另写第二套。
 *
 * 只读视图：不提供输入框（发送请返回主对话），唯一的写操作是「停止」这一路。
 */
export function AgentSubagentView({
  item,
  sessionId,
  onBack,
}: {
  item: AgentSubagentItem;
  sessionId?: string | null;
  onBack: () => void;
}) {
  const running = item.status === "running";
  const { entries, loaded, loadError, stopState, handleStop, transcriptStatus } = useSubagentTranscript(
    sessionId,
    item.subagentId,
    running,
  );

  const stickRef = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportHeight = useRef(0);
  useEffect(() => {
    Taro.nextTick(() => {
      Taro.createSelectorQuery().select('#agent-subagent-transcript').boundingClientRect((rect) => {
        if (rect && !Array.isArray(rect)) viewportHeight.current = rect.height;
      }).exec();
    });
  }, [item.subagentId]);
  const displayStatus = transcriptStatus ?? item.status;
  const stopped = stopState === "stopped" || displayStatus === "stopped";
  const stillRunning = displayStatus === "running" && stopState !== "stopped";

  return (
    <View className="agent-rise absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-background/95 backdrop-blur-[2px]">
      {/* 头部：返回 + 标签 + 状态。返回按钮是唯一的强制出口，放最左。 */}
      <View className="flex min-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/40 px-2 py-1.5">
        <View
          onClick={onBack}
          aria-label="返回主对话"
          className="flex min-h-9 shrink-0 cursor-pointer touch-manipulation items-center gap-1 rounded-[10px] px-2 text-ios-footnote font-medium text-muted-foreground transition-colors hover:bg-white/55 hover:text-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 [-webkit-tap-highlight-color:transparent]"
        >
          <Icon name="arrow-left-a85" className="h-4 w-4 shrink-0" aria-hidden="true" />
          返回
        </View>
        <Icon name="bot-a40" className="h-4 w-4 shrink-0 text-foreground/40" aria-hidden="true" />
        <Text className="min-w-0 max-w-[45%] text-ios-footnote font-medium text-foreground/80 [overflow-wrap:anywhere]">
          {item.label}
        </Text>
        {/* 状态词与圆点沿用行的语义表，颜色纪律一致：运行＝蓝、失败＝红、其余灰。 */}
        <Text className={cn("shrink-0 whitespace-nowrap text-ios-footnote tabular-nums", STATUS_WORD_TONE[displayStatus])}>
          {STATUS_WORD[displayStatus]}
        </Text>
        <Text
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[displayStatus])}
          aria-label={STATUS_WORD[displayStatus]}
        />
        <Text className="min-w-0 flex-1" />
        {/* 停止只对真正在跑的一路出现；跑完的没有可停的东西，不画死按钮。 */}
        {stillRunning && (
          <View
              onClick={() => void handleStop()}
            aria-disabled={stopState === "stopping"}
            className="flex min-h-9 shrink-0 cursor-pointer touch-manipulation items-center gap-1 rounded-[10px] px-2 text-ios-footnote font-medium text-ios-red transition-colors hover:bg-ios-red/10 disabled:cursor-default disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-red/30 [-webkit-tap-highlight-color:transparent]"
          >
            {stopState === "stopping" ? "停止中…" : "停止"}
          </View>
        )}
        {stopped && <Text className="shrink-0 text-ios-footnote text-muted-foreground">已停止</Text>}
        {stopState === "failed" && <Text className="shrink-0 text-ios-footnote text-ios-red">停止失败</Text>}
      </View>

      {/* 转录区：唯一滚动容器。overflow-x-hidden 防超宽内容撑出横向滚动条。 */}
      <ScrollView id="agent-subagent-transcript" scrollY style={{ height: '100%' }} scrollIntoView={stickRef.current ? `agent-subagent-transcript-end-${entries.length}` : undefined} scrollTop={scrollTop} onScroll={(event) => {
          setScrollTop(event.detail.scrollTop);
          stickRef.current = event.detail.scrollHeight - event.detail.scrollTop - viewportHeight.current <= STICK_BOTTOM_PX;
        }}
        aria-live={stillRunning ? "polite" : "off"}
        className="agent-transcript min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-3 pt-2"
      >
        {entries.length > 0 ? (
          <SubagentTranscriptLines entries={entries} />
        ) : !loaded ? (
          <View className="flex items-center gap-1.5 py-3 text-ios-footnote text-muted-foreground">
            <Icon name="loader-2-blue" className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
            正在载入转录…
          </View>
        ) : loadError ? (
          // 拉取失败降级：用手里已有的本地记录（可能为空），不弹错、不假装有内容。
          <TransientEmpty item={item} />
        ) : (
          <TransientEmpty item={item} />
        )}
        <View id={`agent-subagent-transcript-end-${entries.length}`} />
      </ScrollView>
    </View>
  );
}

/**
 * 没有可拉取的转录时的降级内容：显示帧里已有的全文／摘要。
 * 诚实标注来源，不把「本地帧里的片段」说成完整转录。
 */
function TransientEmpty({ item }: { item: AgentSubagentItem }) {
  const text = item.text?.trim() || item.summary?.trim() || item.lastLine?.trim();
  if (!text) {
    return <Text className="py-3 text-ios-footnote text-muted-foreground">这一路没有可显示的转录。</Text>;
  }
  return (
    <View className="flex flex-col gap-1 py-2">
      <Text className="text-ios-caption1 text-muted-foreground">以下是本回合已收到的内容，完整转录未能读取。</Text>
      <Text className="whitespace-pre-wrap break-words text-ios-subheadline text-foreground/85">{text}</Text>
    </View>
  );
}

export default AgentSubagentView;
