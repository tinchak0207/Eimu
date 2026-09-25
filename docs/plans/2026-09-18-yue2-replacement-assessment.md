# 生音樂管線主力替換成 YuE2 的可行性研判（可拍板文件）

- 日期：2026-09-18
- 性質：**研判與證據蒐集，無任何程式碼修改、無部署、無 commit**
- 範圍：只回答「要不要把現任音樂生成主力（Lyria 3.5 / FlowMusic2API）換成 YuE2（Modal 自託管）」，含成本、授權、harness 缺口
- 撰寫時的 repo 狀態：工作區**已有未提交的 YuE2 第三通路實作**（另一片並發產物，見 §5 衝突回報）

---

## 1. 一句話結論

**技術上可換、成本上要量、法律上「產品化」這一步現在走不通**：YuE2 的白盒 ABC 樂譜與翻唱是現任完全沒有的真能力，但權重是 **CC BY-NC 4.0**，而 Eimu 是付費套餐＋B 端 API key 的商業服務——**在拿到商業授權之前，YuE2 只可以當非商用內部 POC／創作輔助，不可以當產品主力或對外通路的生成引擎**（連「混合路由」把 YuE2 產出交付給付費用戶也不行）。**建議：先做 A（第二通路＋非商用 POC），把 B/C 卡在商用授權這一格上。**

---

## 2. 能力矩陣：Lyria 3.5（FlowMusic2API 現任主力） vs YuE2（Modal）

> 記法：`[現]`＝現場程式碼／官方文檔已驗；`[背]`＝片 C spec 提供的背景事實（未附上游連結，未獨立複核）；`未證`＝目前沒有可複現證據。

| 維度 | 現任 Lyria 3.5（FlowMusic2API） | YuE2（Modal） |
|---|---|---|
| **人聲語言覆蓋** | 多語言＋時間戳歌詞 `[背]`；歌詞語言跟隨 prompt 語言 `[現]`（`src/lib/music-tools.ts:310`）。具體語言清單 `未證` | 官方 HF repo tag `zh`/`en`；官方 demo 含 Mandarin pop→English jazz 迭代案例 `[現]`（README「The Last Train … from Mandarin pop to English jazz」）。完整語言覆蓋表 `未證` |
| **單曲時長與可延伸性** | 整歌實測 **162–182s**（成品長度不受 prompt 約束）`[現]`（`src/lib/music-prompt-director.ts:77-78`、`skills/music-director/SKILL.md:44`）；延伸（extend）在自託管路徑**無**接口 `未證` | **無任何時長控制欄位**——官方 API 只有 `style/lyrics/cot/abc/seed` `[現]`（README Quick start 表）；長度由模型決定，`save_artifacts` 的 `truncated` flag 表示撞 token 上限 `[現]`（`docs/generation.md:55`）。可延伸性 `未證` |
| **結構控制** | 時間戳 `[0:00 - 0:10]` 在 FlowMusic2API **無效**（上游把 `:` 換成空格）`[現]`（`music-prompt-director.ts:207` 註釋、`skills/music-director/SKILL.md:44`）；帶歌詞標籤走「保版面」分支（3000 runes），但上游自行加寫段落、產 A/B 兩版 `[現]` | **ABC 記譜法樂譜＝顯式樂器級控制**：`cot="full"` 先產 melody-and-chord plan，`abc=` 可注入自備樂譜 `[現]`（README `cot` 表、`docs/editing.md`）。時間戳式結構控制**不存在** `[現]`（官方文檔全篇無此介面） |
| **image-to-music** | **現任主力通路上不支援**：`reference_images` 僅 Gemini 直連生效，FlowMusic2API 忽略並如實標注 `[現]`（`src/lib/music-tools.ts:322-323`、`:459-464`）。Gemini 直連支援 ≤10 張 `[現]`（`src/lib/music-lyria.ts:37` `LYRIA_MAX_IMAGES = 10`） | **不支援**：官方 README／`docs/generation.md`／`docs/covers.md` 全篇無圖像輸入介面 `[現]`；工作區工具文案亦已如實標注 `[現]`（`music-tools.ts:462-463`） |
| **白盒可編輯性** | **無**：黑箱輸出音檔 `[現]` | **最強項**：`score.abc`（可人工／agent 改和聲、旋律、速度、曲式後重render）、`plan.json`、semantic tokens、`latent.npy`、`timings`、model identities 全部落盤 `[現]`（`docs/generation.md:55`、README「Edit a composition」） |
| **翻唱／風格重構** | 無專用能力，只能 prompt 逼近 `未證` | **零樣本翻唱**：SheetSage2 扒譜 → 自備 abc ＋ `cot="melody"` → 換風格；官方數字 **0.647 CLEWS mAP**（948 首），無樂譜時僅 0.006 `[現]`（README「Zero-shot covers」） |
| **輸出規格** | 本路徑回 **m4a**（上游公網 URL）`[背]`；MIME 表已補 `.m4a/.aac/.ogg/.flac/.opus` `[背]`（記憶 `audio-ingest-404-and-audio-card-0911`，09-11 已部署） | **48 kHz 立體聲、無量化** `[現]`（README「Quick start」）；交付格式 FLAC `[現]`（工作區契約 `mime_type:"audio/flac"`，`src/lib/music-yue2.ts:13`）；24-bit 具體位元深 `[背]`／`未證` |
| **並發能力** | 賬號池多 token 負載均衡 `[背]`（記憶 `music-gen-frontier-2026-09.md:80`）。實際併發上限 `未證` | **一次一請求** `[現]`（`docs/generation.md:3`「one request at a time」）；Modal 側 `max_containers` 可開但上游仍是單請求序列 `[現]` |
| **冷啟／暖啟延遲** | 自託管 VPS 常駐容器，**暖啟 = 0**；單次生成 162–182s `[現]` | 暖啟：生成分鐘級、`YUE2_TIMEOUT_MS` 設 600s `[現]`（`music-yue2.ts:66`）；冷啟含 `timing.model_load_ms`（上游自報）`[現]`。**Modal 實測值 pending**：`deploy-staging/yue2-modal/` 目前只有 `yue2_common.py`，`out/` 為空、零 probe log（2026-09-18 21:2x 現場）→ **本文件不採用任何 4090 數字冒充 Modal** |
| **憑證與依賴** | `FLOWMUSIC2API_URL`＋`FLOWMUSIC2API_KEY`（VPS `/opt/agent-harness/.env` 已配置，實測 key 名存在）`[現]`；**上游 FlowMusic bearer 約每 1h 過期** `[背]` | `YUE2_MODAL_ENDPOINT`＋`YUE2_HMAC_SECRET`（HMAC-SHA256 簽名）`[現]`；依賴 Modal 帳號＋HF 權重下載（7.26 GB）`[現]` |
| **ops 負擔** | **已知痛點**：bearer 過期需暴君重登取 Supabase 分片 cookie → 解 base64 提取 `refresh_token/provider_token/provider_refresh_token` → admin login 換 JWT → `PUT /api/tokens/1` 全量替換 → 驗活 `[背]`（記憶 `music-gen-frontier-2026-09.md:113`） | 無短命憑證；但新增 Modal app 維運、GPU 配額、權重版本固定（`revision`/`vae_revision` 需 pin 以求可比）`[現]`（`docs/generation.md:57`） |
| **每首成本** | 官方 Lyria 標價 **$0.08/首** `[背]`（記憶 `music-gen-frontier-2026-09.md:19`）；**實走 FlowMusic credit 池**（帳號 10555 credits，plus tier）`[背]` → 現金邊際成本 ≈ $0，credit 貨幣等值 `未證` | **pending 實測**（GPU 秒數未定）；Modal 費率已抓（§3）。以 A100 40GB 暖機邊際估 **$0.051/首**（算式見 §3） |
| **授權** | Google 專有 API／FlowMusic2API 自託管（MIT，逆向封裝上游，可能封號）`[背]`；Lyria 產出商用條款 `未證` | **權重 CC BY-NC 4.0（非商用）＋ individual creator 例外**；**公司商用需另談授權** `[現]`（§4 逐字） |

### 2.1 現場與規格書敘述的衝突（必須回報）

1. **「Lyria 的 image-to-music 是 MV 分鏡圖→樂 現役賣點」與現場不符。** 現行主力是 FlowMusic2API，該通路**忽略** `reference_images`，工具回執強制 `reference_image_count: 0` 並附 `reference_images_note: "FlowMusic2API 通路暂不支持参考图（图生乐），本次已忽略"`（`src/lib/music-tools.ts:459-464`）。也就是說：**只要 VPS 上 `FLOWMUSIC2API_URL` 有配置（實測已配置），image-to-music 就是停用狀態**，「現役賣點」實際上取決於是否另走 Gemini 直連。
2. **VPS 同時配置了 `GEMINI_API_KEY` 與 `FLOWMUSIC2API_URL`**（`/opt/agent-harness/.env` key 名實測存在）；因工具層是「FlowMusic 已配置即優先」，`GEMINI_API_KEY` 的存在**不會**讓 image-to-music 自動生效。此為推論（讀碼得出），`未證` 是否有其他呼叫端直連 Gemini。
3. **接入點清單已在工作區被超前落地**：YuE2 第三通路（`src/lib/music-yue2.ts`、`music-tools.ts` 三分支、`music-prompt-director.ts` 的 `yue2` channel、`deploy-staging/yue2-modal/`）為**未提交**的並發產物（`git status` 顯示 `?? src/lib/music-yue2.ts`、` M src/lib/music-tools.ts`、` M src/lib/music-prompt-director.ts`）。本文件 §5 的「現有」行號以**當下工作區**為準，若該片後續續改，行號會漂移。

---

## 3. 成本模型

### 3.1 Modal 官方現行費率（已抓，非憑記憶）

來源：**https://modal.com/pricing**（2026-09-18 抓取）

| GPU | 每秒 | 折算每小時 |
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

其他抓到的事實（同頁）：
- CPU：**$0.0000131 / core / s**（每容器最低 0.125 core）
- 記憶體：**$0.00000222 / GiB / s**
- Volumes：$0.09 / GiB / 月（含 1 TiB/月免費）
- 區域選擇＝**1.15–1.75x** 基礎價；非搶佔（non-preemptible）＝**3x**
- Starter 方案含 **$30/月** 免費算力；Team 含 **$100/月**
- 計費原則原文：「You never pay for idle resources — just actual compute time, by the CPU cycle.」

來源：**https://modal.com/docs/guide/cold-start**，章節「Keep containers warm for longer with scaledown_window」（2026-09-18 抓取，逐字）：
> 「Modal containers will remain idle for a short period before shutting down. By default, the maximum idle time is **60 seconds**. You can configure this by setting the `scaledown_window` on the `@function` decorator. The value is measured in seconds, and it can be set **anywhere between two seconds and twenty minutes**.」
> 「Increasing the `scaledown_window` reduces the chance that subsequent requests will require a cold start, although **you will be billed for any resources used while the container is idle** (e.g., GPU reservation or residual memory occupancy).」

同頁冷啟原文：「The time taken for a container to become warm and ready for inputs can **range from seconds to minutes**.」

### 3.2 顯式假設（全部列出；未證者標明）

| 代號 | 假設 | 值 | 證據狀態 |
|---|---|---|---|
| A1 | GPU 型別 | Modal **A100 40 GB**（40 GB ≥ 官方 24 GB 底線） | 費率 `[現]` |
| A2 | 每首 GPU 秒 `g` | 以 RTF 0.42 推算：180s 成品 → **75.6 GPU-s**（124.9s 成品 → 52.4 GPU-s） | **未證**：RTF 0.42 來自片 C spec 背景（4090 實測），**非** Modal 數字；片 A `deploy-staging/yue2-modal/out/` 尚無結果檔 |
| A3 | CPU＋記憶體配置 | 假設 4 vCPU ＋ 16 GiB → `r_cm = 4×0.0000131 + 16×0.00000222 = $0.00008792 /s` | **未證**：Modal app 未落地，配置未定；該項約佔 GPU 成本 15% |
| A4 | 冷啟 `C` | **90 s**（容器 boot ＋ 7.26 GB 權重載入 ＋ 上卡） | **未證**：官方只說「seconds to minutes」；權重實測 7,261,441,640 bytes（HF API，含全部 artifacts 7.30 GB）`[現]` |
| A5 | `scaledown_window` `s` | **60 s**（官方默認） | `[現]` |
| A6 | 批次粒度 `k` | 每個「暖窗」內連續生成 k 首 | 情境參數 |
| — | 合成費率 | `r_tot = A1 + A3 = $0.00067092 /s` | 推算 |

### 3.3 算式

```
每首成本(k) = (C + k·g + s) · r_tot / k
```

代入 `C=90`、`g=75.6`、`s=60`、`r_tot=0.00067092`：

| k（每暖窗首數） | 每窗 GPU+CPU 秒 | 每首成本 | 對比現任 $0.08/首 |
|---|---|---|---|
| 1（每首都冷啟） | 225.6 s | **$0.1514** | 貴 89% |
| 2 | 301.2 s | **$0.1010** | 貴 26% |
| 3 | 376.8 s | **$0.0843** | 貴 5% |
| **4** | 452.4 s | **$0.0759** | **便宜 5%** |
| 8 | 754.8 s | **$0.0633** | 便宜 21% |
| 16 | 1359.6 s | **$0.0570** | 便宜 29% |

**損益平衡（純算力，對 $0.08/首）**：
```
0.08k = (150 + 75.6k) × 0.00067092
0.08k = 0.100638 + 0.050722k
k = 0.100638 / 0.029278 ≈ 3.4
```
→ **每個暖窗內至少 4 首，YuE2 的 Modal 算力才比 Lyria 官方標價便宜。**

暖機邊際（不攤冷啟、不攤空窗）：`75.6 × 0.00067092 = **$0.0507/首**`。

### 3.4 「常溫待命」策略的損益平衡點

`min_containers=1`（A100 40GB 24/7 常駐）：
```
GPU      : 2,592,000 s/月 × $0.000583   = $1,511.1
CPU+記憶 : 2,592,000 s/月 × $0.00008792 = $  227.9
合計                                      ≈ $1,739 / 月
損益平衡 = 1,739 ÷ 0.08 ≈ 21,700 首/月（≈ 724 首/日）
```
若 Modal 對「idle 期間的記憶體快照」減免（官方只說「會被計費」，細則 `未證`），此門檻可再下降；純 GPU 口徑門檻為 `1,511.1 ÷ 0.08 ≈ 18,900 首/月`。

### 3.5 GPU 型別敏感度（暖機邊際／每首，k=1 冷啟）

| GPU | 暖機邊際/首 | k=1 冷啟/首 |
|---|---|---|
| A10（24 GB，剛好卡底線） | $0.0298 | $0.0890 |
| L40S（48 GB） | $0.0476 | $0.1421 |
| A100 40 GB | $0.0507 | $0.1514 |
| A100 80 GB | $0.0591 | $0.1764 |
| H100 SXM5 | $0.0896 | $0.2673 |

注意：A10 只有 24 GB，正好落在官方「24 GB VRAM」底線上，且其 BF16 算力遠低於 4090 → **RTF 必然劣於 0.42**，上表 A10 欄位偏樂觀（`未證`）。

### 3.6 對照現任「$0.08/首 ＋ bearer 重錄人工成本」

- **現任現金邊際成本 ≈ $0**：實際走 FlowMusic credit 池（帳號 10555 credits），並非逐首付現；$0.08 是官方 Lyria 標價，僅堪作機會成本錨點。credit 的貨幣等值 `未證`。
- **現任真實成本在人工**：FlowMusic bearer 約每 1h 過期，救法需暴君本人重登取 Supabase 分片 cookie 再重錄賬號池（`[背]` 記憶 `music-gen-frontier-2026-09.md:113`）。每次事故約 10–15 分鐘；每日 1 次 ≈ **5–7.5 小時/月**的暴君時間。這筆人工無法用 $/首 定價，請暴君自評。
- **結論**：**用「省錢」當換主力的理由不成立**（現任現金 ≈ $0、YuE2 在稀疏請求下反而貴）。換主力的正當理由是**能力**（白盒樂譜／翻唱）與**消除 bearer 維運**，成本只在高批量（≥4 首/暖窗）或高月量（≥21,700 首/月常駐）時才站得住。

---

## 4. 授權與合規（本節最重要）

### 4.1 逐字引用

**來源 A**：`https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/MODEL_LICENSE`（2026-09-18 抓取，逐字）

> 「The YuE2-3B, YuE2-Vae and YuE2-Vae-legacy checkpoint weights are licensed under **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**: https://creativecommons.org/licenses/by-nc/4.0/  Individual creator permission and academic-use terms are set out below.」

> 「In addition to the CC BY-NC 4.0 license below, the YuE2 model licensors grant personal users, content creators and musicians **acting in an individual capacity** permission to use the model weights free of charge to generate outputs, and to publish, distribute, sell, license or otherwise monetize those outputs, subject to the responsible-use conditions below.」

> 「For these individual creative activities, the model licensors waive the NonCommercial restriction to the extent necessary. These users do not need a separate commercial license from, or owe license fees or royalties to, the model licensors for this use or for monetizing their outputs. **This includes distributing or licensing their outputs to clients and publishing them on commercial platforms.**」

> 「**The individual creator permission does not authorize commercial use of the model weights by companies. Companies wishing to use the model weights commercially should contact ryuanab@connect.ust.hk to discuss a commercial license**: https://github.com/multimodal-art-projection/YuE#contact」

> 「This permission concerns generating and using outputs; **it does not extend to commercial redistribution or sale of the model weights.** All other applicable CC BY-NC 4.0 conditions continue to apply to the weights.」

> 「Academic use … Students, educators, researchers and academic institutions may use YuE2 free of charge for **non-commercial research and education** under the CC BY-NC 4.0 license below. **This academic-use provision does not itself grant commercial-use rights to an institution.** An academic user creating work in an individual capacity may rely on the individual creator permission above.」

**來源 B**：`https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/README.md` §License（2026-09-18 抓取，逐字）

> 「| **Personal users, content creators, and musicians** | Free to use YuE2 and monetize generated outputs, with **no fees or royalties payable to us**. |
> | **Academic research and education** | Free for **non-commercial use**. |
> | **Commercial use by companies** | [Contact us](#contact) to discuss a commercial license for the model weights. |」

> 「**Code, agent skill, and documentation:** [Apache 2.0](LICENSE). **Model weights:** [CC BY-NC 4.0 with additional creator permission](MODEL_LICENSE).」

### 4.2 對 Eimu（付費套餐 ＋ B 端 API key）的結論

前提事實（`[背]`，來自任務背景與 repo）：Eimu 是**付費產品**（賣套餐）＋**對外販售 B 端 API key**（明文在 `.env.biz-key`，調 `https://image.tinchak0207.xyz/v1/*`）；音樂域用於 MV／主題曲／插曲交付。

| 用法 | 判定 | 依據 |
|---|---|---|
| 內部跑 POC、內部評測、不交付給付費用戶、不對外賣 | **可以**（CC BY-NC 4.0 非商用研究／內部評估） | 來源 A 首段 |
| 暴君**以個人創作者身分**手動為客戶做歌、拿去賣或上商業平台 | **可以**（individual creator permission 明文涵蓋「distributing or licensing their outputs to clients and publishing them on commercial platforms」） | 來源 A「Individual creators and output monetization」 |
| **Eimu 產品（自動化服務）用 YuE2 生成、交付給付費套餐用戶** | **不可以**（需商業授權）——這正是「a company using the model weights commercially」 | 來源 A 倒數第三段逐字 |
| **B 端 API key 客戶經由 Eimu 端點取得 YuE2 產出** | **不可以**（需商業授權）。B 端客戶是第三方企業，Eimu 是「以公司身分商業使用權重」的服務方 | 同上 |
| 把 YuE2 權重再散布／轉售／打包進對外服務供他人下載 | **不可以**（明文禁止 commercial redistribution or sale of the model weights） | 來源 A 末段 |
| 只在**創作側**用 YuE2 產 ABC 樂譜作為內部素材，最終音檔改由 Lyria 生成後交付 | **可討論**（交付物不含 YuE2 權重產出；但 ABC 是否構成衍生仍屬解釋空間）→ 屬**推論**，若真要落地建議先書面問授權方 | 推論，非事實 |

**關鍵推論（請暴君注意）**：這條授權紅線**不區分「獨佔主力」與「混合路由中之一支」**。只要 YuE2 的產出最終賣給了付費方（套餐用戶或 B 端 key），就是公司商用權重。**因此選項 C（混合路由）在法律上與選項 B 同等卡關**——除非 C 的定義嚴格限定為「YuE2 產出永不交付給付費方，只作內部／個人創作側使用」。

**授權洽談入口**：`ryuanab@connect.ust.hk`（來源 A 逐字）。這是唯一能解鎖 B/C 的動作，且它是一個**人的回信週期**，不是技術問題——建議把它當成與技術 POC 並行的獨立軌道。

---

## 5. 接入點清單（file:line，均已現場 grep 驗證）

### 5.1 現任 Lyria / FlowMusic2API 通路

驗證指令與結果：

```bash
cd /home/lenovo/Desktop/image-app
grep -n "FLOWMUSIC_MODELS = \|isFlowMusic2ApiEnabled" src/lib/music-flowmusic.ts
# 30:export const FLOWMUSIC_MODELS = {
# 54:export function isFlowMusic2ApiEnabled(): boolean {
grep -n "export type MusicChannel" src/lib/music-prompt-director.ts
# 31:export type MusicChannel = "flowmusic" | "lyria" | "yue2";   ← 原為 "flowmusic" | "lyria"
grep -n "MUSIC_HARNESS_TOOL_IDS" src/lib/harness-tool-registry.ts
# 22:import { MUSIC_HARNESS_TOOL_IDS } from "./music-tools"
# 140:  ...MUSIC_HARNESS_TOOL_IDS,
grep -n "music: {\|taskTypes: \[\"music\"" src/lib/expert-registry.ts
# 149:  music: {
# 155:    taskTypes: ["music", "song", "bgm", "mv_theme", "theme_song"],
grep -n "MUSIC_DELIVERABLES = " src/lib/music-delegate.ts
# 52:export const MUSIC_DELIVERABLES = ["emotion_contract", "lyrics", "melody_notation", "audio_url", "duration_source", "qc"] as const;
```

| 檔案 | 位置 | 內容 | 換 YuE2 時的處置 |
|---|---|---|---|
| `src/lib/music-tools.ts` | L297-330 | `musicGenTool.description` 與四個 args 文案（`prompt`/`lyrics`/`duration_hint`/`reference_images`） | **需改**（已由並發片改為三通路文案） |
| `src/lib/music-tools.ts` | L344 | `const yue2Enabled = isYue2ModalEnabled()` | 已存在（工作區） |
| `src/lib/music-tools.ts` | L365 | `const directorChannel = yue2Enabled ? "yue2" : flowMusicEnabled ? "flowmusic" : "lyria"` | 已存在 |
| `src/lib/music-tools.ts` | L379 | `await generateYue2Track({ style, lyrics, cot: YUE2_TOOL_COT })` | 已存在 |
| `src/lib/music-tools.ts` | L437 | 回執 `channel: yue2Enabled ? "yue2_modal" : ...` | 已存在 |
| `src/lib/music-tools.ts` | L446 / L448 | `score_abc` / `yue2_truncated` 回執欄 | 已存在（白盒進交付契約的接點） |
| `src/lib/music-tools.ts` | L459-464 | `reference_image_count` / `reference_images_note` | 已存在 |
| `src/lib/music-tools.ts` | L479 | `export const MUSIC_HARNESS_TOOL_IDS = ["music_gen"]` | 不變 |
| `src/lib/music-flowmusic.ts` | L30 / L54 | `FLOWMUSIC_MODELS`、`isFlowMusic2ApiEnabled()` | 保留（降級通路） |
| `src/lib/music-prompt-director.ts` | **L31** | `MusicChannel` 聯合（spec 所述 L29 → **現場已漂到 L31**） | 已含 `"yue2"` |
| `src/lib/music-prompt-director.ts` | L84 | `CHANNEL_LIMITS.yue2Style: 3000` | 已存在 |
| `src/lib/music-prompt-director.ts` | L546 | `else if (channel === "yue2")` 分支（剝時間戳、3000 版面預算） | 已存在 |
| `src/lib/music-delegate.ts` | L52 | `MUSIC_DELIVERABLES` 六欄（含 `melody_notation`） | **需改**（樂譜改由工具回執真源供給） |
| `src/lib/music-delegate.ts` | L249-253 | `melody_notation` 可判形態指引 | **需改**（若 ABC 由工具供給，此引導可下沉為後端注入） |
| `src/lib/expert-registry.ts` | L149-160 | `music` Expert 註冊（`taskTypes` L155） | **不改**（與通路無關） |
| `src/lib/harness-tool-registry.ts` | L22 / L140 | `music_gen` 工具登記 | **不改** |
| `src/lib/music-director-persona.ts` | L46 / L59 | persona 描述（現文案寫「自主驱动 Lyria 产出」）與工具白名單 | **需改文案**（Lyria 不再是唯一） |
| VPS `.env` | `/opt/agent-harness/.env` | `FLOWMUSIC2API_URL`、`FLOWMUSIC2API_KEY`、`GEMINI_API_KEY` 皆已配置（key 名實測）；`.env.opencode` 權限不足未讀 | **需加** `YUE2_MODAL_ENDPOINT`、`YUE2_HMAC_SECRET` |

### 5.2 新增檔（工作區，未提交）

| 檔案 | 內容 |
|---|---|
| `src/lib/music-yue2.ts` | YuE2 Modal client（HMAC 簽名、`/generate`、`YUE2_TIMEOUT_MS=600000`、`YUE2_MODEL_ID="m-a-p/YuE2-3B"`、`YUE2_COT_MODES`） |
| `deploy-staging/yue2-modal/yue2_common.py` | Modal app 側（**僅此一檔，`out/` 空**）→ 實測數字 pending |

---

## 6. Harness 缺口分析（框架：Harness = 需求上限 − 底模能力下限；層級順序＝工具注入 > 後端判定 > prompt 條款）

| # | 缺口 | 內容 | 層級 | 狀態 |
|---|---|---|---|---|
| 1 | 情緒契約 → style/lyrics 轉譯 | `buildLyriaStylePrompt`（`music-lyria.ts:71`）已能把 `style/genre/bpm/musicalKey/mood/structure/instrumental` 確定性拼成 prompt；YuE2 的 `style` 是散文欄、`lyrics` 必填 | 工具層 | **已有可複用**（拼裝邏輯沿用；`structure` 欄在 YuE2 無效需剝除——director 已做） |
| 2 | 情緒契約 → **ABC 樂譜** | 需求上限側的正解：把 `bpm`/`musicalKey`/`mood` 從 NL 欄位升級為**可判定**的 ABC 參數或後處理（改 `score.abc` 的 tempo/key 標頭）| 後端判定 | **需新建** |
| 3 | `cot` 選擇策略 | `full`＝唯一回樂譜、`melody`＝翻唱、`off`＝最快。工具層現固定 `YUE2_TOOL_COT="full"`（`music-tools.ts:207`），不給模型選 | 後端判定 > prompt | **已有（硬編）**；若要按任務型態分流＝**需新建**（應在後端判定，勿寫進 prompt 條款） |
| 4 | ABC 樂譜進交付契約 | `MUSIC_DELIVERABLES` 已含 `melody_notation`，但現制是**導演正文文案欄**（缺整欄＝未交付、`collect` 不偽造）；YuE2 讓它變成**工具真源產物** | **工具注入**（最高 ROI 層） | **可複用官方 `skills/yue2-music`（Apache-2.0）＋需改**：把 `score_abc` 從工具回執直接注入 payload，別再靠模型「記得寫」 |
| 5 | 翻唱工作流（SheetSage2 扒譜） | SheetSage2 與 YuE2 **依賴版本不同、需分離環境**，以 ABC／音檔交換（`docs/covers.md:5-7`）；`cot="melody"` ＋ 無和弦符號的樂譜 | — | **需新建**；**可複用**官方 `skills/yue2-music`（含 cover 指南） |
| 6 | 樂譜品質 QC 門禁 | ABC parse 不變量（拍號／音域／段落數）、`truncated` 檢查 | 後端判定 | **需新建**；官方 `skills/yue2-music` 已含「check musical invariants」可複用 |
| 7 | 失敗／截斷處理 | `truncated` flag 已回執（`yue2_truncated`，`music-tools.ts:448`），但**交付閘門尚未依它攔截** | 後端判定 | **需新建**：`truncated` 非空 → 組裝閘門應拒收或標降級，不得靜默交付 |
| 8 | 並發（一次一請求）對編排的影響 | 上游「one request at a time」；多個 Expert 任務並發會**排隊**，600 s timeout 可能被打穿 | 後端判定 | **需新建**：orchestrator 派工協議需序列化音樂任務，或 Modal 側排隊回報 |
| 9 | 音頻入庫鏈 | gateway MIME 表已補 `.m4a/.aac/.ogg/.flac/.opus`，FLAC 可入庫 | — | **可複用**（`[背]` 記憶 `audio-ingest-404-and-audio-card-0911`；該記憶另記 gateway 只認 `/attachments` 非 `/uploads`） |
| 10 | 時長真源 | `measureAudioDuration`（ffprobe）已存在；YuE2 另回上游自報 `duration_s` → 新增 `duration_source="upstream_reported"` | 工具層 | **已有**（`music-tools.ts:431`） |
| 11 | 配方庫（must-load skill） | `skills/music-director/` 12 檔 SunoForge（MIT）；通路判定表已列 FlowMusic2API vs Gemini 直連 | — | **需改**：新增 `DATA_YUE2_2026-09.md` DATA 檔（CORE 檔一字不動——CORE/DATA 分離哲學） |
| 12 | 交付契約 `melody_notation` 的語義升級 | 現指引要求「音名字符序列（例 A4–C5–B4–A4）」，而 YuE2 給的是完整 ABC——粒度不同，需重寫判據 | 後端判定 | **需改** |

**層級正確性提醒（依 harness doctrine）**：第 2、4、6、7、8 項都必須落在**工具注入／後端判定**；若把它們寫成 prompt 條款（「請記得檢查 truncated」「請記得輸出樂譜」），依 doctrine 屬「背離警報」——需要模型記得才生效的，不是防線。

---

## 7. 風險清單（依嚴重度排序）

| # | 風險 | 嚴重度 | 證據 |
|---|---|---|---|
| 1 | **非商用授權**：權重 CC BY-NC 4.0，公司商用需另談。Eimu 為付費產品＋B 端 key，**B/C 兩選項皆卡此線** | **致命（法律）** | §4.1 逐字引用（`MODEL_LICENSE`「The individual creator permission does not authorize commercial use of the model weights by companies.」） |
| 2 | **image-to-music 能力回退**（MV 分鏡→樂賣點） | 高 | YuE2 **無**圖像介面 `[現]`（官方文檔全篇無）。**但**現任主力 FlowMusic2API 亦不支援（`music-tools.ts:459-464`）→ 實際回退幅度**僅在「現行是否走 Gemini 直連」成立時才存在**，需暴君確認 |
| 3 | **無 30 s 短檔**（互動預覽／快速試聽缺位） | 中高 | YuE2 契約無時長欄位（`music-yue2.ts:13` 凍結合約；`music-tools.ts:316-317` 已改為對 `clip30` **直接報錯**）。現任亦非真短檔（`lyria-fast` 與 `lyria` 規格全等，實測 162–182 s）→ 雙方皆缺 |
| 4 | **分鐘級延遲 vs 互動體驗** | 中高 | 現任 162–182 s `[現]`；YuE2 官方「one request at a time」＋分鐘級 `[現]`，且冷啟「seconds to minutes」`[現]`。**Modal 實測 RTF pending**，無法判定是否劣於現任 |
| 5 | **24 GB 顯存底線，fp8/offload 品質未驗** | 中 | 官方「NVIDIA GPU with BF16 support and 24 GB VRAM」`[現]`。fp8＋`offload_ar` 降到 12–16 GB `[背]`（未獨立複核）→ **未證**，若真要走低顯存必須先驗品質不退 |
| 6 | **7.26 GB 權重冷啟** | 中 | `model.safetensors` = 7,261,441,640 bytes（HF API `?blobs=true`，2026-09-18）；Modal cold start「seconds to minutes」`[現]`。實際載入時間 `未證`（片 A 的 `timing.model_load_ms` 會給答案） |
| 7 | **Modal 帳號 GPU 配額** | 中 | 帳號 verenowo 已有 blender-modal app 在跑 `[背]`；**音樂 app 的配額餘量未證**，Modal 需先綁付款方式/申請配額的機率存在 |
| 8 | **單容器並發 1** | 中 | 官方「one request at a time」`[現]`；多任務並發會排隊，需編排序列化（§6 #8） |
| 9 | **白盒樂譜是資產還是新負擔** | 中 | 正面：可編輯＝agent 可迭代、可做 QC 門禁（真值可判定）。負擔：需新增 ABC 保存策略（誰存／存哪／誰可改）、版本可比性（官方要求 pin `revision`/`vae_revision`，`docs/generation.md:57`）、交付契約語義升級（§6 #12）。**這是唯一「換過去之後我們會多出工作」的維度** |
| 10 | 上游 FlowMusic2API 逆向封裝可能封號 | 低（與本決策無關，但為現任風險） | `[背]` 記憶 `music-gen-frontier-2026-09.md:81` |
| 11 | 第三方 `m-a-p/YuE2-3B` 權重來源可信度 | 低 | HF 官方 org `m-a-p`、arXiv 2503.08638、repo 9.6k★ `[現]`（HF API tag `arxiv:2503.08638`） |

---

## 8. 三條可拍板選項

### 選項 A：只當第二通路／非商用內部 POC（不影響現任主力）

- **做法**：`YUE2_MODAL_ENDPOINT` 不進生產 VPS；只在本地／內部環境跑，用於評測音質、驗證 Modal 真實 RTF 與成本、把白盒樂譜接進 pipeline 試跑。產出**不交付給付費方**。
- **代價**：Modal 實測成本（$30/月 Starter 免費額度可能就夠 POC）；不解決 bearer 痛點（主力仍 Lyria）。
- **適用**：想先拿真數據再決定；授權談判尚未啟動。
- **合規**：**完全安全**（CC BY-NC 的非商用研究／內部評估）。

### 選項 B：換成產品主力（前置＝商用授權）

- **做法**：`YUE2_MODAL_ENDPOINT` 進 VPS `.env`，優先序高於 FlowMusic2API；Lyria 退為降級通路；`cot`/樂譜 QC/序列化編排全數落地。
- **代價**：①**必須先拿到商用授權**（`ryuanab@connect.ust.hk`，週期不可控）；②Modal 成本（稀疏請求下每首 $0.15，批量 ≥4 首/暖窗才低於 $0.08）；③image-to-music 徹底歸零（若 Gemini 直連還在，這刀砍掉的是 MV 分鏡→樂）；④分鐘級延遲＋單並發。
- **適用**：**只有在商用授權到手後才成立。**

### 選項 C：按用途混合路由（有分鏡圖的 MV → Lyria；要白盒樂譜／翻唱的創作 → YuE2）

- **做法與代價**：技術上最漂亮（各取所長），`music-tools.ts` 三通路分支已具備雛形。
- **但**：**法律上與 B 同等卡關**——只要 YuE2 產出賣給付費方，就是公司商用權重（§4.2）。所以 C 若要合規，必須重新定義為：
  - **C′（合規版）**：YuE2 只用於**內部創作側**（暴君／內部 agent 產出樂譜當素材），對外交付的音樂一律由 Lyria 生成；或
  - **C″（同 B 前置）**：拿到商用授權後才允許對外交付。
- **適用**：若 C′ 的價值成立（白盒樂譜作為內部生產力工具），這是**授權解鎖前唯一能做的實質落地**。

### 建議

**採 A，並行推進兩件事：(1) 把商用授權洽談當獨立軌道啟動；(2) 用片 A 的 Modal 實測把 §3 的 pending 全部補實。**

理由：
1. **法律是唯一硬閘門，且與技術無關**——B 與 C（對外交付版）都卡同一格，授權信寫出去的回信週期是關鍵路徑，越早啟動越好；技術 POC 可以完全並行，不浪費等待時間。
2. **技術面已超前**：YuE2 第三通路（`music-yue2.ts`、三通路分支、director `yue2` channel、Modal app 骨架）已由並發片落在工作區，A 選項的邊際成本已經很低——現在不驗，等於把已付出的沉沒成本擱著。
3. **成本不構成換主力的理由**：現任現金邊際 ≈ $0（credit 池），YuE2 在稀疏請求下反而貴 89%（$0.1514 vs $0.08）。唯一站得住的理由是**能力**（白盒樂譜／翻唱）與**消除 bearer 維運**——而前者對外賣、後者省暴君時間。
4. **不要為了 MV 分鏡→樂去換**：那是 Lyria 的 Gemini 直連能力，換掉主力反而可能把它一起砍掉（且現行 FlowMusic2API 已停用它，這筆帳要先算清）。
5. **明確不做**：不要在授權到手前把 `YUE2_MODAL_ENDPOINT` 寫進生產 `.env`。HTTP 200 不等於可用，能生成不等於能賣。

---

## 附錄：本文件的事實驗證指令（可複現）

```bash
# Modal 費率與 scaledown_window（官方頁面）
# https://modal.com/pricing                                → GPU $/s 表（§3.1）
# https://modal.com/docs/guide/cold-start                  → 默認 idle 60s、範圍 2s–20min、idle 計費（§3.1）

# 授權逐字
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/MODEL_LICENSE | sed -n '1,80p'
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/README.md | sed -n '221,235p'

# 權重大小
curl -s "https://huggingface.co/api/models/m-a-p/YuE2-3B?blobs=true" | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print([ (s['rfilename'],s.get('size')) for s in d['siblings'] if s['rfilename']=='model.safetensors'])"

# YuE2 能力邊界
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/docs/generation.md | head -5
curl -sL https://raw.githubusercontent.com/multimodal-art-projection/YuE/main/docs/covers.md | head -8

# 接入點行號（現場工作區，2026-09-18）
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

# Modal 實測（pending，片 A）
ls -la deploy-staging/yue2-modal/ deploy-staging/yue2-modal/out/
```
