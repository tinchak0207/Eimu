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
  /** 按住目标（进入持续按压态）：配合后续 move 序列即可演出「拖拽」轨迹。 */
  | { kind: "down"; el: () => Element | null; ms?: number }
  /** 释放按住态。 */
  | { kind: "up" }
  | { kind: "type"; input: () => HTMLInputElement | null; text: string }
  | { kind: "pause"; ms: number }
  | { kind: "leave" };

export interface RunCursorDemoOptions {
  /** 2026-08-27（atc 圆环教学返工）：目标丢失（el 解析为 null 或等待超时）时
   *  立即整场收尾（淡出移除 + onDone），不再跳步硬演——演示中途目标漂移时
   *  宁可消失也不在错误坐标表演。默认 false：LoRA 引导等「菜单后渲染」场景
   *  仍沿用轮询等不到就跳步的旧行为。 */
  abortOnMissingTarget?: boolean;
}

export function runCursorDemo(
  steps: CursorStep[],
  onDone?: () => void,
  options: RunCursorDemoOptions = {},
): void {
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
  const baseX = window.innerWidth + 80;
  const baseY = Math.round(window.innerHeight / 2);
  cursor.style.left = `${baseX}px`;
  cursor.style.top = `${baseY}px`;

  /*
    moveTo 语义是「绝对定位」：transform 被【整体替换】而非叠加，所以
    translate 必须是「目标 − 起点」的绝对偏移。旧实现按增量（新目标 − 上次
    目标）计算，连续 move 到同一目标时 translate 被替换成 (0,0)，指针瞬移
    回屏幕外起点——2026-08-27 atc 拖拽教学三次返工的真因（move 到站0 →
    down 又 moveTo 站0 → transform 归零 → 指针跳回 spawn 点再「拖拽」）。
    LoRA 引导没暴露是因为它的步骤目标各不相同，增量碰巧等于绝对偏移。
  */
  const moveTo = (x: number, y: number, ms: number) => {
    const dx = x - baseX;
    const dy = y - baseY;
    cursor.style.transitionDuration = `${ms}ms, 300ms, 120ms`;
    cursor.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  let index = 0;
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

  const press = (el: Element) => {
    cursor.classList.add("is-pressing");
    window.setTimeout(() => {
      cursor.classList.remove("is-pressing");
      (el as HTMLElement).click();
    }, 120);
  };

  // 目标丢失的统一收口：默认跳步继续（菜单后渲染场景）；abortOnMissingTarget
  // 下整场干净收尾（松开按压态 + 淡出移除 + onDone），不在断裂的演示里硬演。
  const missingTarget = () => {
    if (!options.abortOnMissingTarget) {
      next();
      return;
    }
    cursor.classList.remove("is-holding");
    cursor.style.opacity = "0";
    window.setTimeout(() => cursor.remove(), 300);
    onDone?.();
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
    if (s.kind === "up") {
      cursor.classList.remove("is-holding");
      window.setTimeout(next, 220);
      return;
    }
    if (s.kind === "type") {
      waitForEl(() => s.input() as Element | null, (el) => {
        if (!el) {
          missingTarget();
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
    // move / click / down：等目标出现，再飞过去
    waitForEl(s.el, (el) => {
      if (!el) {
        missingTarget();
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
      } else if (s.kind === "down") {
        // 到位后进入按住态（不触发真实 click——只演示轨迹与按压形变）
        window.setTimeout(() => {
          cursor.classList.add("is-holding");
          window.setTimeout(next, 260);
        }, (s.ms ?? 650) + 40);
      } else {
        window.setTimeout(next, (s.ms ?? 650) + 40);
      }
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(next);
  });
}
