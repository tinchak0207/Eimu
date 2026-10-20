/**
 * 分镜 21 栏位契约（作品 → 剧集 → 分镜的第三层实体，刀 2）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源档：`doc/提示词开发指南.md` §「分镜脚本与画师链路」输出栏位表（本地取证副本 `/tmp/aid-prompt-guide.md:840`）
 * 取得日：2026-09-15
 * 逐字保留：21 个英文 key 的名称**与顺序**（AID 硬规则 §开发要点 1：名称与顺序不可改动）
 * 白名单改写（仅此处）：
 *   1. **剔除第 22 栏 `sceneCode`**。AID v2.1.4 已明令（同档 §开发要点 5）「场景归属使用外层
 *      sceneName，禁止输出 sceneCode」；旧版 22 栏契约的 `sceneCode` 是场次编码（`aid_storyboard
 *      .source_scene_code`），本站无场次编码表，场景归属一律走 Group 节点的 `storyboardScene.sceneName`。
 *   2. AID 用 DB 表承载（`aid_storyboard` + `script_params` JSON）；本站**不建表、不建 migration**，
 *      改用既有 `CanvasNode.metadata`（Group 节点 = 场景外壳，子节点 = 一镜一 shot）——
 *      PRD `docs/symdiff-aid-swallow-prd.md` §刀 2「白名单改写」。
 *   3. AID 的 `image_prompt` / `video_prompt*` / `final_*_id` 不在 21 栏内，属**成片阶段**产物
 *      （画师 agent / 视觉导演 / 后端选片），本站由后续刀（分镜→成片）补，本档不冒充。
 *
 * 空值规则（逐字沿用 AID）：无内容栏位填 `""`，不写 null、不写「无」。
 *
 * 本档为纯常数 + 纯函数，无副作用。消费入口：
 *   - `CanvasNodeMetadata.storyboardShot`（子节点，一镜一 shot）/ `.storyboardScene`（Group 节点）
 *   - 双白名单两处：`layout.ts toNodeMetadata`（读取端）+ `canvas-chat-types.ts
 *     compactMetadataForAgent`（上行压缩端）。漏一端 = 刷新/换装置后 21 栏凭空消失
 *     （2026-09-03 director SVG 事故同型病灶，见记忆 canvas-snapshot-compressor-director-whitelist-fix）。
 *
 * REQ-B2（2026-09-23）：本档多了一个**纯逻辑**依赖 `./asset-scope`（零 IO、不成环），
 * 只为在「专案 cardIds → 锁定卡」这条**生成注入路径**上过一次作用域裁决
 * （`options.scope` 给了才生效；未给＝既有行为逐位不变）。
 *
 * 资产批准闸（2026-09-24）：型别 `ApprovalState` 与判定函式 `isAssetApproved` **单一真源在
 * `./character-cards`**（不另建第二套 shape、不重写第二套判定），本档只负责把它接到
 * **分镜卡引用栏**（`filterApprovedShotCardIds` ＋ `productionFieldsFromContext` 第 ⑥ 条）。
 * 档位语义同样在该档：**只有 `"collaborate"` 会挡**，`preset`/`auto`/未给 mode 一律放行（护城河）。
 */

export { compactStoryboardShot, filterApprovedShotCardIds, indexCardsByName, normalizeStoryboardSceneRef, normalizeStoryboardShot, normalizeStoryboardShots, parseReferenceAssets, resolveReferenceAssetsToCardIds } from "./storyboard-contract/normalize";
export { affectedShotNodesByCardIds, productionFieldsFromContext, storyboardQcContextFromProject, storyboardQcGateArgs, storyboardQcShots } from "./storyboard-contract/bridge";
export { MAX_STORYBOARD_FIELD_CHARS, STORYBOARD_SHOT_FIELDS, STORYBOARD_SNAPSHOT_FIELD_CHARS } from "./storyboard-contract/types";
export type { StoryboardQcBridgeResult, StoryboardQcCardRef, StoryboardQcContext, StoryboardQcContextFields, StoryboardQcFieldSource, StoryboardQcGateArgs, StoryboardQcNodeRef, StoryboardQcProductionFields, StoryboardQcProjectRef, StoryboardQcScopeContext, StoryboardQcShot, StoryboardQcShotNodeMetadata, StoryboardReferenceAssets, StoryboardSceneRef, StoryboardScriptShot, StoryboardShotField } from "./storyboard-contract/types";
