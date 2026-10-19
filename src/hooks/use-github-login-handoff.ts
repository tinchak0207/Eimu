"use client";

// 登入入口的统一 hook：standalone PWA / Electron 桌面壳走跨浏览器交接（handoff），
// 其余环境维持站内既有的同窗口跳转。交接连结与轮询状态由 useState 持有，交给
// 呼叫方决定在哪里画交接面。

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
  // 进行中的 startLogin：连点去重（按钮在 create 的 async 窗口内可被再点一次，
  // 不去重会发第二次 create，留下永远无人认领的孤儿交接票）。
  const startInFlightRef = useRef<Promise<void> | null>(null);
  // 卸载后不动作（同 MySkillsDialog 的 aliveRef 惯例）：使用者在 create 飞行途中
  // 按「先不登录」／Esc／点外面／重播都会卸载本 hook，此时 async 闭包不得再
  // setHandoffUrl、更不得替「已经说不登入」的人开系统浏览器。
  const mountedRef = useRef(true);
  useEffect(() => {
    // 挂载即为真（不能在 setup 里只写一次 false 的清理：StrictMode 会 mount→cleanup→mount，
    // 只清理不复位会让守卫永久卡在「已卸载」，正常登入也一并被吃掉）。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const startLogin = useCallback((provider: HandoffProvider = "github"): Promise<void> => {
    const inFlight = startInFlightRef.current;
    if (inFlight) return inFlight;

    const run = (async () => {
      // PWA standalone / Electron 壳：GitHub 登入态带不进来，改走跨浏览器交接面板。
      if (isStandalonePwa()) {
        const handoff = await createHandoffLogin(provider);
        // await 之后的分支动作（setHandoffUrl／壳导航／null fallback 导航）一律先过
        // 这道守卫：元件已卸载（使用者取消登入）就整个作废。
        if (!mountedRef.current) return;
        if (handoff) {
          setHandoffUrl(handoff.loginUrl);
          // Electron 壳的导航政策会把 /api/auth/* 转去系统浏览器 ⇒ 壳体里点一下
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
    // 本次跑完即清（settle 的 microtask 先于下一次点击的 task），下一击可再发。
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
