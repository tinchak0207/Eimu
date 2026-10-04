import test from "node:test";
import assert from "node:assert/strict";
import {
  computePanelAnchor,
  nextPanelAnchor,
  type AnchorElement,
} from "@/components/notifications/NotificationBell";

// 面板落点是本刀唯一的真假分界：菜单项点下去 Radix 就关菜单，
// 触发那一行随之从 DOM 消失。所以坐标必须在点击当下量成数字存下来，
// 而且「量不到」时只能沿用旧坐标，不能清空（清了面板整个不显示）。

test("computePanelAnchor：顶栏底边低于触发元素时 top 从 barBottom 起算", () => {
  const anchor = computePanelAnchor({
    rect: { bottom: 40, right: 1200 },
    barBottom: 56,
    innerWidth: 1440,
  });
  assert.equal(anchor.top, 64); // barBottom 56 + 8 的缝
  assert.equal(anchor.right, 240); // 1440 - 1200
});

test("computePanelAnchor：视窗过窄时 right 贴在 8px 安全边上，不被推出视窗", () => {
  const narrow = computePanelAnchor({
    rect: { bottom: 40, right: 396 },
    barBottom: 40,
    innerWidth: 400,
  });
  assert.equal(narrow.right, 8); // 400 - 396 = 4，抬到安全边
  assert.ok(narrow.right >= 8);

  // 右缘已经越过视窗（比如在窄屏里量到负值）也仍然夹在安全边上。
  const overflow = computePanelAnchor({
    rect: { bottom: 40, right: 480 },
    barBottom: 40,
    innerWidth: 400,
  });
  assert.equal(overflow.right, 8);
});

test("nextPanelAnchor：触发元素已从 DOM 移除时保留既有坐标，绝不清成 null", () => {
  const previous = { top: 72, right: 16 };
  assert.equal(nextPanelAnchor(previous, null, 1440), previous);
  // 从来没有坐标可继承时才是「没有面板」，这不是把已有坐标清空。
  assert.equal(nextPanelAnchor(null, null, 1440), null);
});

test("nextPanelAnchor：走完「点开 → 菜单卸载」序列后，滚动/缩放回调仍然守得住坐标", () => {
  const el: AnchorElement = {
    getBoundingClientRect: () => ({ bottom: 188, right: 1392 }),
    closest: (selector: string) => (selector === ".lg-bar" ? { getBoundingClientRect: () => ({ bottom: 56 }) } : null),
  };

  const measured = nextPanelAnchor(null, el, 1440); // 点击当下：元素还在
  assert.deepEqual(measured, { top: 196, right: 48 });

  const afterUnmount = nextPanelAnchor(measured, null, 1440); // 菜单已关：ref 归 null
  assert.deepEqual(afterUnmount, { top: 196, right: 48 });
});

test("nextPanelAnchor：触发元素不在 .lg-bar 里（下拉菜单 portal 到 body）时以自身底边定位", () => {
  const el: AnchorElement = {
    getBoundingClientRect: () => ({ bottom: 300, right: 1400 }),
    closest: () => null,
  };
  assert.deepEqual(nextPanelAnchor(null, el, 1440), { top: 308, right: 40 });
});
