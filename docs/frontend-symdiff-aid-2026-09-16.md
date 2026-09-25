# 前端層面對稱差報告（2026-09-16）

> 定性：**能力建設**（探索 + 找差，不是修復）
> 方法：真部署兩邊前端 → 同源結構提取（DOM 幾何 + 交互元素）→ 逐條 grep 驗證存在性
> 鐵律遵守：**列缺口前必 grep 驗證**（PRD §9 更正五教訓：曾把「我方已有」誤判為缺口）

---

## 0. 部署與取證（可複驗）

| 項 | AID | 我方 |
|---|---|---|
| 源碼 | `/tmp/aid-deploy`（`git clone --depth 1`，128MB） | `/home/lenovo/Desktop/image-app` |
| 起法 | `next dev --port 4100`（Next 16.3 / Turbopack） | `next dev --port 3200`（Next 15.5.15，LOCAL_TEST_MODE + 真 gateway） |
| 依賴 | `npm install` 594 包 | 既有 |
| 截圖 | `/tmp/aid-shots/0*.png`（12 頁） | `/tmp/aid-shots/ours-*.png` |
| 結構 | `/tmp/aid-shots/aid-dom-report.json` | `/tmp/aid-shots/ours-dom-report.json` |
| 輪子 | `eval-visual-replay/aid-dom.mjs`、`aid-shot.mjs` | `eval-visual-replay/ours-dom.mjs` |
| 過登入閘 | `localStorage.token` 預置（前端守衛） | `NEXT_PUBLIC_LOCAL_TEST_MODE` |

**尺度說明（誠實邊界）**：AID 後端未部署 → 其頁面資料區全空（「案例列表加载失败」「暂无分镜」）。故本報告比的是**版面骨架與交互結構**（不依賴後端），不比資料態內容。我方頁面走真 gateway，但多數頁面同樣無資料態，同尺度。

---

## 1. 一句話結論

**AID 前端強在「流程的空間化」——把 7 步生產流程做成常駐導航骨架，每一步配一個專業工作台，使用者永遠知道「我在哪、下一步是什麼、這一步還差什麼」。我方強在「能力的表達」——3D 導演台 39,251 行 vs AID studio 5,150 行、45 個 agent 模板 vs AID 無對應物。兩者不是同一維度。**

**真正的單向對稱差只有一項且很明確：AID 有流程空間化，我方沒有。**

---

## 2. AID 前端骨幹（實測結構）

```
create-page (0,0 1600x1000)
├── 左側全域導航 80px（案例广场 / 我的作品 / 资产库 / 新手教程）
└── create-main (80,0 1520x1000)
    ├── 7 步流程條（常駐，每一頁都帶）
    │   项目配置 → 剧本创作 → 素材准备 → 分镜设计 → 视频生成 → 音画同步 → 成品预览
    └── preview-panel (104,118 1448x860)  ← 每步的工作台
```

**7 步流程條實測命中率**：`05~11` 共 **7 頁全帶 7/7**；`works/assets/series-episode-list` 不帶（不同層級）。這是**常駐骨架**，不是單頁元件。

各步工作台（實測類名 + 交互元素）：

| 步 | 頁 | 工作台類名 | 關鍵交互 |
|---|---|---|---|
| 1 项目配置 | `/create/global-setting` | `left-panel 340px` + `right-panel 1064px` | 作品類型 / 6 種比例 / 風格庫 / 模型策略 / 創作模式 |
| 2 剧本创作 | `/create/story-script` | `rich-text-editor ql-editor`（Quill 1448x800） | 撤銷/重做/複製/清空 + **AI寫劇本** + 導入 + **歷史版本** + 右側 Agent 對話 |
| 3 素材准备 | `/create/scene-character` | `scp-content` + `asset-section` | 場景/角色/道具三分頁 + **自動提取場景** |
| 4 分镜设计 | `/create/storyboard-script` | `storyboard-step-shell` | **列表/卡片雙視圖** + 添加分鏡 + 自動生成 + **完成進度 0/0** |
| 5 视频生成 | `/create/storyboard-video` | 同構 | 列表/卡片 + **批量操作** |
| 6 音画同步 | `/create/dubbing` | `dubbing-wrap` | 列表/卡片 + 批量操作 |
| 7 成品预览 | `/create/preview` | `preview-player-area 1448x582` + **`timeline-wrap 1448x238`** | 播放器 + **時間軸軌道**（`track-row-video` 72px）+ 導出/發布 |

**體量**：`components/studio` 50 個 tsx / 5,150 行；`hooks/studio` 13 個 hook。

---

## 3. 我方前端（實測結構）

```
page-shell (80,0 1440x62)  頂欄
└── page-shell xl:flex (80,102 1440x834)
    ├── 生成區 892px（PromptInput + 模型/比例/風格 chips）
    └── 右欄 460px
```

- **首頁 = 單一生成器**（prompt + 45 個模板卡 + 模型/比例/風格選擇器）
- **agent 面**（`?agent=1`）= `canvas-ws-overlay 1156x1000` + `agent-template-carousel` + 45 個模板按鈕 + 輸入框「描述新需求，或要求修改上一輪的圖…」
- 路由 17 頁：`/ /agent /pricing /history /status /docs/* /admin /settings/api-keys /review /wechat-login`
- **無 7 步流程條、無時間軸軌道、無作品列表頁、無案例廣場**

---

## 4. 單向對稱差清單（逐條 grep 驗證）

### 4.1 真缺口（我方確實沒有）

| # | 缺口 | AID 座標 | 我方驗證 | 嚴重度 |
|---|---|---|---|---|
| **D1** | **7 步流程常駐導航骨架** | 7 頁全帶 `项目配置→…→成品预览` | `grep currentStep src/components/ src/app/` → **僅 1 命中且是 API route**；`creation-flow-steps.ts` 被 import 處只有 `use-canvas-chat.ts`(型別) 與 `project-store.ts`(清洗) | **高** |
| **D2** | **分鏡「完成進度 N/M」可見化** | `分镜完成进度：0/0` | `grep 完成进度\|完成進度` → **0 檔** | 中 |
| **D3** | **成品預覽的時間軸軌道 UI** | `timeline-wrap` + `track-row-video` | `grep timeline-track\|TimelineTrack` → **0 檔**（後端 `timeline.ts` 有 op DSL，前端無呈現） | 中 |
| **D4** | **作品列表頁（專案為單位的入口）** | `/works` + `新建作品` | 路由無 `/works`；`grep 我的作品` → 僅 1 檔（非頁面） | 中 |
| **D5** | **案例廣場（公開作品瀏覽）** | `/` 首頁 + 全部/電影/電視劇集 tabs | `grep 案例广场` → **0 檔** | 低（涉運營） |

### 4.2 假缺口（我方已有，**不得重造**）

| 概念 | 我方實作 | 判據 |
|---|---|---|
| 資產庫 | `assets/route.ts` + `CanvasLibraryPanel` + `LoraLibraryPanel` | 23 檔命中 |
| 批量操作 | `batch-select` 系列 | 6 檔命中 |
| 歷史版本 | 版本樹 + `timeline_restore` | 5 檔命中 |
| 分鏡雙視圖 | 2 檔命中 | — |
| 3D 導演台 | `director-engine` + `director-mini` + `canvas-workstation` | **39,251 行**（AID studio 5,150 行的 7.6 倍） |
| 生成模板 | 45 個 agent 模板 | AID 無對應物 |
| 時間軸後端 | `timeline.ts` op DSL（拆分/修剪/變速/重排/鎖定/分組/轉場/加軌 8 op） | 已在 VPS 上線且活躍 |

---

## 5. 根因：為什麼我方「有 7 步狀態機卻沒有流程條」

刀 1 已交付 **7 步狀態機後端**（`creation-flow-steps.ts` + `CanvasProject.currentStep/episodes` + 三處還原點），但：

1. **`currentStep` 的唯一寫入口 `setProjectMeta` 無 UI 呼叫者**（刀 1 遺留，已知）
2. **前端無任何元件渲染 `currentStep`**（本輪實測：`grep currentStep src/components/` → 0 命中）
3. `CanvasAgentOp` 8 op 無 project 級操作 → agent 也無法驅動

即：**狀態機能存能讀，但沒有任何界面把它顯示出來，也沒有任何入口把它寫進去。** 這是「後端能力已建、前端未接線」的典型缺口，與刀 0 的「貨架長草」同型。

---

## 6. 建議（待暴君裁定，不擅自開工）

| 選項 | 內容 | 工作量 | 對齊宗旨 |
|---|---|---|---|
| **A** | 做 7 步流程條（D1）+ 進度可見化（D2） | 中 | ✅ 直接複用刀 1 已交付的後端，補前端接線 |
| **B** | 做時間軸軌道 UI（D3） | 大 | ⚠️ 用戶已裁定「不做在線剪輯」（Eimu 賣 one-shot）——此項**與宗旨衝突**，除非只做**唯讀回放**（agent 剪好的結果給人看懂，不給人剪） |
| **C** | 做作品列表頁（D4） | 中 | ✅ 與「作品/劇集實體鏈」（刀 1）同源，是其自然入口 |
| **D** | 做案例廣場（D5） | 中 | ❌ 涉運營配套，用戶已裁定「配套不要」 |
| **E** | 全部不做，只補 B 的唯讀版 | 小 | ✅ 最小原創 |

**B 的關鍵區分**：AID 的時間軸是**可編輯**（人在剪片）；若只做**唯讀回放**（agent 產出的 timeline 給人看：哪幾段、多長、什麼轉場），那不違 one-shot 宗旨，且能補上「流水線透明度」——用戶能看懂 agent 剪了什麼。這是**產品語義不同**的同一元件，值得單獨裁定。

---

## 7. 未觀察項聲明

- AID 後端未部署 → 未能觀察：真實資料態的版面（列表密度、長文本處理、大圖載入）、錯誤態、載入態
- AID 登入後的真實互動（含 confirm 門禁、扣費提示）未觀察
- 我方 `/canvas` `/playground` `/assets` 在本輪 3200 埠上渲染為空殼（2 boxes / 0 btns），**原因未查明**——可能是該埠實例的環境差異，非本輪結論基礎。列為未觀察項。
- 未做像素級視覺審核（read-image 遇 gemini 429；改用 DOM 結構提取，精度更高但看不到色彩/質感/字型質地）
