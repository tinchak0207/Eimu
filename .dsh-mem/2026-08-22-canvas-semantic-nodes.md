# 2026-08-22 畫布語義節點（prompt/reference）— 記憶筆記

> 注意：本 subagent 沙箱無法寫 ~/.codex/memories（EROFS）。此筆記按 AGENTS.md 記憶規則寫於 workspace .dsh-mem/，請 orchestrator 收集後轉寫到正式記憶位置。

## 架構決策（下次沿用）
- **角色枚舉唯一 owner**：`src/lib/image-types.ts` 的 `ReferenceImageRole`。本次補了運行時清單 `REFERENCE_IMAGE_ROLE_VALUES` + 收斂函式 `toReferenceImageRole`（未知值→general）+ 判定 `isReferenceImageRole`。畫布/API 一律引用，不建第二套枚舉。
- **新節點類型**：`CanvasNodeType.Prompt`（提示詞備忘，文本前綴注入）與 `CanvasNodeType.Reference`（帶角色參考圖）。metadata 只擴展 `referenceRole?: ReferenceImageRole` 一個字段，不另立類型樹。
- **純邏輯層** `src/lib/canvas/semantic-nodes.ts`：`resolveGenerationInputs`（沿入邊收集 prompt 文本+reference 圖）、`composeGenerationPrompt`（前綴合成）、`mergeGenerationReferences`（手動 @引用優先、nodeId/url 去重）。手動 UI 與 agent run_generation 共用同一套 → 接線語義保證一致。
- **角色進生成請求的路徑**：CanvasEmbed → POST /api/canvas/generate（新欄位 `reference_images: [{url, role, name}]`）→ 該 route 把非 general 角色組成 `workflow.referenceImages` → generate-images 的既有 `buildWorkflowPrompt` 把「name as role」寫進最終 prompt。復用 workflow 鏈路，零新上游契約。全 general 時不帶 workflow 欄位（請求位元組與舊路徑完全一致，零行為漂移）。
- **agent add_node 自動支持**：`CANVAS_NODE_DEFAULT_SIZE` 加兩條預設 + `toNodeType` 收斂（NODE_TYPES 來自 enum values，新枚舉值自動可用）。update_node 的 metadata patch 路徑本來就透傳 `referenceRole`。

## 向後兼容
- 舊 CanvasProject 載入：metadata 無 referenceRole → undefined → 讀取端 `toReferenceImageRole(undefined)` = general。
- `toNodeMetadata`（layout.ts）只收合法角色值，非法丟棄。
- 舊請求不帶 reference_images → 空陣列 → 行為不變。

## Vercel 部署探針修正（記憶更正）
- **舊記憶的「/v1/model-status 200 = 新構建」探針已失效**：model-status 現在掛在 `/api/v1/model-status` 且需要 biz key，裸 GET 回 404 HTML 是預期行為，不是 stale 構建信號。
- **新探針**：POST `/api/canvas/generate` 裸請求 → 401（缺 auth header，證明路由活著且代碼執行到認證檢查）；404 HTML 才是路由缺失/stale。
- 部署 token 位置：`.tmp-home/.local/share/com.vercel.cli/auth.json`（workspace 持久）。部署命令：`HOME=<workspace>/.tmp-home XDG_CACHE_HOME=<workspace>/.tmp-home/.cache npx vercel deploy --prod --yes`。全局 vercel CLI（無 HOME override）會報「No existing credentials found」。

## 測試慣例
- 全量測試有 1 個**既有失敗**：`src/components/PromptInput.test.ts` 的「no settings row can widen the card」（斷言 ImagePlayground.tsx className，與畫布無關）。用 git worktree baseline 驗證過 HEAD 上就失敗（`git worktree add .baseline-check HEAD && ln -s node_modules .baseline-check/node_modules`）。其餘 778/779 全綠。

## 部署
- 部署 URL：https://image-fmmqb4t0o-su-pixs-projects.vercel.app（Production Ready），alias https://www.eimu.dev。
