# NODES-PLAN — bridge 节点以 supplier channel 形态进多节点派发（片Y，2026-09-06）

**性质：staging 稿。本片零 src/ 改动、零 VPS 改动。** 研究片 V 裁定的落地稿：现阶段（1-2 节点）不引调度轮子，「伫列」P0 已自给（bridge FIFO＋片K 并发，429 即答/双层超时/失败自愈），P1 缺口是「**节点分发＋档案回收**」——用 gateway 既有 supplier 派发模式（认领/健康软排除/deadline 对帐）换目标地址。

---

## 1. 考古结论（真源档案:行号＋字段形状）

### 1.1 supplier channel registry 真源

`src/lib/supplier-channels.config.ts`（193 行，本地在位，记忆 supplier-channel-registry-oneclick 说的「仍被引用是活的」现场核实成立）：

- L11-15 `RegistryChannelClaim`：`{ modelId, supplierModelId: string|null, kinds: ("image_generate"|"image_edit"|"video_generate")[] }`
- L17-28 `RegistryChannel`：
  ```ts
  label: string;                 // env channel label ＝ DB supplier label
  baseUrlEnv: string;
  apiKeyEnv: string;             // 同时作为 credentialRef
  enabledEnv: string | null;
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  seedPriority: number;          // seed 进 supplier 表的 priority
  sitePriority: number;          // 站点队列 ENV_CHANNEL_PRIORITIES 用
  chatImageModels: string[];
  adapterType?: "openai_images" | "metaso" | "openai_video";
  claims: RegistryChannelClaim[];
  ```
- L30-193 `REGISTRY_CHANNELS`，marker 区 `REGISTRY-ENTRIES-START`(L31)/`END`(L192)，现有 6 条（hublinuxdo/metaso/tokenmix/yyds/cangyuansuanli/drama）。

**消费链（每个接入点都已核实行号）**：

| 环节 | 真源 | 行为 |
|---|---|---|
| env→descriptor | `src/lib/sub2api.ts` L114 `registryChannelToDescriptor` | id=`env:<label>`；`configured = Boolean(base && apiKey)`；L201 并入 `describeEnvChannels` |
| 站点队列优先级 | `src/lib/channel-registry.ts` L39-45 | `ENV_CHANNEL_PRIORITIES` 由 `REGISTRY_CHANNELS.map(c => [c.label, c.sitePriority])` 展开 |
| seed 三表 | `tools/seed-generation-suppliers.ts` L314-356 | `INSERT supplier`（id=`env:<label>`、`adapter_type = registry?.adapterType ?? "openai_images"`、`supply_tier = tier(label)` 直取 registry.tier、`priority = seedPriority`、configuration_json 含 chatImageModels）＋ `supplier_account`（configuration_json 带 `healthPath`）＋ 逐 claim `upsertCapability`（L348 `channelCapabilities`：**claim.modelId 不在 GENERATION_MODEL_CATALOG 会 warn 并跳过，不挡 seed**） |
| 认领派发 | `src/lib/generation-core/scheduler.ts` L68-78 | ORDER BY：`supply_tier` CASE(0/1/2/3) → `priority ASC` → health_status CASE(healthy 0/degraded 1/else 2) → `health_score*quality_score*capability.health_score DESC` → 活跃 lease 负载比 ASC → `latency_ewma_ms ASC` → `unit_cost+capability.cost_units ASC` → `last_selected_at`；`FOR UPDATE SKIP LOCKED` 认领＋supplier_lease |
| 健康软排除 | 同上 L37-45 | supplier/capability/account 三层 `health_status <> 'disabled'`＋`cooldown_until` 过滤（**冷却是排除不是降权；endpoint 级熔断器是入队尾**，`channel-registry.ts` L134-140 prioritizeHealthyEndpoints） |
| adapter 分派 | `src/lib/generation-core/supplier-adapter.ts` L108-135 `requestSupplier` | `if (supplier.adapterType === "metaso")` / `"openai_video"` / filmera / new-api 分流——新增节点 adapter 即在此加一个分支 |
| 对帐协议 | `src/lib/generation-core/worker-service.ts` L54 `protocolOfAdapter` | adapter_type → ProviderProtocol；未映射的同步 adapter 不进异步对帐 |
| deadline 对帐 | `src/lib/generation-core/provider-reconciliation.ts` L33 | reconcile lease（SKIP LOCKED 认领到期 attempt） |
| 健康探测轮子 | `src/lib/generation-core/adobe-health.ts` L37-45 | `SELECT supplier_account JOIN supplier WHERE adapter_type='adobe2api'` → fetch `account.configuration_json.healthPath` → UPDATE account.health_status——**bridge 节点健康探测按此同构** |

### 1.2 bridge 契约真源

`bridge/blender-bridge/README.md`（80 行）＋`src/lib/blender-tools.ts` L11-19 契约节：

- `GET /v1/health` → `{ok, blender_version, gpu:"egl"|"cpu", workdir, queue_depth, concurrency}`
- `POST /v1/execute {script, timeout_ms}` → `200 {ok, artifacts:[{path,bytes,kind:"blend|png|mp4|glb|other"}], scene_summary, stdout_tail, duration_ms, queued, queue_position}` / `500 {ok:false, error, stdout_tail}` / `429 {ok:false, error:"queue_full"}`
- FIFO 严格、timeout SIGKILL 进程组、失败自愈（片K/片O）；桥位址 = `BLENDER_BRIDGE_URL`（默认 `http://127.0.0.1:8765`）
- **单帧 job 才是安全单位**（片L 实锤：桥内多帧循环 render 必 native 崩）→ 节点认领的 capability P0 只有单帧渲染。

### 1.3 片X（Modal）现状与片W 通路

- `deploy-staging/blender-modal/` **不存在**（片X 未落盘）→ Modal 节点的 endpoint/health 对齐全部标 **pending**。
- `deploy-staging/blender-bridge-tunnel/TUNNEL-PLAN.md`（片W，已交付）：ssh2 反向隧道 `forwardIn('127.0.0.1', 8765)`，VPS `127.0.0.1:8765` → 本机桥；**鉴权落桥侧 Bearer**（§5 patch 稿）。本节点注册稿与其天然衔接：VPS gateway 侧看到的本机节点 endpoint 就是 `http://127.0.0.1:8765`＋Bearer token。

---

## 2. 三节点梯队定义

supply_tier 是 scheduler 第一排序键（记忆 supplier-tier-sorting 实锤：priority 再小也翻不过 tier）。梯队映射零发明，直接套四档语义：

| # | 节点 id | 实体 | endpoint（VPS gateway 视角） | tier | seed/site priority | 并发 | 引擎能力 | 状态 |
|---|---|---|---|---|---|---|---|---|
| 1 | `blender-local` | 本机 RTX 5070 Laptop 8GB＋Blender 5.2.1 EGL | `http://127.0.0.1:8765`（片W 反向隧道进来） | `first_party`（本机最快、零边际成本） | 10 | 1（桥并发铁律 `BLENDER_BRIDGE_CONCURRENCY=1`） | eevee＋cycles（gpu:egl） | **可接**（桥已在位，缺 Bearer patch 落位＝片W） |
| 2 | `blender-modal` | Modal L4（片X 交付物） | `https://<modal-app>.modal.run`（URL 待片X token） | `managed_pool`（额度池，按 GPU 分钟计费） | 20 | 2-4（片X 定，pending） | eevee＋cycles | **pending**（片X 落盘后补 endpoint/health 对齐） |
| 3 | `blender-cnb` | CNB 溢出位 | 未定 | `relay` | 30 | — | — | **埋桩**（未来扩展位，只占 tier 档位不注册） |

tier 语义对照：first_party＝自营最快（本机 5070 电费边际成本≈0）；managed_pool＝受管额度池（Modal 按 GPU 分钟付费）；relay＝外部溢出（CNB 按次/按时）。与既有渠道语义逐字同构（adobe2api=first_party、hub/yyds=managed_pool、yyds 曾因误种 relay 整队被绕过——本稿直接种对）。

### 每节点注册字段（RegistryChannel 逐字段同构）

```ts
// blender-local
{
  label: "blender-local",
  baseUrlEnv: "BLENDER_NODE_LOCAL_URL",      // VPS 侧值固定 http://127.0.0.1:8765（片W 裁定一字不改）
  apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",     // 片W §5 桥侧 Bearer patch 落位后的共享 token
  enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
  tier: "first_party",
  seedPriority: 10, sitePriority: 10,
  chatImageModels: [],                        // 本形态无 chat 生图概念，恒空
  adapterType: "blender_bridge",              // 新 enum 值（见 §3）
  claims: [ /* §3.2 */ ],
}
```

完整定义稿见同目录 `blender-node-channel.ts`（registry 同构＋最小 diff 注释）。本地节点 `configured` 判定（sub2api.ts L118 需要 base＋key 同时在）天然要求：**Bearer patch 落位前本节点 configured=false 静默出队**——这是既有机制的诚实行为，不是缺陷（桥现在无鉴权，本来就不该暴露给 gateway）。

---

## 3. 派发语义（单帧 job 按能力标签路由，零调度轮子改动）

### 3.1 能力标签的承载面＝modelId 认领

不引调度轮子的关键：**「能力标签」不新造路由栏位，编进 capability 的 model_id**。scheduler 按 job.modelId 查 capability 候选集，认领即路由：

| 平台 modelId（拟新增进 GENERATION_MODEL_CATALOG） | 引擎 | 典型用途 | 认领节点 |
|---|---|---|---|
| `blender-render-eevee` | Eevee（previz 存活配方 samples=1＋RT off，片F/M） | previz 单帧 | local＋modal |
| `blender-render-cycles` | Cycles | lookdev 单帧 | modal＋local |

多帧（turntable/动画 mp4）P0 **不进 capability**（片L 实锤单帧才安全；分块合成是工具层片M 的活，不走节点派发）。

**与研究片 V 偏好顺序的对齐说明（诚实标注）**：片 V 写「Eevee previz→本机/Modal L4；Cycles lookdev→Modal/本机 5070」（cycles 想优先 Modal）。supply_tier/priority 都是 supplier 行级栏位，表达不了 per-model 反序——现有栏位里 capability 级只有 `health_score`（进排序乘积）与 `cost_units`（进 cost 排序，但污染计费对帐语义，否决）。初版裁定：**两节点统一 local→modal 顺序**（local=first_party 必胜），本机让位的真实杠杆有三，全是既有栏位行为：①lease 占满（并发 1 被占，WHERE 硬排除）②健康轮询写 disabled/短冷却（不可达/伫列饱和）③degraded 只作排序内软惩罚（压不过 tier，验证 case3b 实锤）——1-2 节点下这组行为等效于片 V 的意图（本机闲就本机跑，本机忙/挂才上额度池）。若实测本机 cycles 成瓶颈（8GB VRAM 大 samples），再动 scheduler 的 routingClass 过滤（L50 `firefly_only` 是既有先例，同构加 `cycles_prefers_remote` 类标签）——**该扩展标 pending，归后续执行片拍板**。

### 3.2 claims 形状（seed 端 channelCapabilities 逐字段消化）

```ts
claims: [
  { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
  { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
]
```

kinds 沿用 `"image_generate"`（单帧 PNG 产出，语义同图像生成；不新增 kind enum → seed/adapter/对帐全链零枚举扩散）。**前置依赖（pending，归执行片）**：`GENERATION_MODEL_CATALOG` 需新增两个 modelId 条目（ratios/resolutions 取 square 档），否则 seed 会 warn＋skip（宁少认领不虚报，channelCapabilities 既有行为）。

### 3.3 健康探测＝adobe-health.ts 同构

新轮 `refreshBlenderNodeHealth`（同构 adobe-health.ts L37-45 形状：`WHERE supplier.adapter_type='blender_bridge'` → fetch healthPath → UPDATE account.health_status/configuration_json）：

| bridge /v1/health 观察 | 写入 account | 写入 configuration_json |
|---|---|---|
| ok＋gpu:egl＋queue_depth < 饱和 | healthy | `{gpu:"egl", blender_version, queue_depth, concurrency, observedAt}` |
| ok＋gpu:cpu | degraded（**仅排序内软惩罚**：L71 CASE 第三键，压不过 tier——本机 degraded 仍胜 modal healthy；实跑 case3b 锤） | 同上 |
| ok＋伫列饱和（queue_depth ≥ QUEUE_DEPTH） | 短冷却 `cooldown_until`（⇒ WHERE 层硬排除，流量落 modal；下轮恢复） | 同上 |
| 不可达／非 200 | disabled＋短冷却（硬排除 ⇒ modal 接手） | 保留上次快照 |

**跨档让位的真实杠杆是占线/冷却/disabled，不是 degraded**（scheduler L37-45 WHERE 硬排除 vs L71 排序软惩罚——验证脚本 case2/case3/case3b 实锤）。healthPath 落点：supplier_account.configuration_json.healthPath——本机节点 `v1/health`；**Modal 节点用 `/health` 端点，以片X 实际交付对齐（pending）**。seed 脚本 L338 目前对所有渠道写死 `healthPath: ADOBE2API_HEALTH_PATH ?? "health"`，diff 稿见 blender-node-channel.ts 注释 §D。

### 3.4 requestSupplier 分支（adapter 层）

`supplier-adapter.ts` L108 起 `requestSupplier` 加一个分支（形状同 filmera/metaso 分支）：

1. 取 supplier.base_url＋credential（Bearer，既有 `readCredential`）
2. 构造单帧渲染脚本（Eevee 存活配方 samples=1＋RT off 已在 blender-tools.ts 片M 落地，同构搬运）
3. `POST {base_url}/v1/execute {script, timeout_ms}`（Modal pending：片X 若走 /execute 同契约则零分支，若走自订端点则 per-adapter）
4. 回应分拣复用 `blender-delegate.ts` 既有 collectSceneCardFromArtifacts 的 kind 分拣（png/blend/glb）

### 3.5 档案回收（blend 上云＋PNG 回收；本机节点零变化）

| 节点 | blend 输入 | PNG 回收 |
|---|---|---|
| blender-local | 零变化：脚本 CWD=$BLENDER_WORK，产物落 out/（既有快照 diff 机制，片Q） | 零变化：artifacts 回 path 引用，resolveArtifactUrl 既有通道 |
| blender-modal（pending） | blend 上云：job 请求体附 blend bytes → Modal 卷/临时卷展开（片X 决定卷形态） | 函数返回 bytes：execute 回应 artifacts 内嵌 base64（或片X 定 multipart），adapter 统一转 SupplierGenerationOutput |

**同构闭环的关键裁定**：本机节点的「回 path」与 Modal 节点的「回 bytes」在 adapter 层收敛成同一个 SupplierGenerationOutput——上层（分拣/入库/对帐）不感知节点差异。

### 3.6 deadline 对帐

blender_bridge 属同步 adapter（请求-回应内完成渲染，无异步 task_id 语义）：`protocolOfAdapter` 不加映射（L53 注释明说「同步 adapter 无异步任务语义，不在此列」），provider-reconciliation 自然不管它；job 级 deadline 复用 worker 既有双层超时＋bridge 伫列 timeout 契约（片K），429/connection lost＝瞬态重试（片L 实锤，同类连续 2 次未过停）。

---

## 4. 最小 diff 清单（全部归后续执行片，本稿只出稿）

| # | 档案 | 改动 | 大小 |
|---|---|---|---|
| A | `src/lib/supplier-channels.config.ts` | REGISTRY-ENTRIES 区内加 2 条节点 entry（blender-local/blender-modal；cnb 不注册） | ~50 行 |
| B | `src/lib/generation-core/supplier-adapter.ts` | adapterType enum＋`generateWithBlenderNode` 分支 | ~80 行 |
| C | `src/lib/generation-model-catalog/catalog.ts` | 加 blender-render-eevee/cycles 两条（claims 前置依赖） | ~20 行 |
| D | `tools/seed-generation-suppliers.ts` | supplier_account.configuration_json.healthPath 按 adapter_type 分派（blender_bridge → `v1/health`／Modal `health`） | ~5 行 |
| E | `src/lib/generation-core/blender-node-health.ts`（新） | refreshBlenderNodeHealth，adobe-health.ts 同构 | ~60 行 |
| F | worker 并发/对帐/scheduler | **零改动**（轮子全复用） | 0 |

env 三件套（记忆 supplier-channel-registry-oneclick 事故教训）：`BLENDER_NODE_LOCAL_URL/ _TOKEN/ _ENABLED` 需同时进 VPS `.env.control-plane`（worker seed 用）与 Vercel env（站点队列用）；`.env` 尾换行坑与 `vercel env add` 喂值配方照记忆配方节。

---

## 5. Flamenco 3 埋桩条件（照抄研究片 V 结论）

**触发条件：节点 ≥3 且异构＋需要场景档分发时才买。** 现阶段（1-2 节点）不引调度轮子——supplier channel 派发模式（§3）已覆盖认领/健康/溢出；Flamenco 的增量价值在场景档自动分发与农场级并发调度，1-2 节点下是纯复杂度。本节点注册稿（label/tier/claims/health）与未来 Flamenco 农场节点一一对应，届时把 blender-cnb 档位换成 Flamenco worker pool 即可，注册形状不变。

---

## 6. 本地可验部分与验证

派发判定纯函数（tier→priority→health→负载 排序，scheduler ORDER BY 的本地同构投影）抽在 `blender-node-channel.ts`，验证脚本 `verify-node-dispatch.ts` 本地实跑（证据见回报）。不可本地验的部分（Modal endpoint/health 对齐、VPS seed、隧道实弹）全部标 pending，归片X 落位后的执行片。
