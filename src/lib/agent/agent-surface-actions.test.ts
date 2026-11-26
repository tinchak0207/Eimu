// agent-surface-actions 的单测：用最小 window 桩验「有无宿主」这个事实的回报，
// 因为这是呼叫端决定退路的唯一依据。不引 jsdom。

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SURFACE_ACTION_EVENT,
  requestAgentSurfaceAction,
  subscribeAgentSurfaceActions,
  type AgentSurfaceAction,
} from "./agent-surface-actions";

/** 最小 window 桩：只有事件注册与「依 defaultPrevented 回传」的 dispatchEvent。 */
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

test("无 window（SSR）时回 false", () => {
  withWindow(null, () => {
    assert.equal(requestAgentSurfaceAction("assets"), false);
  });
});

test("有人接走时回 true，且 handler 收到正确 action", () => {
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

test("handler 回 false 时回 false（呼叫端会退回导航）", () => {
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

test("退订后不再收到事件（且无人接走 ⇒ false）", () => {
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

test("事件名与可取消语意：监听者呼叫 preventDefault 决定回报", () => {
  const stub = makeWindowStub();
  withWindow(stub.window, () => {
    // 直接挂一个原生监听，验证 dispatchEvent 回传值由 defaultPrevented 决定。
    let received = false;
    stub.window.addEventListener(AGENT_SURFACE_ACTION_EVENT, (event) => {
      received = true;
      event.preventDefault();
    });
    assert.equal(requestAgentSurfaceAction("settings"), true);
    assert.equal(received, true);
  });
});
