"use client";

// /p/<shareId> 的主按钮：「做同款」。
//
// 這裡不做新的交接鏈，只把兩條既有輪子接起來：
//   ①登入後注入：`?agent=1&q=` 是圖庫卡（D-18）與模板庫共用的既有交接通道，
//     ImagePlayground 落地即把它注入助理輸入框（agentSeed → PromptInput
//     initialPrompt），使用者只要按送出。
//   ②未登入不丟話：commit a8362440 的 stashBlockedSend 寫進 PROMO_PENDING_KEY
//     （與宣傳片收尾、首頁主輸入區同一格），ImagePlayground 既有的
//     「登入態翻真 → 補送」effect 原樣接手。GitHub 登入是同窗口整頁跳轉，
//     元件狀態全死——不先寫進那一格，這句話就真的沒了。
//
// 為什麼未登入也要一起帶 q：使用者落地就看見「要照著做的那句話」已經在輸入框裡，
// 一眼知道按下去會做什麼；被登入擋下時同一句話由 pending 那格接住，不會兩份。

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { stashBlockedSend } from "@/components/promo/promo-gate";
import { buildRemixHandoffUrl, buildRemixSeed } from "@/lib/share-remix";

export interface RemixButtonProps {
  shareId: string;
  /** 對外視圖的提示詞：null ＝ 作者隱藏了它，注入配方裡就不會出現半個字。 */
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
    // 水合中＝還不知道登入態，不對狀態不明的使用者下決定（與 promo-gate 同款守衛）。
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
