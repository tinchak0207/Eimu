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
  // 2026-09-24 首秒零回縮：面板寬不再由 inline style 寫 JS 值（舊斷言釘的
  // { width: chatPanelWidth } ＝ 420→40vw 回縮元凶），改讀 CSS 單一真相源。
  assert.match(source, /width: var\(--ws-panel-w\)/);
  assert.doesNotMatch(source, /width: chatPanelWidth/);
  assert.doesNotMatch(source, /ModelSelect/);
});

test("canvas workstation is a fullscreen overlay with expandable chat panel", () => {
  const source = readWorkstationSources();
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");

  // 工作站：畫布吃滿全場，聊天面板 expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  assert.match(source, /const \[chatPanelState, setChatPanelState\] = useState<"expanded" \| "rail">\("expanded"\)/);
  // 2026-09-24 首秒零回縮：寬度態 number|null——null＝CSS 默認（clamp）當終態，
  // 舊「初始值 420 + mount effect 改 40vw」回縮鏈已拆。同日追殺回填跳變：非
  // null 分支＝初始態同步讀校驗過的 v2 存值（與 layout pre-paint 腳本同一值），
  // 不再留 null 等 useLayoutEffect 回填——那正是「首幀 clamp→水合後縮回」的時序。
  assert.match(source, /const \[chatPanelWidth, setChatPanelWidth\] = useState<number \| null>\(\(\) => \{/);
  assert.doesNotMatch(source, /useState<number \| null>\(null\)/);
  assert.match(source, /canvas-chat-resize/);
  assert.match(source, /chatPanelState === "rail" && "canvas-chat-rail"/);
  // 畫布 dock 偏移＝--ws-panel-w 終態＋12px 間隙（不再由 JS 算 chatPanelWidth+12），
  // overlay 自身 left 用它避讓面板；起點是導覽列實測左緣（--site-shell-left，
  // 0924 排版對齊刀），fallback 0.75rem。
  assert.match(source, /--ce-dock-left/);
  assert.match(source, /"--ce-dock-left": chatPanelState === "rail" \? "64px" : "calc\(var\(--ws-panel-w\) \+ 12px\)"/);
  assert.match(source, /left: "calc\(var\(--site-shell-left, 0\.75rem\) \+ var\(--ce-dock-left, 0px\)\)"/);
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
  //  - section.lg-card 拿 flex:1 1 0%（2026-09-24 暴君糾正：聊天態吃滿面板全高；
  //    前一刀把聊天態高度也壓成 fit-content 屬劣化）再顯式 min-height:0 +
  //    overflow:hidden——內容超高時由內部滾動接手，不许 agent 面把卡片按内容
  //    撑高到溢出面板；2026-09-24 暴君終裁：聊天態與空態一律吃滿全高，舊
  //    :has() 空態分流作廢，空態內容置中改由 transcript 內部 justify-center 負責
  //  - 非 lg-card 兄弟（如 agentBaseline 撤回条）shrink-0，不抢高度
  //  - composer 锚点 shrink-0，永不被 flex 压没
  //  - 面板吃滿天花板（2026-09-24 暴君裁定）：top 固定 0.75rem、max-height 只扣
  //    上下 0.75rem 留白＋底部安全區，不再從 --site-header-offset 起算；
  //    navbar 改經 --ws-navbar-inset 右退讓位（跨檔契約見下）。
  //    FAB 態 navbar 全寬，.canvas-chat-rail 的 top 仍從 --site-header-offset
  //    起算不被擋。
  assert.match(source, /\.canvas-chat-panel \{[^}]*top: 0\.75rem;[^}]*min-height: 0;[^}]*max-height: calc\(100dvh - 1\.5rem - env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(source, /\.canvas-chat-rail \{[^}]*top: calc\(var\(--site-header-offset, 4\.25rem\) \+ 0\.75rem\)/);
  // 跨檔契約：navbar 右退變數兩端都必須在場——工作站 useEffect 寫入、
  // Navbar 的 <nav> 以 margin-left/寬度 calc 消費。缺任何一端＝面板吃頂後
  // header 被蓋住（寫入端失聯）或膠囊不让位（消費端失聯）。
  assert.match(source, /--ws-navbar-inset/);
  assert.match(read("src/components/Navbar.tsx"), /--ws-navbar-inset/);
  // 全高契約：lg-card 一律 flex:1 1 0%（2026-09-24 暴君終裁：聊天態與空態同標吃滿全高）
  assert.match(source, /\.canvas-chat-scroll-fill > section\.lg-card \{[^}]*flex: 1 1 0%;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  // 拔除實錘：舊 :has() 空態分流與標記類必須兩檔全面退場（零命中），否則空態縮卡病灶回魂。
  assert.doesNotMatch(source, /agent-empty-state/);
  assert.doesNotMatch(read("src/components/agent-chat/AgentChatPanel.tsx"), /agent-empty-state/);
  assert.match(source, /\.canvas-chat-scroll-fill > :not\(section\.lg-card\) \{ flex-shrink: 0; \}/);
  assert.match(source, /\.agent-composer-anchor \{ flex-shrink: 0; \}/);
});

// 暴君裁定 2026-09-24：「reload 和初始載入時有一堆明顯回縮的過程，破壞首秒體驗」。
// 根治架構＝單一 CSS 變數真源（--ws-panel-w：默認 clamp 由純 CSS 承擔，SSR 首幀
// 即新用戶終態）＋ settled 閘（所有 width/left transition 與入場 @keyframes 只在
// 首幀穩定後開啟，載入零動畫直出終態）。
test("first paint is the final state: --ws-panel-w single source + settled gate (2026-09-24)", () => {
  const ws = read("src/components/canvas-workstation/CanvasChatWorkstation.tsx");
  const panel = read("src/components/canvas-workstation/use-chat-panel.ts");
  const navbar = read("src/components/Navbar.tsx");

  // ① 單一真相源：CSS 默認＝新用戶終態（clamp 360–720 of 40vw），宣告在
  //    工作站 <style> 的 :root——與 SSR 首幀同梱，零 JS。
  assert.match(ws, /--ws-panel-w: clamp\(360px, 40vw, 720px\)/);
  // ② JS 寫入端只在顯式值（存值/拖寬）時存在，且全部 useLayoutEffect（paint 前）：
  //    顯式→setProperty px；null→removeProperty 讓位 CSS 默認。
  assert.match(panel, /useLayoutEffect\(\(\) => \{/);
  assert.match(panel, /documentElement\.style\.setProperty\("--ws-panel-w"/);
  assert.match(panel, /documentElement\.style\.removeProperty\("--ws-panel-w"\)/);
  // 默認寬度不再由 JS 讀 window 发明（420 初始值與視口 40% 換算都是回縮元凶）。
  assert.doesNotMatch(panel, /innerWidth/);
  // 落盤只收顯式寬：null（默認）不落盤，防「40vw 活語義被釘死成 px」。
  assert.match(panel, /if \(chatPanelWidth === null\) return;/);

  // ③ settled 閘：掛載雙 rAF 後才開。CSS 側——面板 width / overlay left 的
  //    transition 與 backdrop fade、rail fab-in 入場動畫全部只在 .canvas-ws-settled 下。
  assert.match(ws, /setWsSettled\(true\)/);
  assert.match(ws, /\.canvas-chat-panel\.canvas-ws-settled \{[^}]*transition: width/);
  assert.match(ws, /\.canvas-ws-overlay\.canvas-ws-settled \{[^}]*transition: left/);
  assert.match(ws, /\.canvas-ws-backdrop\.canvas-ws-settled \{[^}]*animation: canvas-ws-fade/);
  assert.match(ws, /\.canvas-chat-rail\.canvas-ws-settled:not\(\.canvas-ws-was-rail\) \{[^}]*animation: canvas-ws-fab-in/);
  // navbar 退縮過度同樣進閘（規則從 nav 的 tailwind 類別搬進工作站 <style>）。
  assert.match(ws, /html\[data-ws-settled\] #global-navbar nav \{[^}]*transition: margin-left/);
  assert.match(ws, /dataset\.wsSettled = "1"/);

  // ④ Navbar 跨檔契約：退縮分支只屬首頁（pathname === "/"），非首頁恆 0——
  //    否則 reload /history 等頁會因 fallback 無端退縮。fallback 指面板寬終態。
  assert.match(navbar, /usePathname/);
  assert.match(navbar, /pathname === "\/"/);
  assert.match(navbar, /ml-\[var\(--ws-navbar-inset,calc\(var\(--ws-panel-w,420px\)_\+_12px\)\)\]/);
  assert.match(navbar, /w-\[calc\(100%_-_var\(--ws-navbar-inset,calc\(var\(--ws-panel-w,420px\)_\+_12px\)\)\)\]/);
  assert.match(navbar, /max-md:ml-0 max-md:w-full/);
  // 首幀即退縮＝舊「0px 起步 + JS 動畫退縮」契约作废；nav 上的常開 transition
  // 類別必須全面退場（殘留＝回縮動畫回魂）。
  assert.doesNotMatch(navbar, /--ws-navbar-inset,0px/);
  assert.doesNotMatch(navbar, /duration-\[320ms\]/);
  assert.doesNotMatch(navbar, /transition-\[margin-left/);

  // ⑤ 工作站不再把像素回寫 --ws-navbar-inset（拖寬即時性改由 CSS 變數鏈承擔）。
  assert.doesNotMatch(ws, /setProperty\("--ws-navbar-inset", `\$\{chatPanelWidth\}/);
});

// 暴君回報 2026-09-24：「Ctrl+Shift+R 時聊天框先佔幾乎半屏、秒縮回 30% 以下，
// 非常恐怖」。根因＝冷載入首幀由 HTML+CSS 繪出 clamp 默認（40vw≈半屏），JS
// chunk 下載完才在水合 useLayoutEffect 裡讀到舊 localStorage 垃圾值（v1 key：
// useState(420) 時代 mount effect 無條件落盤的 420）並覆寫變數——paint 之後的
// 第二次變更＝跳變。修法兩半缺一不可：①存值升代 v2，舊 key 大赦不讀＋清盤，
// 只認「用戶真的拖過」的值；②layout.tsx 以 HTML 解析期同步內聯 <script>
// （非 next/script beforeInteractive——實裝 push 進 self.__next_s 由
// app-bootstrap 跑，与水合同期，對首幀仍然太晚）在首個 paint 前套用校驗過的
// v2 值，首幀即終態。
test("stored width: legacy values amnestied, v2 applied before first paint (2026-09-24)", () => {
  const panel = read("src/components/canvas-workstation/use-chat-panel.ts");
  const layout = read("src/app/layout.tsx");

  // ① 升代 v2：寫入端與初始態讀取都用新 key，舊 key 只准 removeItem。
  assert.match(panel, /export const CHAT_PANEL_WIDTH_STORAGE_KEY = "canvas-chat-panel-width\.v2";/);
  assert.match(panel, /localStorage\.getItem\(CHAT_PANEL_WIDTH_STORAGE_KEY\)/);
  assert.match(panel, /localStorage\.setItem\(CHAT_PANEL_WIDTH_STORAGE_KEY, String\(chatPanelWidth\)\)/);
  assert.match(panel, /localStorage\.removeItem\(CHAT_PANEL_WIDTH_LEGACY_KEY\)/);
  // 舊 key 不讀（雷：註釋裡出現舊 key 名屬正常，斷言只釘「讀取呼叫」形態）。
  assert.doesNotMatch(panel, /getItem\(\s*CHAT_PANEL_WIDTH_LEGACY_KEY\s*\)/);
  assert.doesNotMatch(panel, /localStorage\.getItem\("canvas-chat-panel-width"\)/);
  assert.doesNotMatch(layout, /localStorage\.getItem\("canvas-chat-panel-width"\)/);
  // 校驗範圍單一表述：v2 值必須是 320–720 整數才落地（下限取拖寬底，非 clamp 底）。
  assert.match(panel, /if \(!Number\.isInteger\(w\) \|\| w < CHAT_PANEL_MIN_WIDTH \|\| w > CHAT_PANEL_MAX_WIDTH\) return null;/);

  // ② 第二跳變源大赦：rail 態 09-05 後 UI 不可達，舊持久值一律不讀。
  assert.doesNotMatch(panel, /localStorage\.getItem\("canvas-chat-panel-state"\)/);

  // ③ pre-paint 同步腳本在場且含校驗（釘 layout 源碼字串；生產 HTML grep 為
  //    外部證據層，同字符串）。範圍常量與 panel 側逐字一致，防兩端驗證漂移。
  assert.match(
    layout,
    /var w=Number\(localStorage\.getItem\("canvas-chat-panel-width\.v2"\)\);if\(Number\.isInteger\(w\)&&w>=320&&w<=720\)\{document\.documentElement\.style\.setProperty\("--ws-panel-w",w\+"px"\);\}/,
  );
  assert.match(panel, /export const CHAT_PANEL_MIN_WIDTH = 320;/);
  assert.match(panel, /export const CHAT_PANEL_MAX_WIDTH = 720;/);
  // 腳本必須是解析期内聯 <script>（dangerouslySetInnerHTML），不得改用
  // next/script 的 beforeInteractive（水合同期執行＝跳變會回魂）。
  // 雷位提示：本斷言只釘 import 形態，layout 註釋談論 next/script 屬正常。
  assert.doesNotMatch(layout, /from\s*"next\/script"/);
});
