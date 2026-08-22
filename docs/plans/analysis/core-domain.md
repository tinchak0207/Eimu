# 核心資料/目錄域巨型檔案解剖報告

> 範圍：前期重構分析（絕對只讀）。背景：另一 agent 正對同批檔案做 className 設計系統遷移（rgba→token），class 字串可能是半遷移狀態——本報告只看結構，忽略表面噪音。

**總結論（先行）**

| 檔案 | 行數 | churn | 判定 | 工作量 | 一句理由 |
|---|---|---|---|---|---|
| src/lib/use-cases.ts | 5396 | 3 | **NEED** | S | 純資料 5.3k 行，按域分片零風險，直接消最大檔 |
| src/lib/generation-model-catalog.ts | 1331 | 7 | **NEED** | M | 資料＋全域可變狀態機＋40 helper 三合一，最熱檔 |
| src/app/api/v1/openapi.json/route.ts | 1187 | 4 | **SKIP** | — | 單一內聚 spec 字面量，拆了先弄壞讀源碼的測試 |

建議順序：use-cases(S) → 驗證「舊檔變 index」模式 → catalog(M)。三檔皆為 CRLF 行尾，後續實作搬移時注意。

---

## 1. src/lib/use-cases.ts（5396 行，churn 3）

**結論：純資料 + 3 個純查詢函數，零邏輯、零 hook、零 JSX。**

### 1.1 職責清單（3 種）

1. **型別定義**：L8-55 —— 6 個 interface：`UseCaseCitation`(L8)、`UseCasePromptExample`(L13)、`UseCaseFAQ`(L18)、`UseCaseAuthor`(L23)、`RedditEvidence`(L29)、`UseCase`(L37)
2. **基礎案例資料**：L56-5361 `BASE_USE_CASES: UseCase[]` —— **102 條 entry = 17 個域 × 6 條**（anime / architecture / automotive / content / design / ecommerce / education / fashion / finance / gaming / health / marketing / personal / photography / training / travel / ui），每條約 52 行（title / tagline / heroDescription / painPoints / citations / faq / author / relatedSlugs / workflowSteps / fitBoundary / searchVariants）
3. **匯總 + 查詢**：L5363-5371 `USE_CASES` 聚合 6 個 reddit 分片；L5373-5396 `getUseCase` / `relatedUseCases` / `replaceAuthorUrl`（全純函數；`replaceAuthorUrl` 只做 regex 域名替換）

### 1.2 內部結構地圖

| 行區段 | 區塊 |
|---|---|
| L1-6 | imports（6 個 reddit 分片） |
| L8-55 | types（6 interface） |
| L56-5361 | 資料：BASE_USE_CASES（唯一 `^const`，即 L56） |
| L5363-5371 | 匯總常量 USE_CASES |
| L5373-5377 | function getUseCase |
| L5377-5388 | function relatedUseCases |
| L5390-5396 | function replaceAuthorUrl |

### 1.3 耦合

- **匯出**：6 interface + `USE_CASES` + `getUseCase` + `relatedUseCases` + `replaceAuthorUrl`
- **被引用（全 src 反查，共 10 檔）**：
  - 真實消費者 3 檔：`src/app/use-cases/[slug]/page.tsx`（3 函數全用）、`src/app/sitemap.ts`（只用 USE_CASES）、`src/components/UseCaseLinks.tsx`（只用 USE_CASES）
  - 6 個 reddit-* 分片：**全部 `import type { UseCase }`，編譯後擦除，循環引用無害**
  - 1 個測試：`src/lib/reddit-use-cases.test.ts`（只測 reddit 分片，不測 BASE）
- **自身 import**：僅 6 個 reddit 分片，無其他內部模組
- **爆炸半徑極小**；且分片模式（reddit-technical 124 行 / reddit-scale 216 行 / reddit-commerce 108 行…）已存在，此檔只是沒跟上自家慣例

### 1.4 資料 vs 邏輯

純資料（102 條靜態 entry）+ 3 個無狀態查詢函數。無 hooks、無 state、無副作用。

### 1.5 自然切割縫（按域分片 + index 匯總）

```
src/lib/use-cases/types.ts            ← L8-55 六個 interface
src/lib/use-cases/base-ecommerce.ts   ← 對應域的 6 條 entry（約 310 行）
src/lib/use-cases/base-content.ts     ← …（共 17 個 base-<domain>.ts）
src/lib/use-cases/base-design.ts
src/lib/use-cases/base-anime.ts
src/lib/use-cases/base-architecture.ts
src/lib/use-cases/base-automotive.ts
src/lib/use-cases/base-education.ts
src/lib/use-cases/base-fashion.ts
src/lib/use-cases/base-finance.ts
src/lib/use-cases/base-gaming.ts
src/lib/use-cases/base-health.ts
src/lib/use-cases/base-marketing.ts
src/lib/use-cases/base-personal.ts
src/lib/use-cases/base-photography.ts
src/lib/use-cases/base-training.ts
src/lib/use-cases/base-travel.ts
src/lib/use-cases/base-ui.ts
src/lib/use-cases.ts                  ← 保留：import 全部分片 + USE_CASES 聚合 + 3 函數，瘦身到約 40 行
```

- `reddit-use-cases*.ts` 的 `import type { UseCase } from "./use-cases"` 不必動（type-only 循環無害）；新 base 分片改從 `./use-cases/types` 引型別更乾淨
- 舊檔保留匯出面完全不變 → 3 個消費者零改動
- `BASE_USE_CASES` 無外部引用（僅 L5364 一處自用），各分片可直接匯出各自陣列

### 1.6 測試現況

- `src/lib/reddit-use-cases.test.ts`（58 行）：只測 reddit 分片。拆分後測試路徑不動；可選補一條「總數仍 102+、slug 無重複」的匯總契約測試釘住搬移正確性。

### 1.7 風險

1. `relatedSlugs` 跨域引用（如 ecommerce-1 → ecommerce-2）只是字串，不受分片影響——但搬移時別漏條目（用總數+slug 去重驗證）
2. **檔案是 CRLF 行尾**，複製貼上別混 LF（git diff 會整檔標紅）
3. 不要把 `BASE_USE_CASES` 名稱漏搬（無外部引用，可內聯進各分片）

### 1.8 工作量與結論

**S（半天內）｜NEED**：最大檔 + 純機械搬移 + 零 API 變化，churn 3 的合併衝突熱點直接消除。

---

## 2. src/lib/generation-model-catalog.ts（1331 行，churn 7 最熱）

**結論：資料 + 有狀態運行時 + 工具函數三合一，是最需要拆也最要小心拆的。**

### 2.1 職責清單（5 種）

1. **L1-55** 匯入 50+ 個 model ID 常量（`./image-model-ids.js`，含 build-cache-bust 註解 L1-3）
2. **L56-167** 型別與比例常量：`MediaKind`/`AspectRatio`/`ImageResolution`/`VideoResolution`/`PRICING_*` 常量/`GenerationModelDefinition`/`GenerationCapabilityProjection`/`GenerationConfigInput`/`NormalizedGenerationConfig`/`GenerationConfigNormalization` + `COMMON_IMAGE_RATIOS`/`EXTENDED_GEMINI_RATIOS`/`FLUX_RATIOS`/`VIDEO_RATIOS`/`WIDE_VIDEO_RATIOS`/`RUNWAY_VIDEO_RATIOS`/`SEEDANCE_VIDEO_RATIOS`/`SEEDANCE_DURATIONS` 等
3. **L169-831** `GENERATION_MODEL_CATALOG`：**46 個模型定義純資料**（662 行）
4. **L846-990 定價覆寫狀態機**：L922-925 四個模組級可變全域（`effectiveCatalog`/`activeOverrides`/`pricingRevision`/`pricingListeners`）+ `normalizeModelPricingOverrides`/`applyModelPricingOverrides`/`buildEffectiveCatalog`(L948)/`subscribeModelPricing`——admin 改價後由 `pricing-runtime.ts` 灌入、前端 `use-pricing-revision.ts` 以 `useSyncExternalStore` 訂閱即時重繪
5. **L992-1331 查詢/計價**：
   - L992-1180：`generationModel`/`resolveGenerationModelId`/`generationCapabilities`/`normalizeGenerationConfig`/`isSupported*`/`generationPipeline`/`modelBaseName`/`modelAspectRatios`/`modelResolutions`/`modelDurations`/`modelSupportsAudio`/`default*` 系列共 20+ 純函數
   - L1184-1244：`generationCredits`/`generationCoins`/`modelPriceLabel` 計價
   - L1245-1331：`resolveSupported*` 校驗 + `aspectRatioFromImageSize`/`resolutionFromImageSize`/`SUPPORTED_IMAGE_SIZES`/`imageSizeForAspectRatio` 換算

### 2.2 耦合（爆炸半徑最大）

- **匯出 57 個符號；被 54 個檔案引用**：9 個 hooks/lib 核心、7 個 generation-core、14 個 API route（/v1/images、/v1/videos、/v1/models、/admin/model-pricing、/api/generate-* 等）、9 個元件（ModelPicker/PromptInput/PricingClient…）、5 個測試
- 被依賴最重：`generationCoins`/`generationCredits`（計費）、`generationModel`/`generationCapabilities`（能力查詢）、`IMAGE_MODEL_IDS`/`GENERATION_MODEL_IDS`（選單）
- 自身只依賴 `image-model-ids.js`（純常量，無循環）

### 2.3 測試現況

- `src/lib/generation-model-catalog.test.ts`（127 行）：模型順序/能力投影
- `src/lib/generation-model-catalog.pricing.test.ts`（195 行）：覆寫狀態機
- 間接依賴：`generation-core/batch-service.test.ts`、`components/PromptInput.test.ts`、`api/admin/model-pricing/route.test.ts`
- 拆分後：barrel 保路徑，四個測試檔 import 不動，跑一遍回歸即可（注意測試用 `from "./generation-model-catalog.ts"` 帶 .ts 副檔名）

### 2.4 自然切割縫（barrel 保 API）

```
src/lib/generation-model-catalog/types.ts             ← L56-167 全部型別 + 比例常量
src/lib/generation-model-catalog/catalog.ts           ← L169-831 GENERATION_MODEL_CATALOG（46 模型資料）
src/lib/generation-model-catalog/pricing-overrides.ts ← L846-990 狀態機（唯一 state 擁有者）
src/lib/generation-model-catalog/capabilities.ts      ← L992-1180 查詢/投影/normalize
src/lib/generation-model-catalog/pricing.ts           ← L1184-1244 credits/coins/priceLabel
src/lib/generation-model-catalog/resolution.ts        ← L1245-1331 resolve*/imageSize 換算
src/lib/generation-model-catalog.ts                   ← 改為純 re-export barrel（57 個 export）
```

- **關鍵：保留原檔名作 barrel**（`./generation-model-catalog` 路徑不變）→ 54 個 importer 一行不改
- `IMAGE_MODEL_IDS` 等 3 個轉發（L833-835）留在 barrel 或 catalog.ts

### 2.5 風險

1. **最大雷：L922-925 全域狀態必須只有一份擁有者**——若 pricing-overrides 與 capabilities 各持一份 `effectiveCatalog`，admin 改價後計費與選單分裂成兩個真相。capabilities/pricing 必須從 pricing-overrides **單向 import** 查詢函數，不得循環
2. 測試 import 帶 `.ts` 副檔名，barrel 化後路徑仍解析，但需實跑確認
3. `as const` 比例陣列搬動時 readonly 推導別丟
4. L1-3 的 build-cache-bust 註解是為繞 Vercel stale 快取刻意加的，搬移時保留在 catalog.ts（或等效高 churn 檔）

### 2.6 工作量與結論

**M（1 天，含 4 個測試檔回歸）｜NEED**：churn 7 最熱檔，資料/狀態/工具混雜使每次改動都在 1300 行裡撈針；barrel 方案把爆炸半徑壓到零。

---

## 3. src/app/api/v1/openapi.json/route.ts（1187 行，churn 4）

**結論：是單一巨型 spec 物件字面量（L47-1182，1135 行），「生成式」不可行，「分片」收益低。SKIP。**

### 3.1 職責清單（2 種）

1. **L13-45 共享片段**：`RATE_LIMIT_HEADERS` 常量（L17-34）+ `bearerAuth`（L36）+ `authErrorResponses()` 工廠（L39-44）——已是最小複用
2. **L47-1182 `SPEC` 常量 + L1183-1187 `GET()`**（`NextResponse.json(SPEC)` + CORS `*`，5 行）
   - info/servers/security：L48-62
   - **paths L63-673：13 個端點**（/models L64、/images/generations L85、/images/{id} L158、/images/{id}/result L197、/images/edits L259、/uploads L300、/upscale L350、/videos/generations L391、/videos/{id} L445、/videos/{id}/result L484、/batches L532、/batches/{id} L594、/batches/{id}/reconciliation L634）
   - **components L674-1182**：securitySchemes（L675）+ responses（L683）+ 約 30 個 schema（Batch 系列 8 個 L726-873、BatchReconciliation L874、TaskStatus/RequestConfig/TaskArtifact/TaskError/GenerationTask L919-998、ImageResult/VideoResult L999-1017、ModelCapabilities L1018、ModelObject L1037、ModelList L1077、Image/Edits/Upload/Upscale/Video 請求回應 L1085-1182）

### 3.2 為何不能生成式

註解（L8-13）自稱「從代碼派生，不手寫漂移」，但實際是**手寫字面量**：

- 唯一可從 `GENERATION_MODEL_CATALOG` 派生的是 `ModelObject`/`ModelCapabilities` schema；且**未硬編碼任何價格**——`x_coins_per_image`/`x_coins_per_second` 只有 schema 形狀與雙語描述，真實價格由 `/v1/models` route 動態計算（該 route import `generationCoins`），無漂移風險
- 其餘 90% 是端點行為與 Batch/Task 契約的**手寫雙語文件**，程式碼裡沒有第二個真相來源可派生
- 唯一運行時值：`servers[0]` 用 `getSiteUrlFromEnv()`（`dynamic="auto"` 的原因，L6）

### 3.3 耦合

- **0 個程式碼 importer**（route entry point）；`docs/api/page.tsx` 只在運行時 fetch `/api/v1/openapi.json` URL，不受檔案結構影響
- **隱藏耦合（拆分最大阻力）**：`src/app/api/v1/route.test.ts` L170-177 **直接讀此檔源碼字串**，slice `"ModelObject:"` 到 `"ModelList:"` 之間做 regex 斷言（`x_coins_per_image` 不得列必填、`x_coins_per_second` 必須存在）。**任何把 schema 搬去別檔的拆分都會先弄壞這個測試**，必須同步改測試的 read 路徑

### 3.4 若仍要分片（不建議）

`src/lib/openapi/{paths-images,paths-videos,paths-batches,components}.ts` + route.ts 組裝，同步改 route.test.ts 的 read 目標。S 工作量但純導航收益。

### 3.5 風險

1. 測試讀源碼耦合（上述）
2. spec 內 `$ref` 全靠 `#/components/...` 字串，搬檔不影響（同一物件內引用）但重組時易斷
3. `as const` 推導、CRLF 行尾

### 3.6 工作量與結論

**S（若做）｜SKIP**：一個檔案一個職責（輸出 OpenAPI spec）、零邏輯、churn 4 溫和；1135 行是「文件體積」不是「複雜度」，拆開只會讓 $ref 結構跨檔漂流 + 多修一個讀源碼的測試。等端點數再翻倍時才值得分片。

---

## 執行順序與匯總

| 檔案 | 判定 | 工作量 | 爆炸半徑 | 關鍵動作 |
|---|---|---|---|---|
| use-cases.ts | **NEED** | S | 10 檔（3 真消費者） | 17 域分片 + types.ts + 舊檔變 40 行 index |
| generation-model-catalog.ts | **NEED** | M | **54 檔**（barrel 歸零） | 6 模組切分 + 舊檔純 re-export + 狀態機單一擁有者 |
| openapi.json/route.ts | **SKIP** | — | 1 個讀源碼測試 | 不動；churn 翻倍再議 |

先做 use-cases（半天、零風險、立刻砍掉全站最大檔），驗證「舊檔變 index」模式後再用同模式做 catalog（狀態機隔離是唯一技術點）。
