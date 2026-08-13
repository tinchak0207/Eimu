"use client";

// /agent 不再是一个页面。
//
// 使用者明确不要独立页：AI 助理是首页那张卡片上的一个 toggle（和「改图」「放大」
// 同一层级），按下去只换卡片中间那块控件区。所以这个路由只剩一件事——
// 把还存着旧书签、旧外链的人送回首页，并直接开在 agent 面。
//
// ?q= 原样转交：/history 的「交给 AI 助理继续做」（D-18）曾指向这里。
// 那些页面不像首页卡片能就地翻面，只能带着一句话跳走。

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function AgentRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    // URL 里塞进来的东西不可信，截一下长度，别让它撑爆输入区。
    const seeded = (params.get("q") ?? "").slice(0, 500);
    const query = seeded ? `?agent=1&q=${encodeURIComponent(seeded)}` : "?agent=1";
    // replace 而非 push：这个 URL 不该留在返回栈里，
    // 否则使用者在首页按「返回」会被弹回来、再跳一次。
    router.replace(`/${query}`);
  }, [params, router]);

  return null;
}

export default function AgentPage() {
  return (
    <div className="page-shell flex min-h-[60dvh] items-center justify-center">
      <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">正在打开 AI 助理...</p>
      {/* useSearchParams 需要 Suspense 边界，否则整页被迫走客户端渲染并告警。 */}
      <Suspense fallback={null}>
        <AgentRedirect />
      </Suspense>
    </div>
  );
}
