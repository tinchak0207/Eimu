"use client";

// /p/<shareId> 的主按钮：「做同款」。
//
// 这里不做新的交接链，只把两条既有轮子接起来：
//   ①登入后注入：`?agent=1&q=` 是图库卡（D-18）与模板库共用的既有交接通道，
//     ImagePlayground 落地即把它注入助理输入框（agentSeed → PromptInput
//     initialPrompt），使用者只要按送出。
//   ②未登入不丢话：commit a8362440 的 stashBlockedSend 写进 PROMO_PENDING_KEY
//     （与宣传片收尾、首页主输入区同一格），ImagePlayground 既有的
//     「登入态翻真 → 补送」effect 原样接手。GitHub 登入是同窗口整页跳转，
//     元件状态全死——不先写进那一格，这句话就真的没了。
//
// 为什么未登入也要一起带 q：使用者落地就看见「要照著做的那句话」已经在输入框里，
// 一眼知道按下去会做什么；被登入挡下时同一句话由 pending 那格接住，不会两份。

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { stashBlockedSend } from "@/components/promo/promo-gate";
import { buildRemixHandoffUrl, buildRemixSeed } from "@/lib/share-remix";

export interface RemixButtonProps {
  shareId: string;
  /** 对外视图的提示词：null ＝ 作者隐藏了它，注入配方里就不会出现半个字。 */
  prompt: string | null;
  modelId: string;
  aspectRatio: string;
  imageSize: string;
}

export function RemixButton({ shareId, prompt, modelId, aspectRatio, imageSize }: RemixButtonProps) {
  const router = useRouter();
  const { isLoggedIn, isLoading } = useAuth();

  const handleRemix = useCallback(() => {
    const seed = buildRemixSeed({ prompt, modelId, aspectRatio, imageSize });
    // 水合中＝还不知道登入态，不对状态不明的使用者下决定（与 promo-gate 同款守卫）。
    if (!isLoading && !isLoggedIn) {
      stashBlockedSend(typeof window === "undefined" ? null : window.sessionStorage, seed);
    }
    router.push(buildRemixHandoffUrl(shareId, seed));
  }, [aspectRatio, imageSize, isLoggedIn, isLoading, modelId, prompt, router, shareId]);

  return (
    <button
      type="button"
      onClick={handleRemix}
      className="lg-transition flex w-full items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-6 py-3.5 text-ios-body font-semibold text-white shadow-[0_8px_24px_rgba(0,122,255,0.30)] hover:bg-[#0066DD] active:scale-[0.98]"
    >
      <Sparkles className="h-4 w-4" aria-hidden="true" />
      做同款
    </button>
  );
}

export default RemixButton;
