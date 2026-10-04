# PRD：首轮真实用户反馈落地（2026-09-10）

**来源**：微信真实用户（尝试 AI 助理＋改图流程）现场反馈＋三张截图。
**性质**：修复＋体验优化混合。P0 为功能性故障（用户已实际卡死），P1 为高频操作摩擦，P2 为视觉优化。
**反馈原声摘要**：

> AI 生图效果不错，确实有 image2 的生成水平，没掺水。
> 1. 图片展示区太小了，网站整体下方留白较多。
> 2. 图片可以加上一键复制功能，手动下载再打开太麻烦了。
> 3. 我上传图片后最好可以像 Gemini 那样看到自己上传的图片，不用划到图片处再显示。
> 4. 如果能自动产出原比例就更好了，图片有点压缩了（如果是 p 图的话）。
> 5. AI 助理好像需要修复下，我能看到聊天框，不过鼠标点击没反应；点了那个「下一步」之后，整个界面灰色了，点不到任何按钮。

---

## R1（P0）：新手引导灰屏死锁——AI 助理被遮罩锁死

### 现场证据

截图①：AI 助理抽屉（空态，三条快捷 prompt）＋「小说影视化」模板卡轮播＋driver.js 引导弹窗「流水线环节 1/3」（上一步／下一步／跳过引导），全屏灰色半透明遮罩。用户反映：点聊天框没反应 → 点「下一步」→ 整个界面灰色，任何按钮都点不到。

### 根因链（已定位到源码）

| # | 环节 | 源码事实 |
|---|------|---------|
| 1 | 引导全屏遮罩盖住 AI 助理 | `src/lib/atc-tour-content.ts:217-231`：driver.js `overlayOpacity: 0.4` 全屏遮罩＋`overlayClickBehavior: () => {}`（点遮罩无任何反应）。AI 助理抽屉在遮罩之下 → 「能看到聊天框，点击没反应」 |
| 2 | 让位机制失效（死锁主因） | `atc-tour-content.ts:282-297`（R10-2 让位观察器）：MutationObserver 只在 `.agent-panel` transcript **出现新子节点**时 destroy 引导。用户根本打不了字（被遮罩挡住）→ transcript 永远空 → 引导永远不让位 → 死锁 |
| 3 | 点「下一步」后全屏灰 | 步骤②锚点 `frontSelector(' .atc-step-selector [data-step-index="0"]')` 依赖 `data-front="true"` 正面卡。轮播转卡／布局变动使锚点 rect 为零时，driver.js 退化为「stage 罩满全屏＋弹层定位失效」——此退化行为在 `src/components/pro-workstation/workstation-tours.ts:61-67` 注释中已有记载（手机端 display:none 场景），桌面端同样会踩 |
| 4 | 转卡锁定不全 | `atc-tour-content.ts:158-161`：`tourLock`（冻结轮播手势）只在步骤②假鼠标演示的 `onHighlightStarted` 挂上，步骤①→②切换的空档轮播仍可转卡（wheel／拖曳），锚点漂移即触发 #3 |
| 5 | Esc 出路存在但不可发现 | `allowClose: true`（Esc 可退）＋popover 有「跳过引导」按钮，但弹层定位失效后两者皆不可见 |

### 修复需求（验收标准）

**F1-1 引导与 AI 助理互斥让位**
- 引导启动条件追加：`.agent-panel` 处于打开态 → 不自动播（静默跳过，照样写 `ATC_TOUR_STORAGE_KEY`？**否**——不写，让下次关闭助理后仍可教学）。
- 引导播放中用户打开 AI 助理（点悬浮球／任何进入 agent 面板的路径）→ 引导立即干净收尾（走既有 `onDestroyed` 统一收尾）。实作可复用 R10-2 观察器思路，但触发条件从「transcript 有内容」提前到「面板打开」。
- 验收：AI 助理打开态下进入模板廊，零引导弹窗；引导播放中点开助理，引导 300ms 内消失、助理可输入。

**F1-2 零锚点防退化门禁**
- 每步 `onHighlightStarted` 前验证锚点：`getBoundingClientRect()` 宽高 > 0 且与视口有交集；不满足 → 跳过该步（`tour.moveTo(i+1)`）或安全收尾，**禁止**退化成全屏 stage 无弹层状态。
- 轮子：`src/lib/tour-mobile.ts` 的 `firstVisibleAnchor` 已做「多候选锚点解析」，在其基础上补 rect 校验（它目前只挑 DOM 存在性，不验尺寸）。
- 验收：手动把步骤②锚点元素藏掉（devtools `display:none`），点下一步 → 该步被跳过或引导收尾，任何时刻萤幕不出现「全灰且无弹层」状态。

**F1-3 轮播全程锁定**
- `tourLock.on()` 从步骤②移到 `activeTour.drive()` 之前（引导全程冻结轮播转卡），`onDestroyed` 已有 `tourLock.off()` 不动。
- 验收：引导播放中滚轮／拖曳轮播，正面卡不换。

**F1-4 同类隐患排查（同一修法复用）**
- driver.js 共三处实例：`atc-tour-content.ts`、`pro-workstation/workstation-tours.ts`、`ModelPicker.tsx`。F1-2 的 rect 验证做成共用函数进 `tour-mobile.ts`，三处接线。

**改动档案**：`src/lib/atc-tour-content.ts`、`src/lib/tour-mobile.ts`、`src/components/pro-workstation/workstation-tours.ts`、`src/components/ModelPicker.tsx`、`src/components/canvas-workstation/AgentTemplateCarousel.tsx`（tourLock 若需挂载点配合）。
**禁区**：`AgentTemplateCarousel.test.ts:197` 断言 `流水线环节` 文案——教学三步文案不得改动。

---

## R2（P1）：图片一键复制到剪贴板

### 现场证据

用户：「图片可以加上一键复制功能，手动下载再打开太麻烦了。」
现状：`src/components/ImageDisplay.tsx:176-188` 只有下载钮（左下角圆钮，hover 浮现）。

### 需求

- 图片结果卡（`ImageDisplay`）新增「复制」按钮：与下载钮同一排（左下角），成功后 toast「已复制到剪贴板」（复用现有 toast），失败（浏览器不支援／权限拒绝）fallback 提示「当前浏览器不支持复制，已为你下载」并走下载。
- **轮子源**：`src/lib/image-helpers.ts` 的 `download()` 内已有完整 blob 取得链（http 源 `?dl=1` + `cache: no-store` 破缓存、base64/blob 直转——这是图片下载 CORS 中毒事故的修法，必须原样复用，禁止重写）。抽 `fetchImageBlob(imageSource): Promise<Blob>` 供 download 与 copy 共用，download 行为零变动。
- 复制本体：`navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])`。注意：Chrome 标准 `ClipboardItem` 吃 Blob；Safari 需传 **Promise** 形式（`new ClipboardItem({ "image/png": fetchBlobPromise })`）——直接传 promise，两家都相容。
- 进行中间态：复制需整图 fetch，与下载钮同款 `Loader2` 转圈＋禁点（`isDownloading` 模式照抄为 `isCopying`）。
- 放大灯箱（`ImageDisplay.tsx:226-249` zoom portal）同步加复制钮（用户放大看图的瞬间正是想拿图的瞬间）。
- 改图结果（`src/components/prompt-input/EditPanel.tsx:111-133`）「改图完成」行的下载钮旁加复制。

**改动档案**：`src/components/ImageDisplay.tsx`、`src/lib/image-helpers.ts`、`src/components/prompt-input/EditPanel.tsx`。
**验收**：Chrome 贴进微信/画布得到原图 PNG；http 源与 base64 源双通路；下载功能零回归。

---

## R3（P1）：上传缩图内联显示（Gemini 式）

### 现场证据

用户：「我上传图片后最好可以像 Gemini 那样看到自己上传的图片，不用划到图片处再显示。」
截图②③：generate 模式带 1 张参考图，输入框左下只有上传钮＋数字胶囊「1」，看不到图。

### 根因

`src/components/ReferenceImageUpload.tsx:143-204`（`variant="prompt"`）：缩图格 **默认收合**，仅 hover（`hoverOpen`）或手动点胶囊（`isExpanded`）才展开。桌面不 hover 就看不到；手机无 hover 概念，全靠点胶囊。EditPanel（改图模式）仅 20px 微缩图。

### 需求

- generate 模式：有参考图时，缩图**默认内联显示**在输入框下沿（attachment 列），每张 ~48-64px 圆角缩图＋右上移除 X，行为对齐 Gemini composer（看得见即为默认态，收合变成可选）。
- 单张时展示原比例缩图（`object-cover` 裁切可接受，但单张建议 `object-contain`＋浅底，避免误导比例——与 R4 原比例认知一致）。
- 上传成功即刻出现（pending 态骨架已有，保留）。
- 保留现有 hover 展开大图／点击放大预览（`activePreview`）能力不删。
- 手机端同等生效（点缩图＝放大预览，点 X＝移除）。
- **轮子源**：同档 `variant="panel"`（素材面板）的缩图格 `ReferenceImageUpload.tsx:155-171` 就是现成 grid 缩图实现，复用其卡片结构与移除钮，白名单改为「prompt 变体默认不收合」。

**改动档案**：`src/components/ReferenceImageUpload.tsx`（仅 prompt 变体分支）。
**验收**：上传 1 张图，不碰滑鼠缩图已可见；连传 3 张排列不溢出；移除按钮可用；手机（375px 宽）不破版。

---

## R4（P1）：跟随参考图原比例输出

### 现场证据

用户：「如果能自动产出原比例就更好了，图片有点压缩了……如果是 p 图的话。」
截图②③：奖状图（横向 A4 比例）被放进 generate 模式 1:1 出图 → 明显压缩裁切。

### 根因

- generate 模式比例为固定 10 档（1:1 … 21:9，`src/lib/generation-model-catalog/types.ts:2-23`），无「跟随参考图」。
- 改图模式（pixai edit）**已有**「跟随原图」（`src/components/prompt-input/EditPanel.tsx:97`，`PIXAI_RATIO_CHIPS` 的 `original` 键）——功能存在但用户走的是 generate＋参考图路径，享受不到。
- 展示层二次伤害：`ImageDisplay.tsx:172` 用 `object-cover` + 容器 `aspect-square`，非 1:1 结果在展示区被再裁一次。

### 需求

- **F4-1 选项**：generate 模式且已上传 ≥1 张参考图时，比例列首位动态插入「跟随参考图」档（有参考图才出现，移除全部参考图即消失并回落到普通比例）。
- **F4-2 解析**：读第一张参考图自然尺寸（`ReferenceImage` 已带 `previewUrl`，`new Image()` 读 `naturalWidth/Height`），映射到上游**支援**的比例档：取长宽比与支援清单逐一求差，选最近者；无近似档（差距 >15%）时若上游支援自订尺寸则直传原比例，否则选最近档并在 chip 上标注实际输出（如「跟随参考图 · 3:4」）——**不许静默扭曲**，宁可明示。
- **F4-3 展示不裁切**：`ImageDisplay` 有结果时容器按结果实际比例呈现（`object-contain` 或动态 aspect style），生成中（粒子海）维持现状。此项同时服务 R5。
- 模型不支援参考图时（`referenceImagesSupported=false`）不出现该档，零改动。

**轮子源**：`EditPanel.tsx:87-101` 的「跟随原图」chip 模式（文案、active 态）；`src/lib/generation-model-catalog` 的 `imageSizeForAspectRatio`（`run-service.ts:16` 在用）为尺寸换算真源。
**改动档案**：`src/components/PromptInput.tsx`（比例列）、`src/components/ImagePlayground.tsx`（aspectRatio 状态与送出参数）、`src/lib/generation-model-catalog/*`（如需扩充 ratio 解析）、`src/components/ImageDisplay.tsx`（F4-3）。
**验收**：上传横向奖状图＋「跟随参考图」→ 出图比例 = 原图（或明示最近档）；无参考图时比例列零变化；改图模式零回归。

---

## R5+R6（P0，暴君 09-10 追加裁定）：首页总高度动态适应萤幕，禁止下方大面积空白

### 现场证据

用户：「图片展示区太小了，网站整体下方留白较多。」截图②③：右侧结果区下方到视口底一大段空白。
暴君裁定（2026-09-10）：**整个首页 UI（header + ImagePlayground + 右边成片展示）总高度必须根据萤幕高度动态适应，禁止像例子一样下方大面积空白造成半成品感。**

### 根因

- `src/components/ImagePlayground.tsx:515`：`min-h-screen pb-28 pt-10 sm:pb-32` —— 内容自然高 + 固定 padding，视口高于内容时底部留白。
- `ImagePlayground.tsx:517`：grid 两栏等高于内容自然高；`ImageDisplay.tsx:118` `xl:h-full xl:min-h-[30rem]` 结果卡锁在与 prompt 面板同高。
- 页面是「内容往下长」的文档流布局，不是「撑满视口」的应用布局。

### 需求

- **F6-1 应用式满屏**：首页壳改为 `h-dvh`（或 `min-h-dvh` + 内部 flex）三段结构——Navbar（自然高）＋主工作区（`flex-1 min-h-0`）＋底部安全边距。主工作区内 grid 撑满剩余高度，两栏各自 `h-full`／`min-h-0`，右栏结果卡吃满可用高（`min-h-0` + 内部滚动/contain，不许溢出视口）。
- **F6-2 短视口退路**：视口过矮（如笔记本横置 768px）时允许整页滚动（`min-h-dvh` 而非写死 `h-dvh` 溢出截断），但正常桌面视口下「不滚即满屏、零下方空白」。
- **F6-3 下方 SEO 区块不动**：`UseCaseLinks`/`FaqSection` 已是 `hidden`，不受影响；底部浮动 toast 条（fixed）不受影响。
- **F6-4 对齐 F4-3**：结果卡内图按实际比例 `object-contain` 呈现（不在 R5 单独做，与 F4-3 同一改动）。
- 手机端（<xl 单栏堆叠）维持现状文档流，不套满屏（手机本来就滚动）。
- 属视觉改动：改完部署，视觉结果 pending 暴君验收（禁自我 UI 检查）。

**改动档案**：`src/components/ImagePlayground.tsx`、`src/components/ImageDisplay.tsx`、`src/components/Navbar.tsx`（若 header 需参与 flex 壳）、全域布局壳（`src/app/page.tsx` / `layout.tsx` 若有外层 padding 需让位）。

---

## 优先级与交付顺序

| 顺位 | 项目 | 理由 |
|------|------|------|
| 1 | R1 灰屏死锁 | 功能性故障，新用户第一分钟即卡死，直接劝退 |
| 2 | R5+R6 满屏高度 | 暴君钦点追加，「半成品感」直接伤首屏观感 |
| 3 | R2 一键复制 | 高频操作摩擦，改动面小（3 档） |
| 4 | R4 原比例 | 用户明确点名「有点压缩」，涉及计费 SKU 尺寸换算须谨慎 |
| 5 | R3 缩图内联 | 单档改动，体验增益明确 |

## 全局禁区

- `AgentTemplateCarousel.test.ts` / `ProfessionalWorkstation.test.ts` 等既有断言文案不改（R1 涉及教学文案时逐字保留「流水线环节」等）。
- `imageHelpers.download` 的 CORS 破缓存逻辑（`?dl=1` + `no-store`）是历史事故修法，抽共用时逐行保留。
- 计费换算（`generationCoins` / `imageSizeForAspectRatio`）只读现有真源，不自创价格。
- UI 文案一律简体（对齐现有面），遵守 design-system lg-* 体系，正文 ≥13px。
