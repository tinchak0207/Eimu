import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 2026-09-20 逐模板拆档后：模板资料散在同目录多档，读整目录当一份来源。 */
function readDirSources(relDir: string) {
  const abs = join(process.cwd(), relDir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(abs, f), "utf8"))
    .join("\n");
}

/**
 * AgentTemplateCarousel 是 CaseShowcase.tsx 的逐行复制（2026-08-25 用户裁定：
 * 复用 = 整复制改文字，禁止造轮子）。测试锁死两件事：
 * ① 与首页的交互能力逐项等价（scroll drive / detent /
 *    commitSteps / 弹簧 / 键盘 / 圆点 / 箭头 / CasePromptReveal / 层栈）；
 *    （wheel 被动性除外：09-12 起本元件刻意 passive:true，见下方锚点注解。）
 * ② 模板化改动（数据源 / 卡面文字 / 正面卡启动）接线正确。
 */

test("carousel is a verbatim copy of CaseShowcase interaction machinery", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 触控板两指横扫：2026-09-12 性能审计落地（09-11 OOM note）——本元件 wheel
  // 改挂 { passive: true } 并移除 preventDefault（非 passive wheel 阻塞合成器
  // 滚动），与 CaseShowcase 的 passive:false 是**刻意分歧**，横向漂移的 CSS
  // 兜底（overscroll-behavior-x）在共用样式档，另片处理。deltaX 占优守卫保留。
  assert.match(source, /addEventListener\("wheel", onWheel, \{ passive: true \}\)/);
  assert.match(source, /Math\.abs\(event\.deltaX\) <= Math\.abs\(event\.deltaY\)/);

  // 滚动驱动 + IntersectionObserver 只在段内累计。
  assert.match(source, /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(source, /IntersectionObserver/);

  // 磁力与落格：detent/undetent/commitSteps 三件套 + 三角度 refs。
  assert.match(source, /detent\(rawRef\.current, STEP\)/);
  assert.match(source, /undetent\(angleRef\.current, STEP\)/);
  assert.match(source, /commitSteps\(travel, flickSteps\)/);

  // 二阶弹簧双档位（跟随/落格）+ dt 积分。
  assert.match(source, /SPRING_TRACK/);
  assert.match(source, /SPRING_SETTLE/);
  assert.match(source, /MAX_DT/);

  // 键盘导航 + 圆点 + 箭头。
  assert.match(source, /"ArrowRight"/);
  assert.match(source, /"ArrowLeft"/);
  assert.match(source, /case-dot/);
  assert.match(source, /case-arrow/);

  // 材质层栈：光照四件套的消费层一个不少。
  assert.match(source, /<div className="case-edge" aria-hidden="true" \/>/);
  assert.match(source, /<div className="case-surface" aria-hidden="true">/);
  assert.match(source, /<div className="case-sheen" \/>/);
  assert.match(source, /<div className="case-rim case-rim-l" \/>/);
  assert.match(source, /<div className="case-rim case-rim-r" \/>/);

  // 共享 CSS（禁止另起炉灶）。
  assert.match(source, /import "\.\.\/case-showcase\.css"/);
  // 共享物理库。
  assert.match(source, /from "@\/lib\/carousel-detent"/);
});

test("carousel renders template cards with poster watermark and circular step selector", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const data = readDirSources("src/lib/agent-templates");

  for (const template of AGENT_TEMPLATES) {
    assert.ok(data.includes(template.name), `模板数据应包含卡片名「${template.name}」`);
  }
  // 卡面：领域渐变海报 + 大字水印 + 圆形环节选择器（2026-08-26 替换黑话步骤链）。
  assert.match(source, /bg-gradient-to-br", item\.accent/);
  assert.match(source, /atc-watermark/);
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[item\.domain\]/);
  // 选择器（2026-09-29 重做）：签 = button + aria-pressed + 序号 + shortName。
  assert.match(source, /atc-step-selector/);
  assert.match(source, /step\.shortName/);
  assert.match(source, /aria-pressed=\{isSelected\}/);
  assert.match(source, /data-step-index/);
  // 刷子手势：window capture 四件套（触控板修复：冒泡会被 stage 转卡 move 截断）。
  assert.match(source, /window\.addEventListener\("pointermove", handleWindowMove, true\)/);
  assert.match(source, /window\.addEventListener\("pointerup", handleWindowUp, true\)/);
  assert.match(source, /window\.addEventListener\("pointercancel", endGesture, true\)/);
  assert.match(source, /removeEventListener\("pointermove", handleWindowMove, true\)/);
  assert.match(source, /onDragStart=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(source, /elementFromPoint/);
  // 刷子语义：目标状态 = 按下那格切换后的状态；扫过的格子只刷一次、不重置已有选择。
  assert.match(source, /target: !selected\.includes\(index\)/);
  assert.match(source, /working: new Set\(selected\)/);
  assert.match(source, /gesture\.visited\.has\(index\)/);
  assert.doesNotMatch(source, /gesture\.chosen/); // 旧「拖过 = 重置为扫过路径」退场
  // 触摸：按下不切换（可能是横滑），pointercancel 只收尾。
  assert.match(source, /pendingTap: isTouch \? index : null/);
  assert.match(source, /touch-none max-md:touch-pan-x/);
  // 键盘 click（detail=0）才在 onClick 切换。
  assert.match(source, /event\.detail !== 0/);
  // 09-29 定稿（项目负责人两次否决「控件铺满卡面遮成片」）：卡面默认只有一行按钮，
  // 环节收进「调整环节」展开的玻璃托盘（grid-rows 过渡，收起时 inert 不可聚焦）。
  assert.match(source, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(source, /inert=\{!open\}/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /\{open \? "收起" : "调整环节"\}/);
  assert.match(read("src/components/canvas-workstation/agent-template-carousel.css"), /\.atc-step-tray-wrap\[data-open\] \{\s*grid-template-rows: 1fr;/);
  // 执行 = 实心浅玻璃；跳过 = 细描边空位（不用删除线、不用白色实心色块）。
  assert.match(source, /bg-white\/\[0\.2\] font-medium text-white/);
  assert.match(source, /text-white\/45 shadow-\[inset_0_0_0_1px_rgba\(255,255,255,0\.16\)\]/);
  assert.doesNotMatch(source, /line-through/);
  assert.doesNotMatch(source, /border-white bg-white font-semibold/);
  // 说明文字、勾选框、拖拽徽章、Dock 空白全选全部退场。
  assert.doesNotMatch(source, /按住拖过 = 只跑扫过的/);
  assert.doesNotMatch(source, /role="checkbox"/);
  assert.doesNotMatch(source, /dragCount/);
  assert.doesNotMatch(source, /data-atc-hint/);
  // 旧黑话步骤链已退场。
  assert.doesNotMatch(source, /atc-flow/);
  assert.doesNotMatch(source, /join\(" → "\)/);
  // 8 张卡全部进入轮播数据源（props 直传）。
  assert.ok(AGENT_TEMPLATES.length >= 8, `内置模板应不少于 8 张，实际 ${AGENT_TEMPLATES.length}`);
});

test("front card no longer launches; the submit pill runs the picked steps", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 正面卡点击不做事，侧卡转到正面；movedRef 挡拖拽误触。确认弹窗整个退场。
  assert.match(source, /if \(movedRef\.current\) return;/);
  assert.match(source, /if \(index !== front\) goTo\(index\)/);
  assert.doesNotMatch(source, /setConfirmTemplate/);
  assert.doesNotMatch(source, /是否使用完整模板开始创作/);
  assert.doesNotMatch(source, /createPortal/);
  // 主按钮：空集护栏 + 文案即范围。
  assert.match(source, /if \(picked\.length > 0\) onUseTemplate\(item, picked\)/);
  assert.match(source, /开始创作\n/);
  assert.match(source, /\{canSubmit && !allSelected && \(/);
  assert.match(source, /\{count\}\/\{total\}/);
  assert.match(source, /disabled=\{!canSubmit\}/);
  // 选了部分才在托盘末尾出「恢复全部」。
  assert.match(source, /\{!allSelected && \(/);
  assert.match(source, /恢复全部/);
});

test("selection map: missing key = all steps (default), full set collapses back to default", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  assert.match(source, /if \(sorted\.length === count\) \{/);
  assert.match(source, /delete rest\[templateId\]/);
  assert.match(source, /selectedStepsByTemplate\[item\.id\] \?\?\s*Array\.from\(\{ length: item\.pipeline\.steps\.length \}/);
  assert.match(source, /const canSubmit = count > 0;/);
  // driver.js 教学不再由卡面触发（零说明文字的设计不需要教程）。
  assert.doesNotMatch(source, /maybeStartAtcTour|forceStartAtcTour/);
});

test("playground wires the carousel in place of the old gallery", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  assert.match(playground, /import \{ AgentTemplateCarousel \} from "@\/components\/canvas-workstation\/AgentTemplateCarousel"/);
  assert.match(playground, /<AgentTemplateCarousel templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\}/);
  // 套模板走裁剪：注入与铺画布都用 cropTemplate 后的模板（全选 = 原对象零开销）。
  assert.match(playground, /const cropped = cropTemplate\(template, selectedIndices\)/);
  // 2026-08-26 Bug3：同 workflow 重点 = 替换不是叠加 —— replaceWorkflowNodes
  // 先删同 workflow_id 旧节点及连线再铺新的（旧断言锁的 addNodes 追加语义已退场）。
  assert.match(playground, /templateToCanvasLayout\(cropped\)/);
  assert.match(playground, /replaceWorkflowNodes\(cropped\.id, layout\.nodes, layout\.connections\)/);
  assert.doesNotMatch(playground, /applyTemplateToCanvas\(canvasHostRef/);
});

test("carousel stage keeps the atc-tour-locking short-circuit on wheel and scroll", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  assert.equal((source.match(/classList\.contains\("atc-tour-locking"\)/g) ?? []).length, 2);
  assert.match(read("src/components/canvas-workstation/agent-template-carousel.css"), /atc-tour-locking/);
});

test("playground resets template-gallery dismissal on a new agent session and restores canvas snapshots", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  const hook = read("src/hooks/use-canvas-chat.ts");

  // Bug1a：新 session id 才复位 dismissed；ref 锚住上一个非空 id，
  // 卸载-重挂的 null 中间态与同会话 resume 都不能误判成新对话。
  assert.match(playground, /prevAgentSessionRef\.current !== nextSessionId|nextSessionId !== prevAgentSessionRef\.current/);
  assert.match(playground, /setAgentTemplateDismissed\(false\)/);
  assert.match(playground, /onSessionChange=\{handleAgentSessionChange\}/);
  // Bug1b：每个新 sid 拉一次快照；nodes>0 且画布仍空才回填。
  assert.match(playground, /fetchAgentCanvasSnapshot\(sid\)/);
  assert.match(playground, /host\.restoreAgentSnapshot\(snapshot\)/);
  assert.match(playground, /host\.nodes\.length > 0 \|\| host\.plans\.length > 0/);
  // hook 端：回填走 fromCanvasProject 校验，空快照拒绝落地，不进撤销栈。
  assert.match(hook, /const restoreAgentSnapshot = useCallback/);
  assert.match(hook, /fromCanvasProject\(snapshot\)/);
  assert.match(hook, /restored\.nodes\.length === 0\) return false/);
});

test("template data carries accent gradient and glow for the poster card", () => {
  for (const template of AGENT_TEMPLATES) {
    assert.match(template.accent, /^from-\[#/, `${template.id} accent gradient class`);
    assert.match(template.accent, /via-\[#/);
    assert.match(template.accent, /to-\[#/);
    assert.match(template.glow, /^#[0-9A-Fa-f]{6}$/, `${template.id} glow hex`);
  }
});
