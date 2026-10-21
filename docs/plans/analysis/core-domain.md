# 核心资料/目录域巨型档案解剖报告

> 范围：前期重构分析（绝对只读）。背景：另一 agent 正对同批档案做 className 设计系统迁移（rgba→token），class 字串可能是半迁移状态——本报告只看结构，忽略表面噪音。

**总结论（先行）**

| 档案 | 行数 | churn | 判定 | 工作量 | 一句理由 |
|---|---|---|---|---|---|
| src/lib/use-cases.ts | 5396 | 3 | **NEED** | S | 纯资料 5.3k 行，按域分片零风险，直接消最大档 |
| src/lib/generation-model-catalog.ts | 1331 | 7 | **NEED** | M | 资料＋全域可变状态机＋40 helper 三合一，最热档 |
| src/app/api/v1/openapi.json/route.ts | 1187 | 4 | **SKIP** | — | 单一内聚 spec 字面量，拆了先弄坏读源码的测试 |

建议顺序：use-cases(S) → 验证「旧档变 index」模式 → catalog(M)。三档皆为 CRLF 行尾，后续实作搬移时注意。

---

## 1. src/lib/use-cases.ts（5396 行，churn 3）

**结论：纯资料 + 3 个纯查询函数，零逻辑、零 hook、零 JSX。**

### 1.1 职责清单（3 种）

1. **型别定义**：L8-55 —— 6 个 interface：`UseCaseCitation`(L8)、`UseCasePromptExample`(L13)、`UseCaseFAQ`(L18)、`UseCaseAuthor`(L23)、`RedditEvidence`(L29)、`UseCase`(L37)
2. **基础案例资料**：L56-5361 `BASE_USE_CASES: UseCase[]` —— **102 条 entry = 17 个域 × 6 条**（anime / architecture / automotive / content / design / ecommerce / education / fashion / finance / gaming / health / marketing / personal / photography / training / travel / ui），每条约 52 行（title / tagline / heroDescription / painPoints / citations / faq / author / relatedSlugs / workflowSteps / fitBoundary / searchVariants）
3. **汇总 + 查询**：L5363-5371 `USE_CASES` 聚合 6 个 reddit 分片；L5373-5396 `getUseCase` / `relatedUseCases` / `replaceAuthorUrl`（全纯函数；`replaceAuthorUrl` 只做 regex 域名替换）

### 1.2 内部结构地图

| 行区段 | 区块 |
|---|---|
| L1-6 | imports（6 个 reddit 分片） |
| L8-55 | types（6 interface） |
| L56-5361 | 资料：BASE_USE_CASES（唯一 `^const`，即 L56） |
| L5363-5371 | 汇总常量 USE_CASES |
| L5373-5377 | function getUseCase |
| L5377-5388 | function relatedUseCases |
| L5390-5396 | function replaceAuthorUrl |

### 1.3 耦合

- **汇出**：6 interface + `USE_CASES` + `getUseCase` + `relatedUseCases` + `replaceAuthorUrl`
- **被引用（全 src 反查，共 10 档）**：
  - 真实消费者 3 档：`src/app/use-cases/[slug]/page.tsx`（3 函数全用）、`src/app/sitemap.ts`（只用 USE_CASES）、`src/components/UseCaseLinks.tsx`（只用 USE_CASES）
  - 6 个 reddit-* 分片：**全部 `import type { UseCase }`，编译后擦除，循环引用无害**
  - 1 个测试：`src/lib/reddit-use-cases.test.ts`（只测 reddit 分片，不测 BASE）
- **自身 import**：仅 6 个 reddit 分片，无其他内部模组
- **爆炸半径极小**；且分片模式（reddit-technical 124 行 / reddit-scale 216 行 / reddit-commerce 108 行…）已存在，此档只是没跟上自家惯例

### 1.4 资料 vs 逻辑

纯资料（102 条静态 entry）+ 3 个无状态查询函数。无 hooks、无 state、无副作用。

### 1.5 自然切割缝（按域分片 + index 汇总）

```
src/lib/use-cases/types.ts            ← L8-55 六个 interface
src/lib/use-cases/base-ecommerce.ts   ← 对应域的 6 条 entry（约 310 行）
src/lib/use-cases/base-content.ts     ← …（共 17 个 base-<domain>.ts）
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
src/lib/use-cases.ts                  ← 保留：import 全部分片 + USE_CASES 聚合 + 3 函数，瘦身到约 40 行
```

- `reddit-use-cases*.ts` 的 `import type { UseCase } from "./use-cases"` 不必动（type-only 循环无害）；新 base 分片改从 `./use-cases/types` 引型别更干净
- 旧档保留汇出面完全不变 → 3 个消费者零改动
- `BASE_USE_CASES` 无外部引用（仅 L5364 一处自用），各分片可直接汇出各自阵列

### 1.6 测试现况

- `src/lib/reddit-use-cases.test.ts`（58 行）：只测 reddit 分片。拆分后测试路径不动；可选补一条「总数仍 102+、slug 无重复」的汇总契约测试钉住搬移正确性。

### 1.7 风险

1. `relatedSlugs` 跨域引用（如 ecommerce-1 → ecommerce-2）只是字串，不受分片影响——但搬移时别漏条目（用总数+slug 去重验证）
2. **档案是 CRLF 行尾**，复制贴上别混 LF（git diff 会整档标红）
3. 不要把 `BASE_USE_CASES` 名称漏搬（无外部引用，可内联进各分片）

### 1.8 工作量与结论

**S（半天内）｜NEED**：最大档 + 纯机械搬移 + 零 API 变化，churn 3 的合并冲突热点直接消除。

---

## 2. src/lib/generation-model-catalog.ts（1331 行，churn 7 最热）

**结论：资料 + 有状态运行时 + 工具函数三合一，是最需要拆也最要小心拆的。**

### 2.1 职责清单（5 种）

1. **L1-55** 汇入 50+ 个 model ID 常量（`./image-model-ids.js`，含 build-cache-bust 注解 L1-3）
2. **L56-167** 型别与比例常量：`MediaKind`/`AspectRatio`/`ImageResolution`/`VideoResolution`/`PRICING_*` 常量/`GenerationModelDefinition`/`GenerationCapabilityProjection`/`GenerationConfigInput`/`NormalizedGenerationConfig`/`GenerationConfigNormalization` + `COMMON_IMAGE_RATIOS`/`EXTENDED_GEMINI_RATIOS`/`FLUX_RATIOS`/`VIDEO_RATIOS`/`WIDE_VIDEO_RATIOS`/`RUNWAY_VIDEO_RATIOS`/`SEEDANCE_VIDEO_RATIOS`/`SEEDANCE_DURATIONS` 等
3. **L169-831** `GENERATION_MODEL_CATALOG`：**46 个模型定义纯资料**（662 行）
4. **L846-990 定价覆写状态机**：L922-925 四个模组级可变全域（`effectiveCatalog`/`activeOverrides`/`pricingRevision`/`pricingListeners`）+ `normalizeModelPricingOverrides`/`applyModelPricingOverrides`/`buildEffectiveCatalog`(L948)/`subscribeModelPricing`——admin 改价后由 `pricing-runtime.ts` 灌入、前端 `use-pricing-revision.ts` 以 `useSyncExternalStore` 订阅即时重绘
5. **L992-1331 查询/计价**：
   - L992-1180：`generationModel`/`resolveGenerationModelId`/`generationCapabilities`/`normalizeGenerationConfig`/`isSupported*`/`generationPipeline`/`modelBaseName`/`modelAspectRatios`/`modelResolutions`/`modelDurations`/`modelSupportsAudio`/`default*` 系列共 20+ 纯函数
   - L1184-1244：`generationCredits`/`generationCoins`/`modelPriceLabel` 计价
   - L1245-1331：`resolveSupported*` 校验 + `aspectRatioFromImageSize`/`resolutionFromImageSize`/`SUPPORTED_IMAGE_SIZES`/`imageSizeForAspectRatio` 换算

### 2.2 耦合（爆炸半径最大）

- **汇出 57 个符号；被 54 个档案引用**：9 个 hooks/lib 核心、7 个 generation-core、14 个 API route（/v1/images、/v1/videos、/v1/models、/admin/model-pricing、/api/generate-* 等）、9 个元件（ModelPicker/PromptInput/PricingClient…）、5 个测试
- 被依赖最重：`generationCoins`/`generationCredits`（计费）、`generationModel`/`generationCapabilities`（能力查询）、`IMAGE_MODEL_IDS`/`GENERATION_MODEL_IDS`（选单）
- 自身只依赖 `image-model-ids.js`（纯常量，无循环）

### 2.3 测试现况

- `src/lib/generation-model-catalog.test.ts`（127 行）：模型顺序/能力投影
- `src/lib/generation-model-catalog.pricing.test.ts`（195 行）：覆写状态机
- 间接依赖：`generation-core/batch-service.test.ts`、`components/PromptInput.test.ts`、`api/admin/model-pricing/route.test.ts`
- 拆分后：barrel 保路径，四个测试档 import 不动，跑一遍回归即可（注意测试用 `from "./generation-model-catalog.ts"` 带 .ts 副档名）

### 2.4 自然切割缝（barrel 保 API）

```
src/lib/generation-model-catalog/types.ts             ← L56-167 全部型别 + 比例常量
src/lib/generation-model-catalog/catalog.ts           ← L169-831 GENERATION_MODEL_CATALOG（46 模型资料）
src/lib/generation-model-catalog/pricing-overrides.ts ← L846-990 状态机（唯一 state 拥有者）
src/lib/generation-model-catalog/capabilities.ts      ← L992-1180 查询/投影/normalize
src/lib/generation-model-catalog/pricing.ts           ← L1184-1244 credits/coins/priceLabel
src/lib/generation-model-catalog/resolution.ts        ← L1245-1331 resolve*/imageSize 换算
src/lib/generation-model-catalog.ts                   ← 改为纯 re-export barrel（57 个 export）
```

- **关键：保留原档名作 barrel**（`./generation-model-catalog` 路径不变）→ 54 个 importer 一行不改
- `IMAGE_MODEL_IDS` 等 3 个转发（L833-835）留在 barrel 或 catalog.ts

### 2.5 风险

1. **最大雷：L922-925 全域状态必须只有一份拥有者**——若 pricing-overrides 与 capabilities 各持一份 `effectiveCatalog`，admin 改价后计费与选单分裂成两个真相。capabilities/pricing 必须从 pricing-overrides **单向 import** 查询函数，不得循环
2. 测试 import 带 `.ts` 副档名，barrel 化后路径仍解析，但需实跑确认
3. `as const` 比例阵列搬动时 readonly 推导别丢
4. L1-3 的 build-cache-bust 注解是为绕 Vercel stale 快取刻意加的，搬移时保留在 catalog.ts（或等效高 churn 档）

### 2.6 工作量与结论

**M（1 天，含 4 个测试档回归）｜NEED**：churn 7 最热档，资料/状态/工具混杂使每次改动都在 1300 行里捞针；barrel 方案把爆炸半径压到零。

---

## 3. src/app/api/v1/openapi.json/route.ts（1187 行，churn 4）

**结论：是单一巨型 spec 物件字面量（L47-1182，1135 行），「生成式」不可行，「分片」收益低。SKIP。**

### 3.1 职责清单（2 种）

1. **L13-45 共享片段**：`RATE_LIMIT_HEADERS` 常量（L17-34）+ `bearerAuth`（L36）+ `authErrorResponses()` 工厂（L39-44）——已是最小复用
2. **L47-1182 `SPEC` 常量 + L1183-1187 `GET()`**（`NextResponse.json(SPEC)` + CORS `*`，5 行）
   - info/servers/security：L48-62
   - **paths L63-673：13 个端点**（/models L64、/images/generations L85、/images/{id} L158、/images/{id}/result L197、/images/edits L259、/uploads L300、/upscale L350、/videos/generations L391、/videos/{id} L445、/videos/{id}/result L484、/batches L532、/batches/{id} L594、/batches/{id}/reconciliation L634）
   - **components L674-1182**：securitySchemes（L675）+ responses（L683）+ 约 30 个 schema（Batch 系列 8 个 L726-873、BatchReconciliation L874、TaskStatus/RequestConfig/TaskArtifact/TaskError/GenerationTask L919-998、ImageResult/VideoResult L999-1017、ModelCapabilities L1018、ModelObject L1037、ModelList L1077、Image/Edits/Upload/Upscale/Video 请求回应 L1085-1182）

### 3.2 为何不能生成式

注解（L8-13）自称「从代码派生，不手写漂移」，但实际是**手写字面量**：

- 唯一可从 `GENERATION_MODEL_CATALOG` 派生的是 `ModelObject`/`ModelCapabilities` schema；且**未硬编码任何价格**——`x_coins_per_image`/`x_coins_per_second` 只有 schema 形状与双语描述，真实价格由 `/v1/models` route 动态计算（该 route import `generationCoins`），无漂移风险
- 其余 90% 是端点行为与 Batch/Task 契约的**手写双语文件**，程式码里没有第二个真相来源可派生
- 唯一运行时值：`servers[0]` 用 `getSiteUrlFromEnv()`（`dynamic="auto"` 的原因，L6）

### 3.3 耦合

- **0 个程式码 importer**（route entry point）；`docs/api/page.tsx` 只在运行时 fetch `/api/v1/openapi.json` URL，不受档案结构影响
- **隐藏耦合（拆分最大阻力）**：`src/app/api/v1/route.test.ts` L170-177 **直接读此档源码字串**，slice `"ModelObject:"` 到 `"ModelList:"` 之间做 regex 断言（`x_coins_per_image` 不得列必填、`x_coins_per_second` 必须存在）。**任何把 schema 搬去别档的拆分都会先弄坏这个测试**，必须同步改测试的 read 路径

### 3.4 若仍要分片（不建议）

`src/lib/openapi/{paths-images,paths-videos,paths-batches,components}.ts` + route.ts 组装，同步改 route.test.ts 的 read 目标。S 工作量但纯导航收益。

### 3.5 风险

1. 测试读源码耦合（上述）
2. spec 内 `$ref` 全靠 `#/components/...` 字串，搬档不影响（同一物件内引用）但重组时易断
3. `as const` 推导、CRLF 行尾

### 3.6 工作量与结论

**S（若做）｜SKIP**：一个档案一个职责（输出 OpenAPI spec）、零逻辑、churn 4 温和；1135 行是「文件体积」不是「复杂度」，拆开只会让 $ref 结构跨档漂流 + 多修一个读源码的测试。等端点数再翻倍时才值得分片。

---

## 执行顺序与汇总

| 档案 | 判定 | 工作量 | 爆炸半径 | 关键动作 |
|---|---|---|---|---|
| use-cases.ts | **NEED** | S | 10 档（3 真消费者） | 17 域分片 + types.ts + 旧档变 40 行 index |
| generation-model-catalog.ts | **NEED** | M | **54 档**（barrel 归零） | 6 模组切分 + 旧档纯 re-export + 状态机单一拥有者 |
| openapi.json/route.ts | **SKIP** | — | 1 个读源码测试 | 不动；churn 翻倍再议 |

先做 use-cases（半天、零风险、立刻砍掉全站最大档），验证「旧档变 index」模式后再用同模式做 catalog（状态机隔离是唯一技术点）。
