"use client";

import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { autoGrow, buildAttachmentBlock, computeCanSend, nextSendBusy, releaseUrls } from "./AgentComposer.attachments";
import { SEND_HARD_TIMEOUT_MS } from "./AgentComposer.upload-limits";
import type { PendingAttachment } from "./AgentComposer.types";

interface ComposerSendPipelineProps {
  attachments: PendingAttachment[];
  trimmed: string;
  sending: boolean;
  sendingRef: RefObject<boolean>;
  externalSendPending: boolean;
  setSending: Dispatch<SetStateAction<boolean>>;
  sendUnlockTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  onSend: (text: string) => void | Promise<void>;
  setText: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  prefill?: { text: string; nonce: number } | null;
  onPrefillConsumed?: () => void;
  uploadAbortsRef: RefObject<Map<string, AbortController>>;
  uploadMountedRef: RefObject<boolean>;
  enqueueFiles: (files: File[]) => Promise<void>;
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
}

export function useComposerSendPipeline(P: ComposerSendPipelineProps): {
  retryAttachment: (id: string) => void;
  canSend: boolean;
  handleSend: () => void;
  attachmentsRef: RefObject<PendingAttachment[]>;
} {
  /** 重试：拿 chip 上保留的原 File 重走同一条入队管道（不新增上传器）。 */
  const retryAttachment = useCallback(
    (id: string) => {
      const gone = attachmentsRef.current.find((a) => a.id === id);
      if (!gone?.file) return;
      const file = gone.file;
      P.setAttachments((prev) => {
        const target = prev.find((a) => a.id === id);
        if (target) releaseUrls(target);
        return prev.filter((a) => a.id !== id);
      });
      void P.enqueueFiles([file]);
    },
    [P.enqueueFiles],
  );

  // 罪状 2a：只附文件不打字，发送链路也要通——有已传成功的附件即具备发送资格。
  const readyRefs = P.attachments
    .filter((a) => a.status === "ready")
    .flatMap((a) => a.refs ?? []);
  // 有附件仍在 uploading/extracting（未决出成功或失败）时禁止送出：
  // 这些文件还没到 ready，既进不了本次的附件区块，也不该被随后的清空动作
  // 连带清掉（否则它们上传中的 promise 落地时会打在已从 state 里消失的 id 上，
  // patchAttachment 静默 no-op，等同于用户数据丢失）。
  const canSend = computeCanSend(P.trimmed, readyRefs.length, P.attachments);

  /*
   * 09-18「在途」的单一收敛点：输入区自己的送出锁（sendingRef）与面板喂进来的
   * 在途（externalSendPending）合成同一个 sending——aria-busy={sending} 与
   * 「在途就转圈」这组既有契约（另一条测试线钉着字面）在面板在途期间也必须为真。
   *
   * 为什么是 render 期调整而不是 useEffect：effect 在静态渲染（SSR）里根本不跑，
   * 靠它会让「面板在途」的第一帧 aria-busy 缺位。这是 React 官方「prop 变了就
   * 把 state 收敛」的模式（render 期 setState 会被立刻合并进同一帧，不闪中间态）。
   */
  const nextBusy = nextSendBusy(P.sending, P.sendingRef.current, P.externalSendPending);
  if (nextBusy !== null) P.setSending(nextBusy);

  /**
   * 幂等解锁：ref 与 state 一起清，并清掉硬保险计时器。
   * 三条路径都会调它（promise 结算 / 硬保险到点 / onSend 同步 throw），
   * 所以必须能重复调用而不出错。
   */
  const unlockSend = useCallback(() => {
    if (P.sendUnlockTimerRef.current !== null) {
      clearTimeout(P.sendUnlockTimerRef.current);
      P.sendUnlockTimerRef.current = null;
    }
    P.sendingRef.current = false;
    P.setSending(false);
  }, []);

  // 组装最终文本：附加 [附件] 区块（只纳入已传成功的），然后交给 onSend。
  // 影片一条 chip 展开成 4 行（4 张帧各自一个 path），编号连续。
  // 纯附件发送（空文本）：只发附件区块，不带前导换行。
  const handleSend = useCallback(() => {
    // 同步连点守卫：同一帧内第二次点击时 sending 还是旧值，只有 ref 挡得住。
    if (P.sendingRef.current) return;
    // 09-18：面板喂进来的在途同样要挡——Enter 这条入口不吃 disabled 属性，
    // 空态并发 send 是已记录的竞态（两条消息、两次计费）。
    if (P.externalSendPending) return;
    if (!canSend) return;
    // 快照「本次实际发出去」的附件：canSend 已挡掉 uploading/extracting，
    // 正常情况下这就等于当前 attachments 全量；仍按 id 过滤只清掉这些，
    // 防御 state 更新与点击之间的竞态（React 批处理导致 attachments 快照
    // 与本次渲染看到的不完全一致时，不误清尚在途的项）。
    const sentAttachments = P.attachments.filter((a) => a.status === "ready");
    const finalText = P.trimmed
      ? readyRefs.length > 0
        ? `${P.trimmed}\n${buildAttachmentBlock(readyRefs)}`
        : P.trimmed
      : buildAttachmentBlock(readyRefs).replace(/^\n+/, "");
    // 通过资格检查后立刻上锁，不等 re-render。
    P.sendingRef.current = true;
    P.setSending(true);
    P.sendUnlockTimerRef.current = setTimeout(unlockSend, SEND_HARD_TIMEOUT_MS);
    try {
      // 统一成 promise：void 回调走 resolved 分支，finally 立刻解锁。
      // catch 吞掉错误——用户可见的错误提示由 hook 的 notice 负责，
      // 这里只负责别留 unhandled rejection，并把锁放掉。
      Promise.resolve(P.onSend(finalText))
        .catch(() => {})
        .finally(unlockSend);
    } catch {
      // onSend 同步 throw（不是返回 rejected promise）＝ 这条消息根本没送出去：
      // 解锁后直接返回，不清输入框、不释放附件——吃掉使用者的话且没人接手
      // 比留一个可重试的框更糟。
      unlockSend();
      return;
    }
    P.setText("");
    // 清空文字后高度要跟着收回来，否则空框还占着刚才那几行。
    if (P.textareaRef.current) {
      P.textareaRef.current.style.height = "auto";
    }
    // 只释放并移除本次实际发出去的附件，不连带清掉仍在途的项。
    const sentIds = new Set(sentAttachments.map((a) => a.id));
    sentAttachments.forEach(releaseUrls);
    P.setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
  }, [canSend, P.trimmed, readyRefs, P.onSend, P.attachments, unlockSend, P.externalSendPending]);

  /**
   * D-24：把半句话接进输入框并把光标放到末尾——用户下一个动作就是继续打字。
   * 框里已经有字时接在后面而不是覆盖：覆盖等于把人刚打的东西吃掉。
   * 只认 nonce 变化，所以「同一句话点两次」也生效，而重渲染不会重复注入。
   */
  const consumedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!P.prefill) return;
    const incoming = P.prefill.text.trim();
    if (!incoming || consumedNonceRef.current === P.prefill.nonce) return;
    consumedNonceRef.current = P.prefill.nonce;
    P.setText((current) => {
      const base = current.trimEnd();
      return base ? `${base} ${incoming}` : incoming;
    });
    // 聚焦要等这次 setState 刷完，否则 selectionStart 落在旧内容的长度上。
    //
    // 这里故意不 return cancelAnimationFrame：下一行的 onPrefillConsumed 会把上游的
    // prefill 置空，依赖变化 → 清理函数在 rAF 回调之前就跑，光标永远等不到。
    // 组件卸载时 textareaRef.current 已被 React 置 null，回调自己会退出。
    requestAnimationFrame(() => {
      const el = P.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    });
    P.onPrefillConsumed?.();
  }, [P.prefill, P.onPrefillConsumed]);

  // 卸载时兜底释放：用户直接关掉聊天面板时不会走 removeAttachment。
  // 依赖空数组 + ref 读最新值，避免每次 attachments 变化都重挂 effect。
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = P.attachments;
  useEffect(() => {
    P.uploadMountedRef.current = true;
    return () => {
      P.uploadMountedRef.current = false;
      P.uploadAbortsRef.current.forEach((controller) => controller.abort());
      P.uploadAbortsRef.current.clear();
      attachmentsRef.current.forEach(releaseUrls);
    };
  }, []);

  // 卸载时清掉硬保险计时器：面板关掉后不该还有 setTimeout 攥着 setState。
  useEffect(() => {
    return () => {
      if (P.sendUnlockTimerRef.current !== null) {
        clearTimeout(P.sendUnlockTimerRef.current);
        P.sendUnlockTimerRef.current = null;
      }
    };
  }, []);

  return { retryAttachment, canSend, handleSend, attachmentsRef };
}
