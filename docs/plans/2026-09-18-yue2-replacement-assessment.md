# 生音乐管线主力替换成 YuE2 的可行性研判（可拍板文件）

- 日期：2026-09-18
- 性质：**研判与证据搜集，无任何程式码修改、无部署、无 commit**
- 范围：只回答「要不要把现任音乐生成主力（Lyria 3.5 / FlowMusic2API）换成 YuE2（Modal 自托管）」，含成本、授权、harness 缺口
- 撰写时的 repo 状态：工作区**已有未提交的 YuE2 第三通路实作**（另一片并发产物，见 §5 冲突回报）

---

## 1. 一句话结论

**技术上可换、成本上要量、法律上「产品化」这一步现在走不通**：YuE2 的白盒 ABC 乐谱与翻唱是现任完全没有的真能力，但权重是 **CC BY-NC 4.0**，而 Eimu 是付费套餐＋B 端 API key 的商业服务——**在拿到商业授权之前，YuE2 只可以当非商用内部 POC／创作辅助，不可以当产品主力或对外通路的生成引擎**（连「混合路由」把 YuE2 产出交付给付费用户也不行）。**建议：先做 A（第二通路＋非商用 POC），把 B/C 卡在商用授权这一格上。**

---

## 2. 能力矩阵：Lyria 3.5（FlowMusic2API 现任主力） vs YuE2（Modal）

> 记法：`[现]`＝现场程式码／官方文档已验；`[背]`＝片 C spec 提供的背景事实（未附上游连结，未独立复核）；`未证`＝目前没有可复现证据。

| 维度 | 现任 Lyria 3.5（FlowMusic2API） | YuE2（Modal） |
|---|---|---|
| **人声语言覆盖** | 多语言＋时间戳歌词 `[背]`；歌词语言跟随 prompt 语言 `[现]`（`src/lib/music-tools.ts:310`）。具体语言清单 `未证` | 官方 HF repo tag `zh`/`en`；官方 demo 含 Mandarin pop→English jazz 迭代案例 `[现]`（README「The Last Train … from Mandarin pop to English jazz」）。完整语言覆盖表 `未证` |
| **单曲时长与可延伸性** | 整歌实测 **162–182s**（成品长度不受 prompt 约束）`[现]`（`src/lib/music-prompt-director.ts:77-78`、`skills/music-director/SKILL.md:44`）；延伸（extend）在自托管路径**无**接口 `未证` | **无任何时长控制栏位**——官方 API 只有 `style/lyrics/cot/abc/seed` `[现]`（README Quick start 表）；长度由模型决定，`save_artifacts` 的 `truncated` flag 表示撞 token 上限 `[现]`（`docs/generation.md:55`）。可延伸性 `未证` |
| **结构控制** | 时间戳 `[0:00 - 0:10]` 在 FlowMusic2API **无效**（上游把 `:` 换成空格）`[现]`（`music-prompt-director.ts:207` 注释、`skills/music-director/SKILL.md:44`）；带歌词标签走「保版面」分支（3000 runes），但上游自行加写段落、产 A/B 两版 `[现]` | **ABC 记谱法乐谱＝显式乐器级控制**：`cot="full"` 先产 melody-and-chord plan，`abc=` 可注入自备乐谱 `[现]`（README `cot` 表、`docs/editing.md`）。时间戳式结构控制**不存在** `[现]`（官方文档全篇无此介面） |
| **image-to-music** | **现任主力通路上不支援**：`reference_images` 仅 Gemini 直连生效，FlowMusic2API 忽略并如实标注 `[现]`（`src/lib/music-tools.ts:322-323`、`:459-464`）。Gemini 直连支援 ≤10 张 `[现]`（`src/lib/music-lyria.ts:37` `LYRIA_MAX_IMAGES = 10`） | **不支援**：官方 README／`docs/generation.md`／`docs/covers.md` 全篇无图像输入介面 `[现]`；工作区工具文案亦已如实标注 `[现]`（`music-tools.ts:462-463`） |
| **白盒可编辑性** | **无**：黑箱输出音档 `[现]` | **最强项**：`score.abc`（可人工／agent 改和声、旋律、速度、曲式后重render）、`plan.json`、semantic tokens、`latent.npy`、`timings`、model identities 全部落盘 `[现]`（`docs/generation.md:55`、README「Edit a composition」） |
| **翻唱／风格重构** | 无专用能力，只能 prompt 逼近 `未证` | **零样本翻唱**：SheetSage2 扒谱 → 自备 abc ＋ `cot="melody"` → 换风格；官方数字 **0.647 CLEWS mAP**（948 首），无乐谱时仅 0.006 `[现]`（README「Zero-shot covers」） |
| **输出规格** | 本路径回 **m4a**（上游公网 URL）`[背]`；MIME 表已补 `.m4a/.aac/.ogg/.flac/.opus` `[背]`（记忆 `audio-ingest-404-and-audio-card-0911`，09-11 已部署） | **48 kHz 立体声、无量化** `[现]`（README「Quick start」）；交付格式 FLAC `[现]`（工作区契约 `mime_type:"audio/flac"`，`src/lib/music-yue2.ts:13`）；24-bit 具体位元深 `[背]`／`未证` |
| **并发能力** | 账号池多 token 负载均衡 `[背]`（记忆 `music-gen-frontier-2026-09.md:80`）。实际并发上限 `未证` | **一次一请求** `[现]`（`docs/generation.md:3`「one request at a time」）；Modal 侧 `max_containers` 可开但上游仍是单请求序列 `[现]` |
| **冷启／暖启延迟** | 自托管 VPS 常驻容器，**暖启 = 0**；单次生成 162–182s `[现]` | 暖启：生成分钟级、`YUE2_TIMEOUT_MS` 设 600s `[现]`（`music-yue2.ts:66`）；冷启含 `timing.model_load_ms`（上游自报）`[现]`。**Modal 实测值 pending**：`deploy-staging/yue2-modal/` 目前只有 `yue2_common.py`，`out/` 为空、零 probe log（2026-09-18 21:2x 现场）→ **本文件不采用任何 4090 数字冒充 Modal** |
| **凭证与依赖** | `FLOWMUSIC2API_URL`＋`FLOWMUSIC2API_KEY`（VPS `/opt/agent-harness/.env` 已配置，实测 key 名存在）`[现]`；**上游 FlowMusic bearer 约每 1h 过期** `[背]` | `YUE2_MODAL_ENDPOINT`＋`YUE2_HMAC_SECRET`（HMAC-SHA256 签名）`[现]`；依赖 Modal 帐号＋HF 权重下载（7.26 GB）`[现]` |
| **ops 负担** | **已知痛点**：bearer 过期需暴君重登取 Supabase 分片 cookie → 解 base64 提取 `refresh_token/provider_token/provider_refresh_token` → admin login 换 JWT → `PUT /api/tokens/1` 全量替换 → 验活 `[背]`（记忆 `music-gen-frontier-2026-09.md:113`） | 无短命凭证；但新增 Modal app 维运、GPU 配额、权重版本固定（`revision`/`vae_revision` 需 pin 以求可比）`[现]`（`docs/generation.md:57`） |
| **每首成本** | 官方 Lyria 标价 **$0.08/首** `[背]`（记忆 `music-gen-frontier-2026-09.md:19`）；**实走 FlowMusic credit 池**（帐号 10555 credits，plus tier）`[背]` → 现金边际成本 ≈ $0，credit 货币等值 `未证` | **pending 实测**（GPU 秒数未定）；Modal 费率已抓（§3）。以 A100 40GB 暖机边际估 **$0.051/首**（算式见 §3） |
| **授权** | Google 专有 API／FlowMusic2API 自托管（MIT，逆向封装上游，可能封号）`[背]`；Lyria 产出商用条款 `未证` | **权重 CC BY-NC 4.0（非商用）＋ individual creator 例外**；**公司商用需另谈授权** `[现]`（§4 逐字） |

### 2.1 现场与规格书叙述的冲突（必须回报）

1. **「Lyria 的 image-to-music 是 MV 分镜图→乐 现役卖点」与现场不符。** 现行主力是 FlowMusic2API，该通路**忽略** `reference_images`，工具回执强制 `reference_image_count: 0` 并附 `reference_images_note: "FlowMusic2API 通路暂不支持参考图（图生乐），本次已忽略"`（`src/lib/music-tools.ts:459-464`）。也就是说：**只要 VPS 上 `FLOWMUSIC2API_URL` 有配置（实测已配置），image-to-music 就是停用状态**，「现役卖点」实际上取决于是否另走 Gemini 直连。
2. **VPS 同时配置了 `GEMINI_API_KEY` 与 `FLOWMUSIC2API_URL`**（`/opt/agent-harness/.env` key 名实测存在）；因工具层是「FlowMusic 已配置即优先」，`GEMINI_API_KEY` 的存在**不会**让 image-to-music 自动生效。此为推论（读码得出），`未证` 是否有其他呼叫端直连 Gemini。
3. **接入点清单已在工作区被超前落地**：YuE2 第三通路（`src/lib/music-yue2.ts`、`music-tools.ts` 三分支、`music-prompt-director.ts` 的 `yue2` channel、`deploy-staging/yue2-modal/`）为**未提交**的并发产物（`git status` 显示 `?? src/lib/music-yue2.ts`、` M src/lib/music-tools.ts`、` M src/lib/music-prompt-director.ts`）。本文件 §5 的「现有」行号以**当下工作区**为准，若该片后续续改，行号会漂移。

---

## 3. 成本模型

### 3.1 Modal 官方现行费率（已抓，非凭记忆）

来源：**https://modal.com/pricing**（2026-09-18 抓取）

| GPU | 每秒 | 折算每小时 |
|---|---|---|
| Nvidia B300 | $0.001972 /s | $7.10 |
| Nvidia B200 | $0.001736 /s | $6.25 |
| Nvidia H200 SXM | $0.001261 /s | $4.54 |
| Nvidia H100 SXM5 | $0.001097 /s | $3.95 |
| Nvidia RTX PRO 6000 | $0.000842 /s | $3.03 |
| Nvidia A100 80 GB | $0.000694 /s | $2.50 |
| **Nvidia A100 40 GB** | **$0.000583 /s** | **$2.10** |
| Nvidia L40S | $0.000542 /s | $1.95 |
| Nvidia A10 | $0.000306 /s | $1.10 |
| Nvidia L4 | $0.000222 /s | $0.80 |
| Nvidia T4 | $0.000164 /s | $0.59 |

其他抓到的事实（同页）：
- CPU：**$0.0000131 / core / s**（每容器最低 0.125 core）
- 记忆体：**$0.00000222 / GiB / s**
- Volumes：$0.09 / GiB / 月（含 1 TiB/月免费）
- 区域选择＝**1.15–1.75x** 基础价；非抢占（non-preemptible）＝**3x**
- Starter 方案含 **$30/月** 免费算力；Team 含 **$100/月**
- 计费原则原文：「You never pay for idle resources — just actual compute time, by the CPU cycle.」

来源：**https://modal.com/docs/guide/cold-start**，章节「Keep containers warm for longer with scaledown_window」（2026-09-18 抓取，逐字）：
> 「Modal containers will remain idle for a short period before shutting down. By default, the maximum idle time is **60 seconds**. You can configure this by setting the `scaledown_window` on the `@function` decorator. The value is measured in seconds, and it can be set **anywhere between two seconds and twenty minutes**.」
> 「Increasing the `scaledown_window` reduces the chance that subsequent requests will require a cold start, although **you will be billed for any resources used while the container is idle** (e.g., GPU reservation or residual memory occupancy).」

同页冷启原文：「The time taken for a container to become warm and ready for inputs can **range from seconds to minutes**.」

### 3.2 显式假设（全部列出；未证者标明）

| 代号 | 假设 | 值 | 证据状态 |
|---|---|---|---|
| A1 | GPU 型别 | Modal **A100 40 GB**（40 GB ≥ 官方 24 GB 底线） | 费率 `[现]` |
| A2 | 每首 GPU 秒 `g` | 以 RTF 0.42 推算：180s 成品 → **75.6 GPU-s**（124.9s 成品 → 52.4 GPU-s） | **未证**：RTF 0.42 来自片 C spec 背景（4090 实测），**非** Modal 数字；片 A `deploy-staging/yue2-modal/out/` 尚无结果档 |
| A3 | CPU＋记忆体配置 | 假设 4 vCPU ＋ 16 GiB → `r_cm = 4×0.0000131 + 16×0.00000222 = $0.00008792 /s` | **未证**：Modal app 未落地，配置未定；该项约占 GPU 成本 15% |
| A4 | 冷启 `C` | **90 s**（容器 boot ＋ 7.26 GB 权重载入 ＋ 上卡） | **未证**：官方只说「seconds to minutes」；权重实测 7,261,441,640 bytes（HF API，含全部 artifacts 7.30 GB）`[现]` |
| A5 | `scaledown_window` `s` | **60 s**（官方默认） | `[现]` |
| A6 | 批次粒度 `k` | 每个「暖窗」内连续生成 k 首 | 情境参数 |
| — | 合成费率 | `r_tot = A1 + A3 = $0.00067092 /s` | 推算 |

### 3.3 算式

```
每首成本(k) = (C + k·g + s) · r_tot / k
```

代入 `C=90`、`g=75.6`、`s=60`、`r_tot=0.00067092`：

| k（每暖窗首数） | 每窗 GPU+CPU 秒 | 每首成本 | 对比现任 $0.08/首 |
|---|---|---|---|
| 1（每首都冷启） | 225.6 s | **$0.1514** | 贵 89% |
| 2 | 301.2 s | **$0.1010** | 贵 26% |
| 3 | 376.8 s | **$0.0843** | 贵 5% |
| **4** | 452.4 s | **$0.0759** | **便宜 5%** |
| 8 | 754.8 s | **$0.0633** | 便宜 21% |
| 16 | 1359.6 s | **$0.0570** | 便宜 29% |

**损益平衡（纯算力，对 $0.08/首）**：
```
0.08k = (150 + 75.6k) × 0.00067092
0.08k = 0.100638 + 0.050722k
k = 0.100638 / 0.029278 ≈ 3.4
```
→ **每个暖窗内至少 4 首，YuE2 的 Modal 算力才比 Lyria 官方标价便宜。**

暖机边际（不摊冷启、不摊空窗）：`75.6 × 0.00067092 = **$0.0507/首**`。

### 3.4 「常温待命」策略的损益平衡点

`min_containers=1`（A100 40GB 24/7 常驻）：
```
GPU      : 2,592,000 s/月 × $0.000583   = $1,511.1
CPU+记忆 : 2,592,000 s/月 × $0.00008792 = $  227.9
合计                                      ≈ $1,739 / 月
损益平衡 = 1,739 ÷ 0.08 ≈ 21,700 首/月（≈ 724 首/日）
```
若 Modal 对「idle 期间的记忆体快照」减免（官方只说「会被计费」，细则 `未证`），此门槛可再下降；纯 GPU 口径门槛为 `1,511.1 ÷ 0.08 ≈ 18,900 首/月`。

### 3.5 GPU 型别敏感度（暖机边际／每首，k=1 冷启）

| GPU | 暖机边际/首 | k=1 冷启/首 |
|---|---|---|
| A10（24 GB，刚好卡底线） | $0.0298 | $0.0890 |
| L40S（48 GB） | $0.0476 | $0.1421 |
| A100 40 GB | $0.0507 | $0.1514 |
| A100 80 GB | $0.0591 | $0.1764 |
| H100 SXM5 | $0.0896 | $0.2673 |

注意：A10 只有 24 GB，正好落在官方「24 GB VRAM」底线上，且其 BF16 算力远低于 4090 → **RTF 必然劣于 0.42**，上表 A10 栏位偏乐观（`未证`）。

### 3.6 对照现任「$0.08/首 ＋ bearer 重录人工成本」

- **现任现金边际成本 ≈ $0**：实际走 FlowMusic credit 池（帐号 10555 credits），并非逐首付现；$0.08 是官方 Lyria 标价，仅堪作机会成本锚点。credit 的货币等值 `未证`。
- **现任真实成本在人工**：FlowMusic bearer 约每 1h 过期，救法需暴君本人重登取 Supabase 分片 cookie 再重录账号池（`[背]` 记忆 `music-gen-frontier-2026-09.md:113`）。每次事故约 10–15 分钟；每日 1 次 ≈ **5–7.5 小时/月**的暴君时间。这笔人工无法用 $/首 定价，请暴君自评。
- **结论**：**用「省钱」当换主力的理由不成立**（现任现金 ≈ $0、YuE2 在稀疏请求下反而贵）。换主力的正当理由是**能力**（白盒乐谱／翻唱）与**消除 bearer 维运**，成本只在高批量（≥4 首/暖窗）或高月量（≥21,700 首/月常驻）时才站得住。

---

## 4. 授权与合规（本节最重要）

### 4.1 逐字引用

**来源 A**：`https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/MODEL_LICENSE`（2026-09-18 抓取，逐字）

> 「The YuE2-3B, YuE2-Vae and YuE2-Vae-legacy checkpoint weights are licensed under **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**: https://creativecommons.org/licenses/by-nc/4.0/  Individual creator permission and academic-use terms are set out below.」

> 「In addition to the CC BY-NC 4.0 license below, the YuE2 model licensors grant personal users, content creators and musicians **acting in an individual capacity** permission to use the model weights free of charge to generate outputs, and to publish, distribute, sell, license or otherwise monetize those outputs, subject to the responsible-use conditions below.」

> 「For these individual creative activities, the model licensors waive the NonCommercial restriction to the extent necessary. These users do not need a separate commercial license from, or owe license fees or royalties to, the model licensors for this use or for monetizing their outputs. **This includes distributing or licensing their outputs to clients and publishing them on commercial platforms.**」

> 「**The individual creator permission does not authorize commercial use of the model weights by companies. Companies wishing to use the model weights commercially should contact ryuanab@connect.ust.hk to discuss a commercial license**: https://github.com/multimodal-art-projection/YuE#contact」

> 「This permission concerns generating and using outputs; **it does not extend to commercial redistribution or sale of the model weights.** All other applicable CC BY-NC 4.0 conditions continue to apply to the weights.」

> 「Academic use … Students, educators, researchers and academic institutions may use YuE2 free of charge for **non-commercial research and education** under the CC BY-NC 4.0 license below. **This academic-use provision does not itself grant commercial-use rights to an institution.** An academic user creating work in an individual capacity may rely on the individual creator permission above.」

**来源 B**：`https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/README.md` §License（2026-09-18 抓取，逐字）

> 「| **Personal users, content creators, and musicians** | Free to use YuE2 and monetize generated outputs, with **no fees or royalties payable to us**. |
> | **Academic research and education** | Free for **non-commercial use**. |
> | **Commercial use by companies** | [Contact us](#contact) to discuss a commercial license for the model weights. |」

> 「**Code, agent skill, and documentation:** [Apache 2.0](LICENSE). **Model weights:** [CC BY-NC 4.0 with additional creator permission](MODEL_LICENSE).」

### 4.2 对 Eimu（付费套餐 ＋ B 端 API key）的结论

前提事实（`[背]`，来自任务背景与 repo）：Eimu 是**付费产品**（卖套餐）＋**对外贩售 B 端 API key**（明文在 `.env.biz-key`，调 `https://image.tinchak0207.xyz/v1/*`）；音乐域用于 MV／主题曲／插曲交付。

| 用法 | 判定 | 依据 |
|---|---|---|
| 内部跑 POC、内部评测、不交付给付费用户、不对外卖 | **可以**（CC BY-NC 4.0 非商用研究／内部评估） | 来源 A 首段 |
| 暴君**以个人创作者身分**手动为客户做歌、拿去卖或上商业平台 | **可以**（individual creator permission 明文涵盖「distributing or licensing their outputs to clients and publishing them on commercial platforms」） | 来源 A「Individual creators and output monetization」 |
| **Eimu 产品（自动化服务）用 YuE2 生成、交付给付费套餐用户** | **不可以**（需商业授权）——这正是「a company using the model weights commercially」 | 来源 A 倒数第三段逐字 |
| **B 端 API key 客户经由 Eimu 端点取得 YuE2 产出** | **不可以**（需商业授权）。B 端客户是第三方企业，Eimu 是「以公司身分商业使用权重」的服务方 | 同上 |
| 把 YuE2 权重再散布／转售／打包进对外服务供他人下载 | **不可以**（明文禁止 commercial redistribution or sale of the model weights） | 来源 A 末段 |
| 只在**创作侧**用 YuE2 产 ABC 乐谱作为内部素材，最终音档改由 Lyria 生成后交付 | **可讨论**（交付物不含 YuE2 权重产出；但 ABC 是否构成衍生仍属解释空间）→ 属**推论**，若真要落地建议先书面问授权方 | 推论，非事实 |

**关键推论（请暴君注意）**：这条授权红线**不区分「独占主力」与「混合路由中之一支」**。只要 YuE2 的产出最终卖给了付费方（套餐用户或 B 端 key），就是公司商用权重。**因此选项 C（混合路由）在法律上与选项 B 同等卡关**——除非 C 的定义严格限定为「YuE2 产出永不交付给付费方，只作内部／个人创作侧使用」。

**授权洽谈入口**：`ryuanab@connect.ust.hk`（来源 A 逐字）。这是唯一能解锁 B/C 的动作，且它是一个**人的回信周期**，不是技术问题——建议把它当成与技术 POC 并行的独立轨道。

---

## 5. 接入点清单（file:line，均已现场 grep 验证）

### 5.1 现任 Lyria / FlowMusic2API 通路

验证指令与结果：

```bash
cd /home/lenovo/Desktop/image-app
grep -n "FLOWMUSIC_MODELS = \|isFlowMusic2ApiEnabled" src/lib/music-flowmusic.ts
# 30:export const FLOWMUSIC_MODELS = {
# 54:export function isFlowMusic2ApiEnabled(): boolean {
grep -n "export type MusicChannel" src/lib/music-prompt-director.ts
# 31:export type MusicChannel = "flowmusic" | "lyria" | "yue2";   ← 原为 "flowmusic" | "lyria"
grep -n "MUSIC_HARNESS_TOOL_IDS" src/lib/harness-tool-registry.ts
# 22:import { MUSIC_HARNESS_TOOL_IDS } from "./music-tools"
# 140:  ...MUSIC_HARNESS_TOOL_IDS,
grep -n "music: {\|taskTypes: \[\"music\"" src/lib/expert-registry.ts
# 149:  music: {
# 155:    taskTypes: ["music", "song", "bgm", "mv_theme", "theme_song"],
grep -n "MUSIC_DELIVERABLES = " src/lib/music-delegate.ts
# 52:export const MUSIC_DELIVERABLES = ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"] as const;
```

| 档案 | 位置 | 内容 | 换 YuE2 时的处置 |
|---|---|---|---|
| `src/lib/music-tools.ts` | L297-330 | `musicGenTool.description` 与四个 args 文案（`prompt`/`lyrics`/`duration_hint`/`reference_images`） | **需改**（已由并发片改为三通路文案） |
| `src/lib/music-tools.ts` | L344 | `const yue2Enabled = isYue2ModalEnabled()` | 已存在（工作区） |
| `src/lib/music-tools.ts` | L365 | `const directorChannel = yue2Enabled ? "yue2" : flowMusicEnabled ? "flowmusic" : "lyria"` | 已存在 |
| `src/lib/music-tools.ts` | L379 | `await generateYue2Track({ style, lyrics, cot: YUE2_TOOL_COT })` | 已存在 |
| `src/lib/music-tools.ts` | L437 | 回执 `channel: yue2Enabled ? "yue2_modal" : ...` | 已存在 |
| `src/lib/music-tools.ts` | L446 / L448 | `score_abc` / `yue2_truncated` 回执栏 | 已存在（白盒进交付契约的接点） |
| `src/lib/music-tools.ts` | L459-464 | `reference_image_count` / `reference_images_note` | 已存在 |
| `src/lib/music-tools.ts` | L479 | `export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"]` | 不变 |
| `src/lib/music-flowmusic.ts` | L30 / L54 | `FLOWMUSIC_MODELS`、`isFlowMusic2ApiEnabled()` | 保留（降级通路） |
| `src/lib/music-prompt-director.ts` | **L31** | `MusicChannel` 联合（spec 所述 L29 → **现场已漂到 L31**） | 已含 `"yue2"` |
| `src/lib/music-prompt-director.ts` | L84 | `CHANNEL_LIMITS.yue2Style: 3000` | 已存在 |
| `src/lib/music-prompt-director.ts` | L546 | `else if (channel === "yue2")` 分支（剥时间戳、3000 版面预算） | 已存在 |
| `src/lib/music-delegate.ts` | L52 | `MUSIC_DELIVERABLES` 六栏（含 `melody_notation`） | **需改**（乐谱改由工具回执真源供给） |
| `src/lib/music-delegate.ts` | L249-253 | `melody_notation` 可判形态指引 | **需改**（若 ABC 由工具供给，此引导可下沉为后端注入） |
| `src/lib/expert-registry.ts` | L149-160 | `music` Expert 注册（`taskTypes` L155） | **不改**（与通路无关） |
| `src/lib/harness-tool-registry.ts` | L22 / L140 | `music_gen` 工具登记 | **不改** |
| `src/lib/music-director-persona.ts` | L46 / L59 | persona 描述（现文案写「自主驱动 Lyria 产出」）与工具白名单 | **需改文案**（Lyria 不再是唯一） |
| VPS `.env` | `/opt/agent-harness/.env` | `FLOWMUSIC2API_URL`、`FLOWMUSIC2API_KEY`、`GEMINI_API_KEY` 皆已配置（key 名实测）；`.env.opencode` 权限不足未读 | **需加** `YUE2_MODAL_ENDPOINT`、`YUE2_HMAC_SECRET` |

### 5.2 新增档（工作区，未提交）

| 档案 | 内容 |
|---|---|
| `src/lib/music-yue2.ts` | YuE2 Modal client（HMAC 签名、`/generate`、`YUE2_TIMEOUT_MS=600000`、`YUE2_MODEL_ID="m-a-p/YuE2-3B"`、`YUE2_COT_MODES`） |
| `deploy-staging/yue2-modal/yue2_common.py` | Modal app 侧（**仅此一档，`out/` 空**）→ 实测数字 pending |

---

## 6. Harness 缺口分析（框架：Harness = 需求上限 − 底模能力下限；层级顺序＝工具注入 > 后端判定 > prompt 条款）

| # | 缺口 | 内容 | 层级 | 状态 |
|---|---|---|---|---|
| 1 | 情绪契约 → style/lyrics 转译 | `buildLyriaStylePrompt`（`music-lyria.ts:71`）已能把 `style/genre/bpm/musicalKey/mood/structure/instrumental` 确定性拼成 prompt；YuE2 的 `style` 是散文栏、`lyrics` 必填 | 工具层 | **已有可复用**（拼装逻辑沿用；`structure` 栏在 YuE2 无效需剥除——director 已做） |
| 2 | 情绪契约 → **ABC 乐谱** | 需求上限侧的正解：把 `bpm`/`musicalKey`/`mood` 从 NL 栏位升级为**可判定**的 ABC 参数或后处理（改 `score.abc` 的 tempo/key 标头）| 后端判定 | **需新建** |
| 3 | `cot` 选择策略 | `full`＝唯一回乐谱、`melody`＝翻唱、`off`＝最快。工具层现固定 `YUE2_TOOL_COT="full"`（`music-tools.ts:207`），不给模型选 | 后端判定 > prompt | **已有（硬编）**；若要按任务型态分流＝**需新建**（应在后端判定，勿写进 prompt 条款） |
| 4 | ABC 乐谱进交付契约 | `MUSIC_DELIVERABLES` 已含 `melody_notation`，但现制是**导演正文文案栏**（缺整栏＝未交付、`collect` 不伪造）；YuE2 让它变成**工具真源产物** | **工具注入**（最高 ROI 层） | **可复用官方 `skills/yue2-music`（Apache-2.0）＋需改**：把 `score_abc` 从工具回执直接注入 payload，别再靠模型「记得写」 |
| 5 | 翻唱工作流（SheetSage2 扒谱） | SheetSage2 与 YuE2 **依赖版本不同、需分离环境**，以 ABC／音档交换（`docs/covers.md:5-7`）；`cot="melody"` ＋ 无和弦符号的乐谱 | — | **需新建**；**可复用**官方 `skills/yue2-music`（含 cover 指南） |
| 6 | 乐谱品质 QC 门禁 | ABC parse 不变量（拍号／音域／段落数）、`truncated` 检查 | 后端判定 | **需新建**；官方 `skills/yue2-music` 已含「check musical invariants」可复用 |
| 7 | 失败／截断处理 | `truncated` flag 已回执（`yue2_truncated`，`music-tools.ts:448`），但**交付闸门尚未依它拦截** | 后端判定 | **需新建**：`truncated` 非空 → 组装闸门应拒收或标降级，不得静默交付 |
| 8 | 并发（一次一请求）对编排的影响 | 上游「one request at a time」；多个 Expert 任务并发会**排队**，600 s timeout 可能被打穿 | 后端判定 | **需新建**：orchestrator 派工协议需序列化音乐任务，或 Modal 侧排队回报 |
| 9 | 音频入库链 | gateway MIME 表已补 `.m4a/.aac/.ogg/.flac/.opus`，FLAC 可入库 | — | **可复用**（`[背]` 记忆 `audio-ingest-404-and-audio-card-0911`；该记忆另记 gateway 只认 `/attachments` 非 `/uploads`） |
| 10 | 时长真源 | `measureAudioDuration`（ffprobe）已存在；YuE2 另回上游自报 `duration_s` → 新增 `duration_source="upstream_reported"` | 工具层 | **已有**（`music-tools.ts:431`） |
| 11 | 配方库（must-load skill） | `skills/music-director/` 12 档 SunoForge（MIT）；通路判定表已列 FlowMusic2API vs Gemini 直连 | — | **需改**：新增 `DATA_YUE2_2026-09.md` DATA 档（CORE 档一字不动——CORE/DATA 分离哲学） |
| 12 | 交付契约 `melody_notation` 的语义升级 | 现指引要求「音名字符序列（例 A4–C5–B4–A4）」，而 YuE2 给的是完整 ABC——粒度不同，需重写判据 | 后端判定 | **需改** |

**层级正确性提醒（依 harness doctrine）**：第 2、4、6、7、8 项都必须落在**工具注入／后端判定**；若把它们写成 prompt 条款（「请记得检查 truncated」「请记得输出乐谱」），依 doctrine 属「背离警报」——需要模型记得才生效的，不是防线。

---

## 7. 风险清单（依严重度排序）

| # | 风险 | 严重度 | 证据 |
|---|---|---|---|
| 1 | **非商用授权**：权重 CC BY-NC 4.0，公司商用需另谈。Eimu 为付费产品＋B 端 key，**B/C 两选项皆卡此线** | **致命（法律）** | §4.1 逐字引用（`MODEL_LICENSE`「The individual creator permission does not authorize commercial use of the model weights by companies.」） |
| 2 | **image-to-music 能力回退**（MV 分镜→乐卖点） | 高 | YuE2 **无**图像介面 `[现]`（官方文档全篇无）。**但**现任主力 FlowMusic2API 亦不支援（`music-tools.ts:459-464`）→ 实际回退幅度**仅在「现行是否走 Gemini 直连」成立时才存在**，需暴君确认 |
| 3 | **无 30 s 短档**（互动预览／快速试听缺位） | 中高 | YuE2 契约无时长栏位（`music-yue2.ts:13` 冻结合约；`music-tools.ts:316-317` 已改为对 `clip30` **直接报错**）。现任亦非真短档（`lyria-fast` 与 `lyria` 规格全等，实测 162–182 s）→ 双方皆缺 |
| 4 | **分钟级延迟 vs 互动体验** | 中高 | 现任 162–182 s `[现]`；YuE2 官方「one request at a time」＋分钟级 `[现]`，且冷启「seconds to minutes」`[现]`。**Modal 实测 RTF pending**，无法判定是否劣于现任 |
| 5 | **24 GB 显存底线，fp8/offload 品质未验** | 中 | 官方「NVIDIA GPU with BF16 support and 24 GB VRAM」`[现]`。fp8＋`offload_ar` 降到 12–16 GB `[背]`（未独立复核）→ **未证**，若真要走低显存必须先验品质不退 |
| 6 | **7.26 GB 权重冷启** | 中 | `model.safetensors` = 7,261,441,640 bytes（HF API `?blobs=true`，2026-09-18）；Modal cold start「seconds to minutes」`[现]`。实际载入时间 `未证`（片 A 的 `timing.model_load_ms` 会给答案） |
| 7 | **Modal 帐号 GPU 配额** | 中 | 帐号 verenowo 已有 blender-modal app 在跑 `[背]`；**音乐 app 的配额余量未证**，Modal 需先绑付款方式/申请配额的机率存在 |
| 8 | **单容器并发 1** | 中 | 官方「one request at a time」`[现]`；多任务并发会排队，需编排序列化（§6 #8） |
| 9 | **白盒乐谱是资产还是新负担** | 中 | 正面：可编辑＝agent 可迭代、可做 QC 门禁（真值可判定）。负担：需新增 ABC 保存策略（谁存／存哪／谁可改）、版本可比性（官方要求 pin `revision`/`vae_revision`，`docs/generation.md:57`）、交付契约语义升级（§6 #12）。**这是唯一「换过去之后我们会多出工作」的维度** |
| 10 | 上游 FlowMusic2API 逆向封装可能封号 | 低（与本决策无关，但为现任风险） | `[背]` 记忆 `music-gen-frontier-2026-09.md:81` |
| 11 | 第三方 `m-a-p/YuE2-3B` 权重来源可信度 | 低 | HF 官方 org `m-a-p`、arXiv 2503.08638、repo 9.6k★ `[现]`（HF API tag `arxiv:2503.08638`） |

---

## 8. 三条可拍板选项

### 选项 A：只当第二通路／非商用内部 POC（不影响现任主力）

- **做法**：`YUE2_MODAL_ENDPOINT` 不进生产 VPS；只在本地／内部环境跑，用于评测音质、验证 Modal 真实 RTF 与成本、把白盒乐谱接进 pipeline 试跑。产出**不交付给付费方**。
- **代价**：Modal 实测成本（$30/月 Starter 免费额度可能就够 POC）；不解决 bearer 痛点（主力仍 Lyria）。
- **适用**：想先拿真数据再决定；授权谈判尚未启动。
- **合规**：**完全安全**（CC BY-NC 的非商用研究／内部评估）。

### 选项 B：换成产品主力（前置＝商用授权）

- **做法**：`YUE2_MODAL_ENDPOINT` 进 VPS `.env`，优先序高于 FlowMusic2API；Lyria 退为降级通路；`cot`/乐谱 QC/序列化编排全数落地。
- **代价**：①**必须先拿到商用授权**（`ryuanab@connect.ust.hk`，周期不可控）；②Modal 成本（稀疏请求下每首 $0.15，批量 ≥4 首/暖窗才低于 $0.08）；③image-to-music 彻底归零（若 Gemini 直连还在，这刀砍掉的是 MV 分镜→乐）；④分钟级延迟＋单并发。
- **适用**：**只有在商用授权到手后才成立。**

### 选项 C：按用途混合路由（有分镜图的 MV → Lyria；要白盒乐谱／翻唱的创作 → YuE2）

- **做法与代价**：技术上最漂亮（各取所长），`music-tools.ts` 三通路分支已具备雏形。
- **但**：**法律上与 B 同等卡关**——只要 YuE2 产出卖给付费方，就是公司商用权重（§4.2）。所以 C 若要合规，必须重新定义为：
  - **C′（合规版）**：YuE2 只用于**内部创作侧**（暴君／内部 agent 产出乐谱当素材），对外交付的音乐一律由 Lyria 生成；或
  - **C″（同 B 前置）**：拿到商用授权后才允许对外交付。
- **适用**：若 C′ 的价值成立（白盒乐谱作为内部生产力工具），这是**授权解锁前唯一能做的实质落地**。

### 建议

**采 A，并行推进两件事：(1) 把商用授权洽谈当独立轨道启动；(2) 用片 A 的 Modal 实测把 §3 的 pending 全部补实。**

理由：
1. **法律是唯一硬闸门，且与技术无关**——B 与 C（对外交付版）都卡同一格，授权信写出去的回信周期是关键路径，越早启动越好；技术 POC 可以完全并行，不浪费等待时间。
2. **技术面已超前**：YuE2 第三通路（`music-yue2.ts`、三通路分支、director `yue2` channel、Modal app 骨架）已由并发片落在工作区，A 选项的边际成本已经很低——现在不验，等于把已付出的沉没成本搁著。
3. **成本不构成换主力的理由**：现任现金边际 ≈ $0（credit 池），YuE2 在稀疏请求下反而贵 89%（$0.1514 vs $0.08）。唯一站得住的理由是**能力**（白盒乐谱／翻唱）与**消除 bearer 维运**——而前者对外卖、后者省暴君时间。
4. **不要为了 MV 分镜→乐去换**：那是 Lyria 的 Gemini 直连能力，换掉主力反而可能把它一起砍掉（且现行 FlowMusic2API 已停用它，这笔帐要先算清）。
5. **明确不做**：不要在授权到手前把 `YUE2_MODAL_ENDPOINT` 写进生产 `.env`。HTTP 200 不等于可用，能生成不等于能卖。

---

## 附录：本文件的事实验证指令（可复现）

```bash
# Modal 费率与 scaledown_window（官方页面）
# https://modal.com/pricing                                → GPU $/s 表（§3.1）
# https://modal.com/docs/guide/cold-start                  → 默认 idle 60s、范围 2s–20min、idle 计费（§3.1）

# 授权逐字
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/MODEL_LICENSE | sed -n '1,80p'
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/README.md | sed -n '221,235p'

# 权重大小
curl -s "https://huggingface.co/api/models/m-a-p/YuE2-3B?blobs=true" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print([ (s['rfilename'],s.get('size')) for s in d['siblings'] if s['rfilename']=='model.safetensors'])"

# YuE2 能力边界
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/docs/generation.md | head -5
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/docs/covers.md | head -8

# 接入点行号（现场工作区，2026-09-18）
cd /home/lenovo/Desktop/image-app
grep -n "yue2Enabled\|score_abc\|MUSIC_HARNESS_TOOL_IDS = " src/lib/music-tools.ts
grep -n "export type MusicChannel\|yue2Style:\|channel === \"yue2\"" src/lib/music-prompt-director.ts
grep -n "FLOWMUSIC_MODELS = \|isFlowMusic2ApiEnabled" src/lib/music-flowmusic.ts
grep -n "MUSIC_DELIVERABLES = " src/lib/music-delegate.ts
grep -n "music: {\|taskTypes: \[\"music\"" src/lib/expert-registry.ts
grep -n "MUSIC_HARNESS_TOOL_IDS" src/lib/harness-tool-registry.ts
grep -n "YUE2_MODAL_ENDPOINT\|YUE2_HMAC_SECRET\|YUE2_TIMEOUT_MS" src/lib/music-yue2.ts
git status --short | grep -i "yue\|music"

# VPS env key 名（只列名，不印值）
ssh -i ~/.ssh/new.pem -p 22443 ubuntu@43.172.85.76 \
  'grep -o "^[A-Z_]*FLOWMUSIC2API_URL\|^GEMINI_API_KEY\|^FLOWMUSIC2API_KEY" /opt/agent-harness/.env'

# Modal 实测（pending，片 A）
ls -la deploy-staging/yue2-modal/ deploy-staging/yue2-modal/out/
```
