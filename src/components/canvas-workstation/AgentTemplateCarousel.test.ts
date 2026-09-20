import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEMPLATES, AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 2026-09-20 逐模板拆檔後：模板資料散在同目錄多檔，讀整目錄當一份來源。 */
function readDirSources(relDir: string) {
  const abs = join(process.cwd(), relDir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(abs, f), "utf8"))
    .join("\n");
}

/**
 * AgentTemplateCarousel 是 CaseShowcase.tsx 的逐行複製（2026-08-25 用戶裁定：
 * 複用 = 整複製改文字，禁止造輪子）。測試鎖死兩件事：
 * ① 與首頁的交互能力逐項等價（scroll drive / detent /
 *    commitSteps / 彈簧 / 鍵盤 / 圓點 / 箭頭 / CasePromptReveal / 層棧）；
 *    （wheel 被動性除外：09-12 起本元件刻意 passive:true，見下方錨點註解。）
 * ② 模板化改動（數據源 / 卡面文字 / 正面卡啟動）接線正確。
 */

test("carousel is a verbatim copy of CaseShowcase interaction machinery", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 觸控板兩指橫掃：2026-09-12 性能審計落地（09-11 OOM note）——本元件 wheel
  // 改掛 { passive: true } 並移除 preventDefault（非 passive wheel 阻塞合成器
  // 滾動），與 CaseShowcase 的 passive:false 是**刻意分歧**，橫向漂移的 CSS
  // 兜底（overscroll-behavior-x）在共用樣式檔，另片處理。deltaX 占優守衛保留。
  assert.match(source, /addEventListener\("wheel", onWheel, \{ passive: true \}\)/);
  assert.match(source, /Math\.abs\(event\.deltaX\) <= Math\.abs\(event\.deltaY\)/);

  // 滾動驅動 + IntersectionObserver 只在段內累計。
  assert.match(source, /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(source, /IntersectionObserver/);

  // 磁力與落格：detent/undetent/commitSteps 三件套 + 三角度 refs。
  assert.match(source, /detent\(rawRef\.current, STEP\)/);
  assert.match(source, /undetent\(angleRef\.current, STEP\)/);
  assert.match(source, /commitSteps\(travel, flickSteps\)/);

  // 二階彈簧雙檔位（跟隨/落格）+ dt 積分。
  assert.match(source, /SPRING_TRACK/);
  assert.match(source, /SPRING_SETTLE/);
  assert.match(source, /MAX_DT/);

  // 鍵盤導航 + 圓點 + 箭頭。
  assert.match(source, /"ArrowRight"/);
  assert.match(source, /"ArrowLeft"/);
  assert.match(source, /case-dot/);
  assert.match(source, /case-arrow/);

  // 材質層棧：光照四件套的消費層一個不少。
  assert.match(source, /<div className="case-edge" aria-hidden="true" \/>/);
  assert.match(source, /<div className="case-surface" aria-hidden="true">/);
  assert.match(source, /<div className="case-sheen" \/>/);
  assert.match(source, /<div className="case-rim case-rim-l" \/>/);
  assert.match(source, /<div className="case-rim case-rim-r" \/>/);

  // 共享 CSS（禁止另起爐灶）。
  assert.match(source, /import "\.\.\/case-showcase\.css"/);
  // 共享物理庫。
  assert.match(source, /from "@\/lib\/carousel-detent"/);
});

test("carousel renders template cards with poster watermark and circular step selector", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const data = readDirSources("src/lib/agent-templates");

  for (const template of AGENT_TEMPLATES) {
    assert.ok(data.includes(template.name), `模板数据应包含卡片名「${template.name}」`);
  }
  // 卡面：領域漸變海報 + 大字水印 + 圓形環節選擇器（2026-08-26 替換黑話步驟鏈）。
  assert.match(source, /bg-gradient-to-br", item\.accent/);
  assert.match(source, /atc-watermark/);
  assert.match(source, /AGENT_TEMPLATE_DOMAIN_LABELS\[item\.domain\]/);
  // 選擇器：圓內 = shortName（純名字），圓 = button + aria-pressed，默認全選。
  assert.match(source, /atc-step-selector/);
  assert.match(source, /step\.shortName/);
  assert.match(source, /aria-pressed=\{isSelected\}/);
  assert.match(source, /data-step-index/);
  // 拖拽多選（2026-08-27 恒正向語義）：全局 window 監聽（不依賴 capture/冒泡，
  // 玻璃層/輪播殼截走指針也不受影響）+ elementFromPoint 命中圓 +
  // chosen 集合防重複觸發；單擊（!pressMoved）在 pointerup 補切；拖動 = 正集重置為掃過路徑。
  // 触控板修复：window 监听必须挂 capture 阶段（第三参 true）——
  // 冒泡会被轮播壳 stage 的 pointermove 截断，扫选收不到 move。
  assert.match(source, /window\.addEventListener\("pointermove", handleWindowMove, true\)/);
  assert.match(source, /window\.addEventListener\("pointerup", handleWindowUp, true\)/);
  assert.match(source, /window\.addEventListener\("pointercancel", handleWindowUp, true\)/);
  assert.match(source, /removeEventListener\("pointermove", handleWindowMove, true\)/);
  // 原生 drag 防护（触控板按住拖动触发 dragstart → pointercancel）。
  assert.match(source, /onDragStart=\{\(event\) => event\.preventDefault\(\)\}/);
  // 按压即时反馈。
  assert.match(source, /active:brightness-150/);
  assert.match(source, /elementFromPoint/);
  assert.match(source, /gesture\.chosen\.has\(index\)/);
  // 恒正向选取：拖出來的集合整集提交（選擇部分為正），空白單擊恢復全選。
  assert.match(source, /onSelectOnly\(\[\.\.\.gesture\.chosen\]\)/);
  assert.match(source, /onSelectOnly\(Array\.from\(\{ length: steps\.length \}, \(_, i\) => i\)\)/);
  // 2026-08-27 舊「起點定方向反选锁」語義已退場：不再存在 deselect 分支。
  assert.doesNotMatch(source, /"deselect" : "select"/);
  assert.match(source, /onPointerDown=\{handlePointerDown\}/);
  // 鼠标/触摸 click 是兼容补发（detail!==0 吞掉），键盘 click（detail===0）照常切换。
  assert.match(source, /detail !== 0/);
  // 玻璃 Dock + 白玻璃站（2026-08-26 第八轮，视觉模型三审 7.5→终修）：
  // Dock 全宽等分、蓝色退场、贯穿线拔掉（透明度梯度表达流程）、短名 2-3 字。
  assert.match(source, /backdrop-blur-md/);
  assert.match(source, /w-full items-center rounded-full border border-white\/\[0\.12\] bg-black\/\[0\.35\]/);
  assert.doesNotMatch(source, /h-px min-w-\[4px\]/); // 贯穿线已拔
  assert.match(source, /font-semibold text-white/);
  // R9-6 對比度提升：未選中站 45%→80%（WCAG ≥4.5:1），錨點同步新值。
  assert.match(source, /font-medium text-white\/80/);
  assert.match(source, /text-shadow:0_1px_2px_rgba\(0,0,0,0\.5\)/);
  assert.doesNotMatch(source, /bg-white\/\[0\.15\]/); // 小药丸底已删
  // 舊黑話步驟鏈已退場。
  assert.doesNotMatch(source, /atc-flow/);
  assert.doesNotMatch(source, /join\(" → "\)/);
  // 8 張卡全部進入輪播數據源（props 直傳）。
  assert.ok(AGENT_TEMPLATES.length >= 8, `内置模板应不少于 8 张，实际 ${AGENT_TEMPLATES.length}`);
});

test("front card click asks for full-template confirmation; dock submit runs the picked steps", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");

  // 正面卡：先弹「完整模板」确认（2026-08-29 旧入口保留 + 确认步）；側卡：轉到正面；movedRef 擋拖拽誤觸。
  assert.match(source, /setConfirmTemplate\(cases\[front\]\)/);
  assert.match(source, /if \(movedRef\.current\) return;/);
  assert.match(source, /goTo\(index\)/);
  // 确认弹窗：文案逐字 + 确认 = 全量 indices（cropTemplate 全量短路零开销）。
  assert.match(source, /是否使用完整模板开始创作？/);
  assert.match(source, /onUseTemplate\(\s*confirmTemplate,\s*Array\.from\(/);
  // Dock 送出 = 只跑勾选的环节，空集护栏（cropTemplate 对空数组也返回原模板）。
  assert.match(source, /if \(picked\.length > 0\) onUseTemplate\(item, picked\)/);
});

test("selection map: missing key = none picked (default), empty set collapses to key-deleted default", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  // 2026-08-29 语义改版：key 缺失 = 一个都没选（送出钮不可用态）；全选存满量数组，
  // cropTemplate 全量短路返回原对象（零开销）。空集删 key 归默认态，两条路径一致。
  assert.match(source, /if \(sorted\.length === 0\) \{/);
  assert.match(source, /delete rest\[templateId\]/);
  assert.match(source, /new Set\(prev\[templateId\] \?\? \[\]\)/);
  // 送出可用性 = 至少选了一个；全选态由勾选框表达（aria-checked），不再有「undefined = 全选」。
  assert.match(source, /const canSubmit = selectedCount > 0;/);
  assert.match(source, /aria-checked=\{allSelected\}/);
  assert.doesNotMatch(source, /sorted\.length === count/); // 旧「全选删 key」语义已退场
});

test("2026-08-29 dock gains select-all checkbox, submit arrow with disabled→tour fallback, full-template dialog", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const tour = read("src/lib/atc-tour-content.ts");

  // 左侧全选勾选框（替换六点把手）：role=checkbox + 勾上 = 全量正集 + 清空回默认态。
  assert.match(source, /role="checkbox"/);
  assert.match(source, /aria-label="全部执行"/);
  assert.match(source, /onSelectOnly\(allSelected \? \[\] : Array\.from\(\{ length: steps\.length \}, \(_, i\) => i\)\)/);
  // 右侧送出钮：向右箭头、预设不可用（aria-disabled），不可用态点击 = 假鼠标引导一次。
  assert.match(source, /<ArrowRight className="h-3\.5 w-3\.5"/);
  assert.match(source, /aria-disabled=\{!canSubmit\}/);
  assert.match(source, /if \(!canSubmit\) \{\s*forceStartAtcTour\(\);/);
  assert.match(source, /import \{ forceStartAtcTour, maybeStartAtcTour \} from "@\/lib\/atc-tour-content"/);
  // 控件排除在步骤拖选手势之外（pointerdown 命中 data-atc-control 只拦 stage 不起手势）。
  assert.match(source, /closest\("\[data-atc-control\]"\)/);
  // 确认弹窗壳 = RerunDialog 轮子逐行复制（lg-sheet + portal + Esc），交互壳不另造。
  assert.match(source, /lg-sheet w-full max-w-sm rounded-ios-2xl p-5/);
  assert.match(source, /createPortal\(/);
  // 引导：强制播报入口（无视「看过」标记，单飞闸保留）。
  assert.match(tour, /export function forceStartAtcTour\(\)/);
  assert.match(tour, /!force && window\.localStorage\.getItem\(ATC_TOUR_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /GripVertical/); // 六点把手退场
});

test("playground wires the carousel in place of the old gallery", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  assert.match(playground, /import \{ AgentTemplateCarousel \} from "@\/components\/canvas-workstation\/AgentTemplateCarousel"/);
  assert.match(playground, /<AgentTemplateCarousel templates=\{AGENT_TEMPLATES\} onUseTemplate=\{handleUseAgentTemplate\}/);
  // 套模板走裁剪：注入與鋪畫布都用 cropTemplate 後的模板（全選 = 原對象零開銷）。
  assert.match(playground, /const cropped = cropTemplate\(template, selectedIndices\)/);
  // 2026-08-26 Bug3：同 workflow 重點 = 替換不是疊加 —— replaceWorkflowNodes
  // 先刪同 workflow_id 舊節點及連線再鋪新的（舊斷言鎖的 addNodes 追加語義已退場）。
  assert.match(playground, /templateToCanvasLayout\(cropped\)/);
  assert.match(playground, /replaceWorkflowNodes\(cropped\.id, layout\.nodes, layout\.connections\)/);
  assert.doesNotMatch(playground, /applyTemplateToCanvas\(canvasHostRef/);
});

test("step selector guides dragging and plays a one-time driver.js tour (2026-08-26 Bug2)", () => {
  const source = read("src/components/canvas-workstation/AgentTemplateCarousel.tsx");
  const tour = read("src/lib/atc-tour-content.ts");

  // 引導文案 + 拖拽期間實時計數徽章（鬆手即消失，單擊不閃）。
  assert.match(source, /勾选 = 全部执行 · 单击环节开\/关 · 按住拖过 = 只跑扫过的/);
  assert.match(source, /松开完成/);
  assert.match(source, /dragCount !== null/);
  assert.match(source, /setDragCount\(null\); \/\/ 徽章只在拖拽手勢存活期間顯示|setDragCount\(null\)/);
  assert.match(source, /gesture\.chosen/);
  // 未選中站也有懸停響應（R9-6 對比度提升後 80%→95%，錨點同步新值）。
  assert.match(source, /font-medium text-white\/80 hover:text-white\/95/);

  // 教學基建同專業模式：driver.js 動態載入、storage key 看過不復播、三步內容、
  // selector 掛載觸發 + 模組級單飛閘。
  assert.match(tour, /ATC_TOUR_STORAGE_KEY = "atc-tour-v1"/);
  assert.match(tour, /import\("driver\.js\/dist\/driver\.css"\)/);
  assert.match(tour, /流水线环节/);
  assert.match(tour, /部分选取：按住拖过/);
  assert.match(tour, /勾一下左边的勾选框/);
  assert.match(tour, /kind: "down"/);
  assert.match(tour, /kind: "up"/);
  assert.match(tour, /开始创作/);
  assert.match(tour, /atcTourStarted = true/);
  assert.match(source, /maybeStartAtcTour/);

  // 2026-08-27 轨迹瞬移返工：① 步骤编排快照化（一次性解析站0/1/2 DOM 引用，
  // el 闭包只返回快照，不再每步重新 query frontSelector——卡一转 data-front
  // 换卡，目标就漂到另一张卡上）；② 演示期间冻结轮播（atc-tour-locking 挂在
  // .agent-template-carousel，stage 的 wheel/scroll 转卡入口短路，onDone 与
  // onDestroyed 双路解锁）；③ down 落点校验（isConnected + 中心偏差 <40px）
  // + abortOnMissingTarget 整场干净收尾，目标丢失不硬演。
  assert.match(tour, /const snap = \[0, 1, 2\]\.map/);
  assert.match(tour, /drift < 40 \? el : null/);
  assert.match(tour, /abortOnMissingTarget: true/);
  assert.match(tour, /classList\.add\("atc-tour-locking"\)/);
  assert.match(tour, /classList\.remove\("atc-tour-locking"\)/);
  assert.doesNotMatch(tour, /demoStations/); // 每步重新解析的旧病灶必须退场
  assert.match(source, /classList\.contains\("atc-tour-locking"\)/);
  // wheel 与 scroll 两个转卡入口都必须有锁判断（各一处，锁在 handler 入口）。
  assert.equal((source.match(/classList\.contains\("atc-tour-locking"\)/g) ?? []).length, 2);
  assert.match(read("src/components/canvas-workstation/agent-template-carousel.css"), /atc-tour-locking/);
  // 引擎只加了可选 abortOnMissingTarget（默认 false 不影响 LoRA 引导），别无改动。
  const engine = read("src/components/pro-workstation/workstation-cursor-demo.ts");
  assert.match(engine, /abortOnMissingTarget\?: boolean/);
  assert.match(engine, /if \(!options\.abortOnMissingTarget\) \{/);
});

test("playground resets template-gallery dismissal on a new agent session and restores canvas snapshots", () => {
  const playground = read("src/components/ImagePlayground.tsx");
  const hook = read("src/hooks/use-canvas-chat.ts");

  // Bug1a：新 session id 才復位 dismissed；ref 錨住上一個非空 id，
  // 卸載-重掛的 null 中間態與同會話 resume 都不能誤判成新對話。
  assert.match(playground, /prevAgentSessionRef\.current !== nextSessionId|nextSessionId !== prevAgentSessionRef\.current/);
  assert.match(playground, /setAgentTemplateDismissed\(false\)/);
  assert.match(playground, /onSessionChange=\{handleAgentSessionChange\}/);
  // Bug1b：每個新 sid 拉一次快照；nodes>0 且畫布仍空才回填。
  assert.match(playground, /fetchAgentCanvasSnapshot\(sid\)/);
  assert.match(playground, /host\.restoreAgentSnapshot\(snapshot\)/);
  assert.match(playground, /host\.nodes\.length > 0 \|\| host\.plans\.length > 0/);
  // hook 端：回填走 fromCanvasProject 校驗，空快照拒絕落地，不進撤銷棧。
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
