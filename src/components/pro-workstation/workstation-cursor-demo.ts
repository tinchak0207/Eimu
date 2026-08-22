import { prefersTouchTour } from "@/lib/tour-mobile";

/**
 * 引导演示用的假鼠标（圆角指针形状，蓝色描边）：按步骤序列移动/点击/打字，
 * 像看着别人教一遍——悬停模型按钮 → 落到 PixAI → 点选；或飞入输入框逐字
 * 打出灰色示例关键词。元素用函数动态解析（菜单是后渲染的）。
 * 用户已手动操作（已输入/已选中）时对应步骤自动跳过。
 */
export type CursorStep =
  | { kind: "move"; el: () => Element | null; ms?: number }
  | { kind: "click"; el: () => Element | null; ms?: number }
  | { kind: "type"; input: () => HTMLInputElement | null; text: string }
  | { kind: "pause"; ms: number }
  | { kind: "leave" };

export function runCursorDemo(steps: CursorStep[], onDone?: () => void): void {
  if (typeof window === "undefined") return;
  /*
    触摸设备不播假鼠标：手机上没有可见指针这个心智模型，而且演示里的
    pointerenter/hover 在触摸端不会产生桌面那样的展开效果，只会看到一个
    幽灵光标在屏幕上乱飞、盖住正要看的卡片。直接跳过并执行收尾回调。
  */
  if (prefersTouchTour()) {
    onDone?.();
    return;
  }
  const cursor = document.createElement("div");
  cursor.className = "tour-fake-cursor";
  document.body.appendChild(cursor);
  // 起点：视口右侧之外（像从引导弹窗方向滑进来）
  let cx = window.innerWidth + 80;
  let cy = Math.round(window.innerHeight / 2);
  cursor.style.left = `${cx}px`;
  cursor.style.top = `${cy}px`;
  let index = 0;

  // 目标元素可能还没渲染（菜单/面板异步出现）：等它，而不是跳过导致演示中途消失
  const waitForEl = (get: () => Element | null, done: (el: Element | null) => void, timeout = 2500) => {
    const started = Date.now();
    const poll = () => {
      const el = get();
      if (el) {
        done(el);
        return;
      }
      if (Date.now() - started > timeout) {
        done(null);
        return;
      }
      window.setTimeout(poll, 120);
    };
    poll();
  };

  // 指针尖端（元素左上角）对准目标中心
  const centerOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const moveTo = (x: number, y: number, ms: number) => {
    const dx = x - cx;
    const dy = y - cy;
    cx = x;
    cy = y;
    cursor.style.transitionDuration = `${ms}ms, 300ms, 120ms`;
    cursor.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const press = (el: Element) => {
    cursor.classList.add("is-pressing");
    window.setTimeout(() => {
      cursor.classList.remove("is-pressing");
      (el as HTMLElement).click();
    }, 120);
  };

  const next = () => {
    if (index >= steps.length) {
      cursor.style.opacity = "0";
      window.setTimeout(() => cursor.remove(), 300);
      onDone?.();
      return;
    }
    const s = steps[index]!;
    index += 1;
    if (s.kind === "pause") {
      window.setTimeout(next, s.ms);
      return;
    }
    if (s.kind === "leave") {
      cursor.style.opacity = "0";
      window.setTimeout(() => {
        cursor.remove();
        onDone?.();
      }, 300);
      return;
    }
    if (s.kind === "type") {
      waitForEl(() => s.input() as Element | null, (el) => {
        if (!el) {
          next();
          return;
        }
        const input = el as HTMLInputElement;
        const target = centerOf(el);
        moveTo(target.x, target.y, 650);
        window.setTimeout(() => {
          if (input.value.trim()) {
            cursor.style.opacity = "0";
            window.setTimeout(() => cursor.remove(), 300);
            onDone?.();
            return;
          }
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          const originalColor = input.style.color;
          let i = 0;
          const typeChar = () => {
            if (i >= s.text.length) {
              // 打完：停顿 350ms（瞄一眼结果）→ 恢复文字颜色 → 快走
              window.setTimeout(() => {
                input.style.color = originalColor;
                next();
              }, 350);
              return;
            }
            i += 1;
            setter?.call(input, s.text.slice(0, i));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.style.color = "hsl(var(--foreground) / 0.45)";
            window.setTimeout(typeChar, 130);
          };
          window.setTimeout(typeChar, 120);
        }, 700);
      });
      return;
    }
    // move / click：等目标出现，再飞过去
    waitForEl(s.el, (el) => {
      if (!el) {
        next();
        return;
      }
      const target = centerOf(el);
      moveTo(target.x, target.y, s.ms ?? 650);
      if (s.kind === "click") {
        window.setTimeout(() => {
          if (!el.isConnected) {
            next();
            return;
          }
          press(el);
          window.setTimeout(next, 300);
        }, (s.ms ?? 650) + 60);
      } else {
        window.setTimeout(next, (s.ms ?? 650) + 40);
      }
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(next);
  });
}
