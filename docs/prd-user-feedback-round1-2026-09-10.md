# PRD：首輪真實用戶反饋落地（2026-09-10）

**來源**：微信真實用戶（嘗試 AI 助理＋改圖流程）現場反饋＋三張截圖。
**性質**：修復＋體驗優化混合。P0 為功能性故障（用戶已實際卡死），P1 為高頻操作摩擦，P2 為視覺優化。
**反饋原聲摘要**：

> AI 生图效果不错，确实有 image2 的生成水平，没掺水。
> 1. 图片展示区太小了，网站整体下方留白较多。
> 2. 图片可以加上一键复制功能，手动下载再打开太麻烦了。
> 3. 我上传图片后最好可以像 Gemini 那样看到自己上传的图片，不用划到图片处再显示。
> 4. 如果能自动产出原比例就更好了，图片有点压缩了（如果是 p 图的话）。
> 5. AI 助理好像需要修复下，我能看到聊天框，不过鼠标点击没反应；点了那个「下一步」之后，整个界面灰色了，点不到任何按钮。

---

## R1（P0）：新手引導灰屏死鎖——AI 助理被遮罩鎖死

### 現場證據

截圖①：AI 助理抽屜（空態，三條快捷 prompt）＋「小说影视化」模板卡輪播＋driver.js 引導彈窗「流水线环节 1/3」（上一步／下一步／跳过引导），全屏灰色半透明遮罩。用戶反映：點聊天框沒反應 → 點「下一步」→ 整個界面灰色，任何按鈕都點不到。

### 根因鏈（已定位到源碼）

| # | 環節 | 源碼事實 |
|---|------|---------|
| 1 | 引導全屏遮罩蓋住 AI 助理 | `src/lib/atc-tour-content.ts:217-231`：driver.js `overlayOpacity: 0.4` 全屏遮罩＋`overlayClickBehavior: () => {}`（點遮罩無任何反應）。AI 助理抽屜在遮罩之下 → 「能看到聊天框，點擊沒反應」 |
| 2 | 讓位機制失效（死鎖主因） | `atc-tour-content.ts:282-297`（R10-2 讓位觀察器）：MutationObserver 只在 `.agent-panel` transcript **出現新子節點**時 destroy 引導。用戶根本打不了字（被遮罩擋住）→ transcript 永遠空 → 引導永遠不讓位 → 死鎖 |
| 3 | 點「下一步」後全屏灰 | 步驟②錨點 `frontSelector(' .atc-step-selector [data-step-index="0"]')` 依賴 `data-front="true"` 正面卡。輪播轉卡／佈局變動使錨點 rect 為零時，driver.js 退化為「stage 罩滿全屏＋彈層定位失效」——此退化行為在 `src/components/pro-workstation/workstation-tours.ts:61-67` 註釋中已有記載（手機端 display:none 場景），桌面端同樣會踩 |
| 4 | 轉卡鎖定不全 | `atc-tour-content.ts:158-161`：`tourLock`（凍結輪播手勢）只在步驟②假鼠標演示的 `onHighlightStarted` 掛上，步驟①→②切換的空檔輪播仍可轉卡（wheel／拖曳），錨點漂移即觸發 #3 |
| 5 | Esc 出路存在但不可發現 | `allowClose: true`（Esc 可退）＋popover 有「跳过引导」按鈕，但彈層定位失效後兩者皆不可見 |

### 修復需求（驗收標準）

**F1-1 引導與 AI 助理互斥讓位**
- 引導啟動條件追加：`.agent-panel` 處於打開態 → 不自動播（靜默跳過，照樣寫 `ATC_TOUR_STORAGE_KEY`？**否**——不寫，讓下次關閉助理後仍可教學）。
- 引導播放中用戶打開 AI 助理（點懸浮球／任何進入 agent 面板的路徑）→ 引導立即乾淨收尾（走既有 `onDestroyed` 統一收尾）。實作可複用 R10-2 觀察器思路，但觸發條件從「transcript 有內容」提前到「面板打開」。
- 驗收：AI 助理打開態下進入模板廊，零引導彈窗；引導播放中點開助理，引導 300ms 內消失、助理可輸入。

**F1-2 零錨點防退化門禁**
- 每步 `onHighlightStarted` 前驗證錨點：`getBoundingClientRect()` 寬高 > 0 且與視口有交集；不滿足 → 跳過該步（`tour.moveTo(i+1)`）或安全收尾，**禁止**退化成全屏 stage 無彈層狀態。
- 輪子：`src/lib/tour-mobile.ts` 的 `firstVisibleAnchor` 已做「多候選錨點解析」，在其基礎上補 rect 校驗（它目前只挑 DOM 存在性，不驗尺寸）。
- 驗收：手動把步驟②錨點元素藏掉（devtools `display:none`），點下一步 → 該步被跳過或引導收尾，任何時刻螢幕不出現「全灰且無彈層」狀態。

**F1-3 輪播全程鎖定**
- `tourLock.on()` 從步驟②移到 `activeTour.drive()` 之前（引導全程凍結輪播轉卡），`onDestroyed` 已有 `tourLock.off()` 不動。
- 驗收：引導播放中滾輪／拖曳輪播，正面卡不換。

**F1-4 同類隱患排查（同一修法複用）**
- driver.js 共三處實例：`atc-tour-content.ts`、`pro-workstation/workstation-tours.ts`、`ModelPicker.tsx`。F1-2 的 rect 驗證做成共用函數進 `tour-mobile.ts`，三處接線。

**改動檔案**：`src/lib/atc-tour-content.ts`、`src/lib/tour-mobile.ts`、`src/components/pro-workstation/workstation-tours.ts`、`src/components/ModelPicker.tsx`、`src/components/canvas-workstation/AgentTemplateCarousel.tsx`（tourLock 若需掛載點配合）。
**禁區**：`AgentTemplateCarousel.test.ts:197` 斷言 `流水线环节` 文案——教學三步文案不得改動。

---

## R2（P1）：圖片一鍵複製到剪貼板

### 現場證據

用戶：「图片可以加上一键复制功能，手动下载再打开太麻烦了。」
現狀：`src/components/ImageDisplay.tsx:176-188` 只有下載鈕（左下角圓鈕，hover 浮現）。

### 需求

- 圖片結果卡（`ImageDisplay`）新增「複製」按鈕：與下載鈕同一排（左下角），成功後 toast「已复制到剪贴板」（複用現有 toast），失敗（瀏覽器不支援／權限拒絕）fallback 提示「当前浏览器不支持复制，已为你下载」並走下載。
- **輪子源**：`src/lib/image-helpers.ts` 的 `download()` 內已有完整 blob 取得鏈（http 源 `?dl=1` + `cache: no-store` 破緩存、base64/blob 直轉——這是圖片下載 CORS 中毒事故的修法，必須原樣複用，禁止重寫）。抽 `fetchImageBlob(imageSource): Promise<Blob>` 供 download 與 copy 共用，download 行為零變動。
- 複製本體：`navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])`。注意：Chrome 標準 `ClipboardItem` 吃 Blob；Safari 需傳 **Promise** 形式（`new ClipboardItem({ "image/png": fetchBlobPromise })`）——直接傳 promise，兩家都相容。
- 進行中間態：複製需整圖 fetch，與下載鈕同款 `Loader2` 轉圈＋禁點（`isDownloading` 模式照抄為 `isCopying`）。
- 放大燈箱（`ImageDisplay.tsx:226-249` zoom portal）同步加複製鈕（用戶放大看圖的瞬間正是想拿圖的瞬間）。
- 改圖結果（`src/components/prompt-input/EditPanel.tsx:111-133`）「改图完成」行的下載鈕旁加複製。

**改動檔案**：`src/components/ImageDisplay.tsx`、`src/lib/image-helpers.ts`、`src/components/prompt-input/EditPanel.tsx`。
**驗收**：Chrome 貼進微信/畫布得到原圖 PNG；http 源與 base64 源雙通路；下載功能零回歸。

---

## R3（P1）：上傳縮圖內聯顯示（Gemini 式）

### 現場證據

用戶：「我上传图片后最好可以像 Gemini 那样看到自己上传的图片，不用划到图片处再显示。」
截圖②③：generate 模式帶 1 張參考圖，輸入框左下只有上傳鈕＋數字膠囊「1」，看不到圖。

### 根因

`src/components/ReferenceImageUpload.tsx:143-204`（`variant="prompt"`）：縮圖格 **默認收合**，僅 hover（`hoverOpen`）或手動點膠囊（`isExpanded`）才展開。桌面不 hover 就看不到；手機無 hover 概念，全靠點膠囊。EditPanel（改圖模式）僅 20px 微縮圖。

### 需求

- generate 模式：有參考圖時，縮圖**默認內聯顯示**在輸入框下沿（attachment 列），每張 ~48-64px 圓角縮圖＋右上移除 X，行為對齊 Gemini composer（看得見即為默認態，收合變成可選）。
- 單張時展示原比例縮圖（`object-cover` 裁切可接受，但單張建議 `object-contain`＋淺底，避免誤導比例——與 R4 原比例認知一致）。
- 上傳成功即刻出現（pending 態骨架已有，保留）。
- 保留現有 hover 展開大圖／點擊放大預覽（`activePreview`）能力不刪。
- 手機端同等生效（點縮圖＝放大預覽，點 X＝移除）。
- **輪子源**：同檔 `variant="panel"`（素材面板）的縮圖格 `ReferenceImageUpload.tsx:155-171` 就是現成 grid 縮圖實現，複用其卡片結構與移除鈕，白名單改為「prompt 變體默認不收合」。

**改動檔案**：`src/components/ReferenceImageUpload.tsx`（僅 prompt 變體分支）。
**驗收**：上傳 1 張圖，不碰滑鼠縮圖已可見；連傳 3 張排列不溢出；移除按鈕可用；手機（375px 寬）不破版。

---

## R4（P1）：跟隨參考圖原比例輸出

### 現場證據

用戶：「如果能自动产出原比例就更好了，图片有点压缩了……如果是 p 图的话。」
截圖②③：獎狀圖（橫向 A4 比例）被放進 generate 模式 1:1 出圖 → 明顯壓縮裁切。

### 根因

- generate 模式比例為固定 10 檔（1:1 … 21:9，`src/lib/generation-model-catalog/types.ts:2-23`），無「跟隨參考圖」。
- 改圖模式（pixai edit）**已有**「跟随原图」（`src/components/prompt-input/EditPanel.tsx:97`，`PIXAI_RATIO_CHIPS` 的 `original` 鍵）——功能存在但用戶走的是 generate＋參考圖路徑，享受不到。
- 展示層二次傷害：`ImageDisplay.tsx:172` 用 `object-cover` + 容器 `aspect-square`，非 1:1 結果在展示區被再裁一次。

### 需求

- **F4-1 選項**：generate 模式且已上傳 ≥1 張參考圖時，比例列首位動態插入「跟随参考图」檔（有參考圖才出現，移除全部參考圖即消失並回落到普通比例）。
- **F4-2 解析**：讀第一張參考圖自然尺寸（`ReferenceImage` 已帶 `previewUrl`，`new Image()` 讀 `naturalWidth/Height`），映射到上游**支援**的比例檔：取長寬比與支援清單逐一求差，選最近者；無近似檔（差距 >15%）時若上游支援自訂尺寸則直傳原比例，否則選最近檔並在 chip 上標註實際輸出（如「跟随参考图 · 3:4」）——**不許靜默扭曲**，寧可明示。
- **F4-3 展示不裁切**：`ImageDisplay` 有結果時容器按結果實際比例呈現（`object-contain` 或動態 aspect style），生成中（粒子海）維持現狀。此項同時服務 R5。
- 模型不支援參考圖時（`referenceImagesSupported=false`）不出現該檔，零改動。

**輪子源**：`EditPanel.tsx:87-101` 的「跟随原图」chip 模式（文案、active 態）；`src/lib/generation-model-catalog` 的 `imageSizeForAspectRatio`（`run-service.ts:16` 在用）為尺寸換算真源。
**改動檔案**：`src/components/PromptInput.tsx`（比例列）、`src/components/ImagePlayground.tsx`（aspectRatio 狀態與送出參數）、`src/lib/generation-model-catalog/*`（如需擴充 ratio 解析）、`src/components/ImageDisplay.tsx`（F4-3）。
**驗收**：上傳橫向獎狀圖＋「跟随参考图」→ 出圖比例 = 原圖（或明示最近檔）；無參考圖時比例列零變化；改圖模式零回歸。

---

## R5+R6（P0，暴君 09-10 追加裁定）：首頁總高度動態適應螢幕，禁止下方大面積空白

### 現場證據

用戶：「图片展示区太小了，网站整体下方留白较多。」截圖②③：右側結果區下方到視口底一大段空白。
暴君裁定（2026-09-10）：**整個首頁 UI（header + ImagePlayground + 右邊成片展示）總高度必須根據螢幕高度動態適應，禁止像例子一樣下方大面積空白造成半成品感。**

### 根因

- `src/components/ImagePlayground.tsx:515`：`min-h-screen pb-28 pt-10 sm:pb-32` —— 內容自然高 + 固定 padding，視口高於內容時底部留白。
- `ImagePlayground.tsx:517`：grid 兩欄等高於內容自然高；`ImageDisplay.tsx:118` `xl:h-full xl:min-h-[30rem]` 結果卡鎖在與 prompt 面板同高。
- 頁面是「內容往下長」的文檔流佈局，不是「撐滿視口」的應用佈局。

### 需求

- **F6-1 應用式滿屏**：首頁殼改為 `h-dvh`（或 `min-h-dvh` + 內部 flex）三段結構——Navbar（自然高）＋主工作區（`flex-1 min-h-0`）＋底部安全邊距。主工作區內 grid 撐滿剩餘高度，兩欄各自 `h-full`／`min-h-0`，右欄結果卡吃滿可用高（`min-h-0` + 內部滾動/contain，不許溢出視口）。
- **F6-2 短視口退路**：視口過矮（如筆記本橫置 768px）時允許整頁滾動（`min-h-dvh` 而非寫死 `h-dvh` 溢出截斷），但正常桌面視口下「不滾即滿屏、零下方空白」。
- **F6-3 下方 SEO 區塊不動**：`UseCaseLinks`/`FaqSection` 已是 `hidden`，不受影響；底部浮動 toast 條（fixed）不受影響。
- **F6-4 對齊 F4-3**：結果卡內圖按實際比例 `object-contain` 呈現（不在 R5 單獨做，與 F4-3 同一改動）。
- 手機端（<xl 單欄堆疊）維持現狀文檔流，不套滿屏（手機本來就滾動）。
- 屬視覺改動：改完部署，視覺結果 pending 暴君驗收（禁自我 UI 檢查）。

**改動檔案**：`src/components/ImagePlayground.tsx`、`src/components/ImageDisplay.tsx`、`src/components/Navbar.tsx`（若 header 需參與 flex 殼）、全域佈局殼（`src/app/page.tsx` / `layout.tsx` 若有外層 padding 需讓位）。

---

## 優先級與交付順序

| 順位 | 項目 | 理由 |
|------|------|------|
| 1 | R1 灰屏死鎖 | 功能性故障，新用戶第一分鐘即卡死，直接勸退 |
| 2 | R5+R6 滿屏高度 | 暴君欽點追加，「半成品感」直接傷首屏觀感 |
| 3 | R2 一鍵複製 | 高頻操作摩擦，改動面小（3 檔） |
| 4 | R4 原比例 | 用戶明確點名「有點压缩」，涉及計費 SKU 尺寸換算須謹慎 |
| 5 | R3 縮圖內聯 | 單檔改動，體驗增益明確 |

## 全局禁區

- `AgentTemplateCarousel.test.ts` / `ProfessionalWorkstation.test.ts` 等既有斷言文案不改（R1 涉及教學文案時逐字保留「流水线环节」等）。
- `imageHelpers.download` 的 CORS 破緩存邏輯（`?dl=1` + `no-store`）是歷史事故修法，抽共用時逐行保留。
- 計費換算（`generationCoins` / `imageSizeForAspectRatio`）只讀現有真源，不自創價格。
- UI 文案一律簡體（對齊現有面），遵守 design-system lg-* 體系，正文 ≥13px。
