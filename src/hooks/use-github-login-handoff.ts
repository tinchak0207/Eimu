"use client";

// 登入入口的統一 hook：standalone PWA / Electron 桌面殼走跨瀏覽器交接（handoff），
// 其餘環境維持站內既有的同窗口跳轉。交接連結與輪詢狀態由 useState 持有，交給
// 呼叫方決定在哪裡畫交接面。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHandoffLogin,
  isElectronShell,
  isStandalonePwa,
  type HandoffProvider,
} from "@/lib/github-login";

export function useGithubLoginHandoff(): {
  handoffUrl: string | null;
  startLogin: (provider?: HandoffProvider) => Promise<void>;
  closeHandoff: () => void;
} {
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  // 進行中的 startLogin：連點去重（按鈕在 create 的 async 窗口內可被再點一次，
  // 不去重會發第二次 create，留下永遠無人認領的孤兒交接票）。
  const startInFlightRef = useRef<Promise<void> | null>(null);
  // 卸載後不動作（同 MySkillsDialog 的 aliveRef 慣例）：使用者在 create 飛行途中
  // 按「先不登录」／Esc／點外面／重播都會卸載本 hook，此時 async 閉包不得再
  // setHandoffUrl、更不得替「已經說不登入」的人開系統瀏覽器。
  const mountedRef = useRef(true);
  useEffect(() => {
    // 掛載即為真（不能在 setup 裡只寫一次 false 的清理：StrictMode 會 mount→cleanup→mount，
    // 只清理不復位會讓守衛永久卡在「已卸載」，正常登入也一併被吃掉）。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const startLogin = useCallback((provider: HandoffProvider = "github"): Promise<void> => {
    const inFlight = startInFlightRef.current;
    if (inFlight) return inFlight;

    const run = (async () => {
      // PWA standalone / Electron 殼：GitHub 登入态带不进来，改走跨浏览器交接面板。
      if (isStandalonePwa()) {
        const handoff = await createHandoffLogin(provider);
        // await 之後的分支動作（setHandoffUrl／殼導航／null fallback 導航）一律先過
        // 這道守衛：元件已卸載（使用者取消登入）就整個作廢。
        if (!mountedRef.current) return;
        if (handoff) {
          setHandoffUrl(handoff.loginUrl);
          // Electron 殼的导航政策会把 /api/auth/* 转去系统浏览器 ⇒ 壳体里点一下
          // 就同时开好授权页（交接面仍留在原地轮询）。
          if (isElectronShell()) {
            window.location.href = handoff.loginUrl;
          }
          return;
        }
        window.location.href = `/api/auth/${provider}/start`;
        return;
      }
      window.location.href = `/api/auth/${provider}/start`;
    })();

    startInFlightRef.current = run;
    // 本次跑完即清（settle 的 microtask 先於下一次點擊的 task），下一擊可再發。
    run
      .finally(() => {
        startInFlightRef.current = null;
      })
      .catch(() => {});
    return run;
  }, []);

  const closeHandoff = useCallback(() => setHandoffUrl(null), []);

  return { handoffUrl, startLogin, closeHandoff };
}
