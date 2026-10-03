// agent-surface-actions 的單測：用最小 window 樁驗「有無宿主」這個事實的回報，
// 因為這是呼叫端決定退路的唯一依據。不引 jsdom。

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SURFACE_ACTION_EVENT,
  requestAgentSurfaceAction,
  subscribeAgentSurfaceActions,
  type AgentSurfaceAction,
} from "./agent-surface-actions";

/** 最小 window 樁：只有事件註冊與「依 defaultPrevented 回傳」的 dispatchEvent。 */
function makeWindowStub(): {
  window: Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">;
} {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    window: {
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn as (event: Event) => void);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn as (event: Event) => void);
      },
      dispatchEvent(event: Event) {
        for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
        return !event.defaultPrevented;
      },
    } as Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">,
  };
}

function withWindow<T>(stub: ReturnType<typeof makeWindowStub>["window"] | null, run: () => T): T {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  if (stub) g.window = stub;
  else delete g.window;
  try {
    return run();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

test("無 window（SSR）時回 false", () => {
  withWindow(null, () => {
    assert.equal(requestAgentSurfaceAction("assets"), false);
  });
});

test("有人接走時回 true，且 handler 收到正確 action", () => {
  withWindow(makeWindowStub().window, () => {
    const seen: AgentSurfaceAction[] = [];
    const unsubscribe = subscribeAgentSurfaceActions((action) => {
      seen.push(action);
      return true;
    });
    assert.equal(requestAgentSurfaceAction("history"), true);
    assert.deepEqual(seen, ["history"]);
    unsubscribe();
  });
});

test("handler 回 false 時回 false（呼叫端會退回導航）", () => {
  withWindow(makeWindowStub().window, () => {
    const seen: AgentSurfaceAction[] = [];
    const unsubscribe = subscribeAgentSurfaceActions((action) => {
      seen.push(action);
      return false;
    });
    assert.equal(requestAgentSurfaceAction("exit"), false);
    assert.deepEqual(seen, ["exit"]);
    unsubscribe();
  });
});

test("退訂後不再收到事件（且無人接走 ⇒ false）", () => {
  withWindow(makeWindowStub().window, () => {
    let calls = 0;
    const unsubscribe = subscribeAgentSurfaceActions(() => {
      calls += 1;
      return true;
    });
    unsubscribe();
    assert.equal(requestAgentSurfaceAction("new-session"), false);
    assert.equal(calls, 0);
  });
});

test("事件名與可取消語意：監聽者呼叫 preventDefault 決定回報", () => {
  const stub = makeWindowStub();
  withWindow(stub.window, () => {
    // 直接掛一個原生監聽，驗證 dispatchEvent 回傳值由 defaultPrevented 決定。
    let received = false;
    stub.window.addEventListener(AGENT_SURFACE_ACTION_EVENT, (event) => {
      received = true;
      event.preventDefault();
    });
    assert.equal(requestAgentSurfaceAction("settings"), true);
    assert.equal(received, true);
  });
});
