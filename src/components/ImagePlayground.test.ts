import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

// Task 10：画布工作站的壳（inline style / overlay / 面板壳 / 拖宽手柄）与
// 面板两态 state 分别搬到 canvas-workstation/CanvasChatWorkstation.tsx 与
// canvas-workstation/use-chat-panel.ts——被搬走的宣告按「旧档＋新档」拼接
// 读取，语义不放宽。
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

  // 专业工作站入口移除：无残留分支/挂载/动态 import（AI 工作站已吸收其机制）。
  assert.doesNotMatch(source, /showProfessionalMode|hasOpenedProfessionalMode|openProfessionalMode/);
  assert.doesNotMatch(source, /pro-app-shell|InvokeInspiredWorkstation|ProfessionalRunConfig/);
  // 服务端历史不再按专业模式开关，常开。
  assert.doesNotMatch(source, /enableServerHistory/);
  // agent 模式即画布工作站，不再有「!showProfessionalMode」护栏。
  assert.match(source, /inCanvasWorkstation = displayMode === "agent"/);
});

test("professional workstation stylesheet stays out of the first-paint bundle", () => {
  const playground = read("src/components/ImagePlayground.tsx");

  // ~37KB of pro-mode-only CSS. 专业工作站入口移除后，playground 对它零引用。
  assert.doesNotMatch(playground, /pro-workstation/);
  assert.doesNotMatch(playground, /import "\.\/pro-workstation\/workstation\.css"/);
});

test("the result column is the canvas alone, with no duplicated chrome", () => {
  const source = readWorkstationSources();

  // The model picker moved onto the left rail, so the right column renders
  // ImageDisplay directly ??no wrapper card, identity header, or second status
  // badge on top of the one ImageDisplay already draws.
  // 2026-08-16 暴君裁定「挤」：画布模式 = 全场画布工作站（canvas-ws-overlay），
  // 不再有 compact 嵌右栏；聊天卡变左侧固定面板（canvas-chat-panel）。
  // 2026-08-21：overlay 向右 dock（right-0 + --ce-dock-left），面板不再盖住画布左缘节点。
  // 2026-08-25 canvas 常驻化：agent 模式右侧恒为 canvas（resultMode 由 displayMode
  // 派生，不再有「助理左边、图片右边」的中间态），CanvasEmbed 的关闭钮退场。
  // 2026-10-01 lint 清理移除了 ImagePlayground 未使用的 resultMode 宣告
  // （HEAD 即只有宣告一处、零引用，语义由同行的 inCanvasWorkstation 承载）。
  // 原本对 resultMode 的字串断言只是对死识别字的源码探针，非行为断言，故一并
  // 移除；「agent 模式右侧恒为 canvas」的真契约由下方 inCanvasWorkstation /
  // canvas-ws-overlay / CanvasEmbed / ImageDisplay 四条断言承载。
  assert.match(source, /inCanvasWorkstation = displayMode === "agent"/);
  assert.match(source, /canvas-ws-overlay/);
  assert.match(source, /\{overlayContent \?\? <CanvasEmbed canvas=\{canvasHost\} expanded \/>\}/);
  assert.match(source, /<ImageDisplay/);
  // 2026-09-24 首秒零回缩：面板宽不再由 inline style 写 JS 值（旧断言钉的
  // { width: chatPanelWidth } ＝ 420→40vw 回缩元凶），改读 CSS 单一真相源。
  assert.match(source, /width: var\(--ws-panel-w\)/);
  assert.doesNotMatch(source, /width: chatPanelWidth/);
  assert.doesNotMatch(source, /ModelSelect/);
});

test("canvas workstation is a fullscreen overlay with expandable chat panel", () => {
  const source = readWorkstationSources();
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");

  // 工作站：画布吃满全场，聊天面板 expanded|rail 两态 + 右缘拖宽，localStorage 记忆。
  assert.match(source, /const \[chatPanelState, setChatPanelState\] = useState<"expanded" \| "rail">\("expanded"\)/);
  // 2026-09-24 首秒零回缩：宽度态 number|null——null＝CSS 默认（clamp）当终态，
  // 旧「初始值 420 + mount effect 改 40vw」回缩链已拆。同日追杀回填跳变：非
  // null 分支＝初始态同步读校验过的 v2 存值（与 layout pre-paint 脚本同一值），
  // 不再留 null 等 useLayoutEffect 回填——那正是「首帧 clamp→水合后缩回」的时序。
  assert.match(source, /const \[chatPanelWidth, setChatPanelWidth\] = useState<number \| null>\(\(\) => \{/);
  assert.doesNotMatch(source, /useState<number \| null>\(null\)/);
  assert.match(source, /canvas-chat-resize/);
  assert.match(source, /chatPanelState === "rail" && "canvas-chat-rail"/);
  // 画布 dock 偏移＝--ws-panel-w 终态＋0.75rem 间隙（不再由 JS 算 chatPanelWidth+12），
  // overlay 自身 left 用它避让面板；起点是导览列实测左缘（--site-shell-left，
  // 0924 排版对齐刀），fallback 0.75rem。
  assert.match(source, /--ce-dock-left/);
  assert.match(source, /"--ce-dock-left": chatPanelState === "rail" \? "4rem" : "calc\(var\(--ws-panel-w\) \+ 0\.75rem\)"/);
  assert.match(source, /left: "calc\(var\(--site-shell-left, 0\.75rem\) \+ var\(--ce-dock-left, 0px\)\)"/);
  assert.match(embed, /expanded = false/);
  assert.match(nodeView, /enterDelay/);
  assert.match(nodeView, /transitionDelay/);
});

test("the model picker is wired into the left prompt panel", () => {
  const source = read("src/components/ImagePlayground.tsx");
  // Task 9：<ModelPicker> JSX 抽到 GenerateControls —— 拼接读取，断言语义不变。
  const prompt = read("src/components/PromptInput.tsx") + "\n" + read("src/components/prompt-input/GenerateControls.tsx");

  // 2026-10-05 红队修复（5e46b701 入库）：渠道键改中性值 "primary"
  // （src/lib/provider-key.ts 单一真源），不再把内部渠道名带进客户端 bundle。
  assert.match(source, /models=\{PROVIDERS\.primary\.models\}/);
  assert.match(source, /modelId=\{selectedModels\.primary\}/);
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
  // Task 9：专业控制 toggle 抽到 ActionRow —— 拼接读取，断言语义不变。
  const prompt = read("src/components/PromptInput.tsx") + "\n" + read("src/components/prompt-input/ActionRow.tsx");

  // It used to occupy a whole right-aligned row above the grid.
  assert.doesNotMatch(source, /mb-4 flex justify-end/);
  // 2026-08-27 专业工作站入口移除：toggle 与 props 链全数退场。
  assert.doesNotMatch(source, /onToggleProfessionalMode|isProfessionalMode|showProfessionalMode/);
  assert.doesNotMatch(prompt, /onToggleProfessionalMode|isProfessionalMode|专业控制/);
});

test("professional mode keeps its draft mounted after returning home", () => {
  const source = read("src/components/ImagePlayground.tsx");

  // 2026-08-27 专业工作站入口移除：草稿保留挂载机制（hasOpenedProfessionalMode）
  // 随入口一并退场；playground 对专业模式相关状态零残留。
  assert.doesNotMatch(source, /hasOpenedProfessionalMode/);
  assert.doesNotMatch(source, /showProfessionalMode/);
  assert.doesNotMatch(source, /if \(showProfessionalMode\) \{\s*return/);
});

test("canvas workstation chat panel keeps the composer inside the panel", () => {
  // style 块（面板高度链加固）随面板壳搬进 CanvasChatWorkstation，读取路径跟著走。
  const source = read("src/components/canvas-workstation/CanvasChatWorkstation.tsx");

  // 面板是 fixed + overflow:hidden 的 flex 容器：内容超高时若高度链没把
  // transcript 的滚动接住，输入区会被推出面板外（用户截图：底部只见
  // 被裁掉的「思考过程」最后一行、输入框整体不可见）。加固规则：
  //  - 面板给 min-height:0 / max-height 兜底（bottom 已定界，双保险）
  //  - section.lg-card 拿 flex:1 1 0%（2026-09-24 暴君纠正：聊天态吃满面板全高；
  //    前一刀把聊天态高度也压成 fit-content 属劣化）再显式 min-height:0 +
  //    overflow:hidden——内容超高时由内部滚动接手，不许 agent 面把卡片按内容
  //    撑高到溢出面板；2026-09-24 暴君终裁：聊天态与空态一律吃满全高，旧
  //    :has() 空态分流作废，空态内容置中改由 transcript 内部 justify-center 负责
  //  - 非 lg-card 兄弟（如 agentBaseline 撤回条）shrink-0，不抢高度
  //  - composer 锚点 shrink-0，永不被 flex 压没
  //  - 面板吃满天花板（2026-09-24 暴君裁定／2026-10-03 对齐修订）：top 固定
  //    0.5rem（与右侧导览岛顶 8px 同高起跑）、max-height 只扣上下留白
  //    1.25rem＋底部安全区，不再从 --site-header-offset 起算；
  //    navbar 改经 --ws-navbar-inset 右退让位（跨档契约见下）。
  //    FAB 态 navbar 全宽，.canvas-chat-rail 的 top 仍从 --site-header-offset
  //    起算不被挡。
  assert.match(source, /\.canvas-chat-panel \{[^}]*top: 0\.5rem;[^}]*min-height: 0;[^}]*max-height: calc\(100dvh - 1\.25rem - env\(safe-area-inset-bottom, 0px\)\)/);
  // 2026-10-03 桌面按钮 y 对齐：卡片顶内距收回 4px＋消掉 space-y-4 幽灵外距，
  // 两条都必须在 ≥768px 媒体查询内（≤767px 全萤幕版布局不得被动到）。
  assert.match(source, /@media \(min-width: 768px\) \{\s*\.canvas-chat-scroll-fill > section\.lg-card \{\s*padding-top: 0\.25rem;\s*\}[\s\S]*?\.canvas-chat-scroll-fill > section\.lg-card > div > div\.dust-transition \{\s*margin-top: 0;\s*\}\s*\}/);
  assert.match(source, /\.canvas-chat-rail \{[^}]*top: calc\(var\(--site-header-offset, 4\.25rem\) \+ 0\.75rem\)/);
  // 跨档契约：navbar 右退变数两端都必须在场——工作站 useEffect 写入、
  // Navbar 的 <nav> 以 margin-left/宽度 calc 消费。缺任何一端＝面板吃顶后
  // header 被盖住（写入端失联）或胶囊不让位（消费端失联）。
  assert.match(source, /--ws-navbar-inset/);
  assert.match(read("src/components/Navbar.tsx"), /--ws-navbar-inset/);
  // 全高契约：lg-card 一律 flex:1 1 0%（2026-09-24 暴君终裁：聊天态与空态同标吃满全高）
  assert.match(source, /\.canvas-chat-scroll-fill > section\.lg-card \{[^}]*flex: 1 1 0%;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  // 拔除实锤：旧 :has() 空态分流与标记类必须两档全面退场（零命中），否则空态缩卡病灶回魂。
  assert.doesNotMatch(source, /agent-empty-state/);
  assert.doesNotMatch(read("src/components/agent-chat/AgentChatPanel.tsx"), /agent-empty-state/);
  assert.match(source, /\.canvas-chat-scroll-fill > :not\(section\.lg-card\) \{ flex-shrink: 0; \}/);
  assert.match(source, /\.agent-composer-anchor \{ flex-shrink: 0; \}/);
});

// 暴君裁定 2026-09-24：「reload 和初始载入时有一堆明显回缩的过程，破坏首秒体验」。
// 根治架构＝单一 CSS 变数真源（--ws-panel-w：默认 clamp 由纯 CSS 承担，SSR 首帧
// 即新用户终态）＋ settled 闸（所有 width/left transition 与入场 @keyframes 只在
// 首帧稳定后开启，载入零动画直出终态）。
test("first paint is the final state: --ws-panel-w single source + settled gate (2026-09-24)", () => {
  const ws = read("src/components/canvas-workstation/CanvasChatWorkstation.tsx");
  const panel = read("src/components/canvas-workstation/use-chat-panel.ts");
  const navbar = read("src/components/Navbar.tsx");

  // ① 单一真相源：CSS 默认＝新用户终态（clamp 360–720 of 40vw），宣告在
  //    工作站 <style> 的 :root——与 SSR 首帧同梱，零 JS。
  assert.match(ws, /--ws-panel-w: clamp\(22\.5rem, 40vw, 45rem\)/);
  // ② JS 写入端只在显式值（存值/拖宽）时存在，且全部 useLayoutEffect（paint 前）：
  //    显式→setProperty px；null→removeProperty 让位 CSS 默认。
  assert.match(panel, /useLayoutEffect\(\(\) => \{/);
  assert.match(panel, /documentElement\.style\.setProperty\("--ws-panel-w"/);
  assert.match(panel, /documentElement\.style\.removeProperty\("--ws-panel-w"\)/);
  // 默认宽度不再由 JS 读 window 发明（420 初始值与视口 40% 换算都是回缩元凶）。
  assert.doesNotMatch(panel, /innerWidth/);
  // 落盘只收显式宽：null（默认）不落盘，防「40vw 活语义被钉死成 px」。
  assert.match(panel, /if \(chatPanelWidth === null\) return;/);

  // ③ settled 闸：挂载双 rAF 后才开。CSS 侧——面板 width / overlay left 的
  //    transition 与 backdrop fade、rail fab-in 入场动画全部只在 .canvas-ws-settled 下。
  assert.match(ws, /setWsSettled\(true\)/);
  assert.match(ws, /\.canvas-chat-panel\.canvas-ws-settled \{[^}]*transition: width/);
  assert.match(ws, /\.canvas-ws-overlay\.canvas-ws-settled \{[^}]*transition: left/);
  assert.match(ws, /\.canvas-ws-backdrop\.canvas-ws-settled \{[^}]*animation: canvas-ws-fade/);
  assert.match(ws, /\.canvas-chat-rail\.canvas-ws-settled:not\(\.canvas-ws-was-rail\) \{[^}]*animation: canvas-ws-fab-in/);
  // navbar 退缩过度同样进闸（规则从 nav 的 tailwind 类别搬进工作站 <style>）。
  assert.match(ws, /html\[data-ws-settled\] #global-navbar nav \{[^}]*transition: margin-left/);
  assert.match(ws, /dataset\.wsSettled = "1"/);

  // ④ Navbar 跨档契约：退缩分支只属首页（pathname === "/"），非首页恒 0——
  //    否则 reload /history 等页会因 fallback 无端退缩。fallback 指面板宽终态。
  assert.match(navbar, /usePathname/);
  assert.match(navbar, /pathname === "\/"/);
  assert.match(navbar, /ml-\[var\(--ws-navbar-inset,calc\(var\(--ws-panel-w,420px\)_\+_0\.75rem\)\)\]/);
  assert.match(navbar, /w-\[calc\(100%_-_var\(--ws-navbar-inset,calc\(var\(--ws-panel-w,420px\)_\+_0\.75rem\)\)\)\]/);
  assert.match(navbar, /max-md:ml-0 max-md:w-full/);
  // 首帧即退缩＝旧「0px 起步 + JS 动画退缩」契约作废；nav 上的常开 transition
  // 类别必须全面退场（残留＝回缩动画回魂）。
  assert.doesNotMatch(navbar, /--ws-navbar-inset,0px/);
  assert.doesNotMatch(navbar, /duration-\[320ms\]/);
  assert.doesNotMatch(navbar, /transition-\[margin-left/);

  // ⑤ 工作站不再把像素回写 --ws-navbar-inset（拖宽即时性改由 CSS 变数链承担）。
  assert.doesNotMatch(ws, /setProperty\("--ws-navbar-inset", `\$\{chatPanelWidth\}/);
});

// 暴君回报 2026-09-24：「Ctrl+Shift+R 时聊天框先占几乎半屏、秒缩回 30% 以下，
// 非常恐怖」。根因＝冷载入首帧由 HTML+CSS 绘出 clamp 默认（40vw≈半屏），JS
// chunk 下载完才在水合 useLayoutEffect 里读到旧 localStorage 垃圾值（v1 key：
// useState(420) 时代 mount effect 无条件落盘的 420）并覆写变数——paint 之后的
// 第二次变更＝跳变。修法两半缺一不可：①存值升代 v2，旧 key 大赦不读＋清盘，
// 只认「用户真的拖过」的值；②layout.tsx 以 HTML 解析期同步内联 <script>
// （非 next/script beforeInteractive——实装 push 进 self.__next_s 由
// app-bootstrap 跑，与水合同期，对首帧仍然太晚）在首个 paint 前套用校验过的
// v2 值，首帧即终态。
test("stored width: legacy values amnestied, v2 applied before first paint (2026-09-24)", () => {
  const panel = read("src/components/canvas-workstation/use-chat-panel.ts");
  const layout = read("src/app/layout.tsx");

  // ① 升代 v2：写入端与初始态读取都用新 key，旧 key 只准 removeItem。
  assert.match(panel, /export const CHAT_PANEL_WIDTH_STORAGE_KEY = "canvas-chat-panel-width\.v2";/);
  assert.match(panel, /localStorage\.getItem\(CHAT_PANEL_WIDTH_STORAGE_KEY\)/);
  assert.match(panel, /localStorage\.setItem\(CHAT_PANEL_WIDTH_STORAGE_KEY, String\(chatPanelWidth\)\)/);
  assert.match(panel, /localStorage\.removeItem\(CHAT_PANEL_WIDTH_LEGACY_KEY\)/);
  // 旧 key 不读（雷：注释里出现旧 key 名属正常，断言只钉「读取呼叫」形态）。
  assert.doesNotMatch(panel, /getItem\(\s*CHAT_PANEL_WIDTH_LEGACY_KEY\s*\)/);
  assert.doesNotMatch(panel, /localStorage\.getItem\("canvas-chat-panel-width"\)/);
  assert.doesNotMatch(layout, /localStorage\.getItem\("canvas-chat-panel-width"\)/);
  // 校验范围单一表述：v2 值必须是 320–720 整数才落地（下限取拖宽底，非 clamp 底）。
  assert.match(panel, /if \(!Number\.isInteger\(w\) \|\| w < CHAT_PANEL_MIN_WIDTH \|\| w > CHAT_PANEL_MAX_WIDTH\) return null;/);

  // ② 第二跳变源大赦：rail 态 09-05 后 UI 不可达，旧持久值一律不读。
  assert.doesNotMatch(panel, /localStorage\.getItem\("canvas-chat-panel-state"\)/);

  // ③ pre-paint 同步脚本在场且含校验（钉 layout 源码字串；生产 HTML grep 为
  //    外部证据层，同字符串）。范围常量与 panel 侧逐字一致，防两端验证漂移。
  assert.match(
    layout,
    /var w=Number\(localStorage\.getItem\("canvas-chat-panel-width\.v2"\)\);if\(Number\.isInteger\(w\)&&w>=320&&w<=720\)\{document\.documentElement\.style\.setProperty\("--ws-panel-w",w\+"px"\);\}/,
  );
  assert.match(panel, /export const CHAT_PANEL_MIN_WIDTH = 320;/);
  assert.match(panel, /export const CHAT_PANEL_MAX_WIDTH = 720;/);
  // 脚本必须是解析期内联 <script>（dangerouslySetInnerHTML），不得改用
  // next/script 的 beforeInteractive（水合同期执行＝跳变会回魂）。
  // 雷位提示：本断言只钉 import 形态，layout 注释谈论 next/script 属正常。
  assert.doesNotMatch(layout, /from\s*"next\/script"/);
});
