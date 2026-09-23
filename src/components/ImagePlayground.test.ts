import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

// Task 10：畫布工作站的殼（inline style / overlay / 面板殼 / 拖寬手柄）與
// 面板兩態 state 分別搬到 canvas-workstation/CanvasChatWorkstation.tsx 與
// canvas-workstation/use-chat-panel.ts——被搬走的宣告按「舊檔＋新檔」拼接
// 讀取，語義不放寬。
function readWorkstationSources() {
  return (
    read("src/components/ImagePlayground.tsx") +
    "\n" +
    read("src/components/canvas-workstation/CanvasChatWorkstation.tsx") +
    "\n" +
    read("src/components/canvas-workstation/use-chat-panel.ts")
  );
}

test("image playground controls normal, fallback, and failed progress timing", () => {
  const source = read("src/components/ImagePlayground.tsx");
  assert.match(source, /NORMAL_PROGRESS_DURATION_MS/);
  assert.match(source, /FALLBACK_PROGRESS_DURATION_MS/);
  assert.match(source, /progressDurationMs/);
  assert.match(source, /endpointLabel === "fallback"/);
  assert.match(source, /failedProviders\.length > 0/);
  assert.match(source, /progressStartedAt/);
  assert.match(source, /showProgress/);
  assert.match(source, /revealGeneratedResult = !showProgress/);
  assert.doesNotMatch(source, /<GenerationProgressBar|QuietRevealTheater|theaterStartedAt|finalImageSrc/);
});

test("image playground reveals a completed image without waiting for the estimated progress duration", () => {
  const source = read("src/components/ImagePlayground.tsx");

  assert.match(source, /const hasGeneratedImage = images\.some/);
  assert.match(source, /failedProviders\.length > 0 \|\| hasGeneratedImage/);
});

test("professional workstation entry is removed; AI workstation is the only surface (2026-08-27)", () => {
  const source = read("src/components/ImagePlayground.tsx");

  // 專業工作站入口移除：無殘留分支/掛載/動態 import（AI 工作站已吸收其機制）。
  assert.doesNotMatch(source, /showProfessionalMode|hasOpenedProfessionalMode|openProfessionalMode/);
  assert.doesNotMatch(source, /pro-app-shell|InvokeInspiredWorkstation|ProfessionalRunConfig/);
  // 服務端歷史不再按專業模式開關，常開。
  assert.doesNotMatch(source, /enableServerHistory/);
  // agent 模式即畫布工作站，不再有「!showProfessionalMode」護欄。
  assert.match(source, /inCanvasWorkstation = displayMode === "agent"/);
});

test("professional workstation stylesheet stays out of the first-paint bundle", () => {
  const playground = read("src/components/ImagePlayground.tsx");

  // ~37KB of pro-mode-only CSS. 專業工作站入口移除後，playground 對它零引用。
  assert.doesNotMatch(playground, /pro-workstation/);
  assert.doesNotMatch(playground, /import "\.\/pro-workstation\/workstation\.css"/);
});

test("the result column is the canvas alone, with no duplicated chrome", () => {
  const source = readWorkstationSources();

  // The model picker moved onto the left rail, so the right column renders
  // ImageDisplay directly ??no wrapper card, identity header, or second status
  // badge on top of the one ImageDisplay already draws.
  // 2026-08-16 暴君裁定「擠」：畫布模式 = 全場畫布工作站（canvas-ws-overlay），
  // 不再有 compact 嵌右欄；聊天卡變左側固定面板（canvas-chat-panel）。
  // 2026-08-21：overlay 向右 dock（right-0 + --ce-dock-left），面板不再蓋住畫布左緣節點。
  // 2026-08-25 canvas 常駐化：agent 模式右側恆為 canvas（resultMode 由 displayMode
  // 派生，不再有「助理左邊、圖片右邊」的中間態），CanvasEmbed 的關閉鈕退場。
  assert.match(source, /const resultMode: "image" \| "canvas" = displayMode === "agent" \? "canvas" : "image"/);
  assert.match(source, /inCanvasWorkstation = displayMode === "agent"/);
  assert.match(source, /canvas-ws-overlay/);
  assert.match(source, /\{overlayContent \?\? <CanvasEmbed canvas=\{canvasHost\} expanded \/>\}/);
  assert.match(source, /<ImageDisplay/);
  assert.match(source, /chatPanelState === "expanded" \? \{ width: chatPanelWidth \}/);
  assert.doesNotMatch(source, /ModelSelect/);
});

test("canvas workstation is a fullscreen overlay with expandable chat panel", () => {
  const source = readWorkstationSources();
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");

  // 工作站：畫布吃滿全場，聊天面板 expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  assert.match(source, /const \[chatPanelState, setChatPanelState\] = useState<"expanded" \| "rail">\("expanded"\)/);
  assert.match(source, /const \[chatPanelWidth, setChatPanelWidth\] = useState\(420\)/);
  assert.match(source, /canvas-chat-resize/);
  assert.match(source, /chatPanelState === "rail" && "canvas-chat-rail"/);
  // 畫布 dock 偏移（面板寬 + 12px 間隙），overlay 自身 left 用它避讓面板。
  assert.match(source, /--ce-dock-left/);
  assert.match(source, /left: "calc\(0\.75rem \+ var\(--ce-dock-left, 0px\)\)"/);
  assert.match(embed, /expanded = false/);
  assert.match(nodeView, /enterDelay/);
  assert.match(nodeView, /transitionDelay/);
});

test("the model picker is wired into the left prompt panel", () => {
  const source = read("src/components/ImagePlayground.tsx");
  // Task 9：<ModelPicker> JSX 抽到 GenerateControls —— 拼接讀取，斷言語義不變。
  const prompt = read("src/components/PromptInput.tsx") + "\n" + read("src/components/prompt-input/GenerateControls.tsx");

  assert.match(source, /models=\{PROVIDERS\.image_tinchak\.models\}/);
  assert.match(source, /modelId=\{selectedModels\.image_tinchak\}/);
  assert.match(source, /onModelChange=\{userSetModel\}/);
  assert.match(source, /generateAudio=\{generateAudio\}/);
  assert.match(source, /onGenerateAudioChange=\{setGenerateAudio\}/);
  assert.match(prompt, /<ModelPicker[\s\S]{0,180}models=\{models\}[\s\S]{0,180}value=\{modelId\}/);
});

test("public image generation never launches the browser-only Adobe adapter", () => {
  const source = read("src/components/ImagePlayground.tsx");

  assert.doesNotMatch(source, /ADOBE_FIREFLY_MODEL_ID|generateAdobeFireflyImage|externalGenerator/);
  assert.match(source, /if \(!LOCAL_TEST_MODE && \(!isLoggedIn \|\| !user\)\)/);
});

test("professional mode is a toggle inside the prompt card, not a bare row", () => {
  const source = read("src/components/ImagePlayground.tsx");
  // Task 9：专业控制 toggle 抽到 ActionRow —— 拼接讀取，斷言語義不變。
  const prompt = read("src/components/PromptInput.tsx") + "\n" + read("src/components/prompt-input/ActionRow.tsx");

  // It used to occupy a whole right-aligned row above the grid.
  assert.doesNotMatch(source, /mb-4 flex justify-end/);
  // 2026-08-27 專業工作站入口移除：toggle 與 props 鏈全數退場。
  assert.doesNotMatch(source, /onToggleProfessionalMode|isProfessionalMode|showProfessionalMode/);
  assert.doesNotMatch(prompt, /onToggleProfessionalMode|isProfessionalMode|专业控制/);
});

test("professional mode keeps its draft mounted after returning home", () => {
  const source = read("src/components/ImagePlayground.tsx");

  // 2026-08-27 專業工作站入口移除：草稿保留掛載機制（hasOpenedProfessionalMode）
  // 隨入口一併退場；playground 對專業模式相關狀態零殘留。
  assert.doesNotMatch(source, /hasOpenedProfessionalMode/);
  assert.doesNotMatch(source, /showProfessionalMode/);
  assert.doesNotMatch(source, /if \(showProfessionalMode\) \{\s*return/);
});

test("canvas workstation chat panel keeps the composer inside the panel", () => {
  // style 塊（面板高度鏈加固）隨面板殼搬進 CanvasChatWorkstation，讀取路徑跟著走。
  const source = read("src/components/canvas-workstation/CanvasChatWorkstation.tsx");

  // 面板是 fixed + overflow:hidden 的 flex 容器：内容超高时若高度链没把
  // transcript 的滚动接住，输入区会被推出面板外（用户截图：底部只见
  // 被裁掉的「思考过程」最后一行、输入框整体不可见）。加固规则：
  //  - 面板给 min-height:0 / max-height 兜底（bottom 已定界，双保险）
  //  - section.lg-card 拿 flex:0 1 auto（2026-09-24 用戶版面方案：卡高隨內容、
  //    面板內垂直置中，取代舊「fill 拉滿全高」裁定）再顯式 min-height:0 +
  //    overflow:hidden——內容超高時由 flex-shrink 封頂、內部滾動接手，
  //    不许 agent 面把卡片按内容撑高到溢出面板
  //  - 非 lg-card 兄弟（如 agentBaseline 撤回条）shrink-0，不抢高度
  //  - composer 锚点 shrink-0，永不被 flex 压没
  assert.match(source, /\.canvas-chat-panel \{[^}]*min-height: 0;[^}]*max-height: calc\(100dvh - 1\.5rem[^}]*\}/);
  assert.match(source, /\.canvas-chat-scroll-fill > section\.lg-card \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  assert.match(source, /\.canvas-chat-scroll-fill > :not\(section\.lg-card\) \{ flex-shrink: 0; \}/);
  assert.match(source, /\.agent-composer-anchor \{ flex-shrink: 0; \}/);
});
