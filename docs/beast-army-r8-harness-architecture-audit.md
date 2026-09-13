# R8 — AI 助理 Harness 架構審計：智能重疊 / MoE+Orchestrator 實現不完全 / Dense 殘留

日期：2026-09-10。性質：**唯讀審計**，不含修復。審計對象＝野獸模式（beast_mode ON）下的
「Orchestrator + Expert 軍團」架構。真源＝VPS `/opt/agent-harness/`（活碼）＋本機
`src/lib/`（契約）＋`deploy-staging/expert-gateway/`（提示詞稿）。

---

## 0. 執行摘要（結論先行）

**一句話**：MoE 改革交付的是「**宣告面**」（註冊表、契約、測試、提示詞檔），但「**執行面**」
（gateway 的 agent 工具表、路由調用點、交付閘門）沒交付；而 Dense 時代的 AGENTS.md
從未被納入改革範圍。三軸問題同源。

| # | 結論 | 性質 | 座標 |
|---|---|---|---|
| E1 | **MoE 路由層在生產端零調用**：`routeExpert` / `EXPERT_REGISTRY` / `buildOrchestratorFrame` / `assertExpertToolAccess` 全 repo 只有測試引用，VPS gateway 全域 grep 零命中 | 未接線 | VPS `gateway/` 全域 grep；本機 `src/**/*.test.ts` |
| E2 | **能力斷路只落地 4/25 = 16%**：orchestrator agent 只關 4 個工具，21 個 Expert 域工具仍開在 Orchestrator 手上 | 半接線 | `workspace/.opencode/opencode.json` → `agent.orchestrator.tools` |
| E3 | **Expert 端零工具限制（反向漏洞）**：子會話建立 `POST /session` body `{}`、投遞 `prompt_async` body 只有 `parts`，無 `agent` 欄 → 子代理拿到全部 97 工具。憲法「域外工具不在你的工具表裡」是**假的** | 未接線 | `gateway/subagent.ts` L256-295 |
| E4 | **交付物閘門完全不存在**：憲法第二條第 3 款＋digest 頭行宣告的「組裝閘門」，gateway 全域 grep `deliverable\|qcSignature\|DELIVERABLES` 零命中 | 未接線 | VPS `gateway/index.ts`、`subagent.ts` |
| E5 | **digest 仍讀靜態檔**（R7 遺留工單 #1 未動）：`readFileSync(expert/registry-digest.txt)`；本機 `buildExpertRegistryDigest()` 動態生成函數存在但生產不用 | 未接線 | `gateway/index.ts:4210` |
| E6 | **兩行 Expert 零獨佔能力**：director3d 與 web3d-director 的工具表 **0 個獨佔工具**；`image_quote` 出現在全部 7 行 | 設計缺陷 | `src/lib/expert-registry.ts` + digest |
| E7 | **AGENTS.md 與 playbook 正面矛盾**：AGENTS.md §2「你负责扩写成完整 prompt」 vs playbook 第〇節「你本人不產出任何內容…即違憲」 | Dense 殘留 | VPS `workspace/AGENTS.md` L36-48 vs playbook L14 |
| E8 | **兩條注入路徑互不知情**：gateway 完全不碰 AGENTS.md（grep 零命中），`opencode.json instructions: []` → AGENTS.md 靠 opencode 原生載入，與野獸幀分屬不同通道，先後順序無程式保證 | 架構缺口 | `gateway/index.ts` vs `workspace/AGENTS.md` |
| E9 | **playbook 宣告的作戰面 ⊄ registry 宣告的域白名單**：playbook 軍團用的 `search_web` / `vision_analyze` / `image_generate` / `workflow_*` / `asset_search` **不屬於任何 Expert** | 契約不一致 | playbook 第〇節 step 1/6/7 vs digest 7 行 |
| E10 | **3/7 Expert 配方庫為空**：video-director / editor / screenwriter 的 `*_PERSONA_SKILL_PATHS = []`，憲法第三條「進 Expert 即載配方庫」對其無法履行 | 未接線 | `src/lib/{video-director,editor,screenwriter}-persona.ts` |

---

## 1. 審計範圍與方法

方法：**「宣告 vs 物理事實」對照**。對每一項 MoE 契約聲明，追到 gateway 的實際執行點；
追不到即判定為「契約宣言」而非事實。

證據來源（全部第一手，非記憶轉述）：

| 層 | 位置 |
|---|---|
| 活碼 | VPS `/opt/agent-harness/gateway/{index.ts,subagent.ts}`、`gateway/expert/` |
| 配置 | VPS `/opt/agent-harness/workspace/.opencode/opencode.json`、`workspace/.opencode/tools/`（97 檔） |
| 提示詞 | VPS `workspace/AGENTS.md`（172 行 / 22874 字）、`gateway/expert/*.md` |
| 契約 | 本機 `src/lib/expert-registry.ts`、`*-persona.ts`、`*-delegate.ts`、`orchestrator-beast-frame.ts` |

前置背景：`docs/beast-army-r7-injection-audit.md`（R7 已修注入管線元數據污染，並留下三條遺留工單——
本審計逐條驗證其現況）。

---

## 2. 軸一：智能重疊

### 2.1 工具白名單獨佔度矩陣

EXPERT_REGISTRY 7 行宣告的域工具共 **25 個去重**，其中 **20 個為某行獨佔、5 個跨行共享**：

| Expert | 工具數 | 獨佔工具 | 獨佔數 | 共享來源 |
|---|---|---|---|---|
| director3d | 4 | —— | **0** | `blender_exec`(+motion)、`blender_export_gltf`(+web3d)、`blender_render`(+motion)、`image_quote`(全部) |
| music | 2 | `music_gen` | 1 | `image_quote`(全部) |
| video-director | 4 | `video_quote`、`last_frame_video_chain` | 2 | `video_upload`(+editor)、`image_quote` |
| editor | 11 | `timeline_ops`/`_query`/`_rhythm`/`_style`/`_mix`/`_master`/`_lint`/`_restore`、`editing_manifest`、`audio_first_timeline` | 10 | `video_upload`(+video) |
| screenwriter | 7 | `script_scene_parse`、`storyboard_qc_17`、`story_sequence_consistency`、`canvas_apply_ops`、`doc_struct`、`world_bible_extract` | 6 | `image_quote` |
| motion-director | 4 | `keyframe_render` | 1 | `blender_exec`/`blender_render`(+director3d)、`image_quote` |
| web3d-director | 2 | —— | **0** | `blender_export_gltf`(+director3d)、`image_quote` |

**判定**：
- `image_quote` 在 7 行全出現 → 它是**全域公共前置**（報價對偶），不是域職能。把它寫進每一行的
  域白名單，等於宣告「每個專家都有一樣的權限」，稀釋白名單語義。
- **director3d 與 web3d-director 零獨佔**。這兩行在工具面不可區分——`web3d-director` 的
  `{blender_export_gltf, image_quote}` 是 `director3d` 的**嚴格子集**。
- director3d 與 motion-director 共享 3/4 工具，唯一分界是 `keyframe_render` vs `blender_export_gltf`。

### 2.2 路由優先序把最高優先權給獨佔度最低的行

`routeExpert()` 是 `Object.values(EXPERT_REGISTRY)` **插入序 + 首個命中即返回**
（`src/lib/expert-registry.ts:242-258`）。插入序 = director3d、music、video-director、editor、
screenwriter、motion-director、web3d-director。

配合前綴匹配（邊界符集 `-_. /:` 含 `_`），實際後果：

| 輸入 taskType | 實際命中 | 直覺期待 | 判定 |
|---|---|---|---|
| `3d_motion` | director3d（`3d` + `_` 邊界） | motion-director | **吞掉** |
| `blender_animation` | director3d（`blender` + `_`） | motion-director（`animation`） | **吞掉** |
| `motion_3d` | motion-director | motion-director | 正常 |
| `animation` | motion-director | motion-director | 正常（唯一入口） |

**判定**：獨佔能力為 0 的行（director3d）拿到最高路由優先權，且其 `3d` / `blender` 前綴會
吞掉本該屬於 motion-director 的複合 taskType。路由順序與能力判別力**反向**。

### 2.3 角色職能邊界模糊對

| 對 | 三者關係 | 現存判別式 | 判定 |
|---|---|---|---|
| director3d / motion-director / web3d-director | 同屬 3D 生產，工具面重疊 2-3/4 | 無。只有 label（「3D 导演」/「动态设计」/「Web3D 导演」）與 taskTypes 字串差異 | **邊界缺失** |
| video-director / editor / screenwriter | 同屬影片生產鏈相鄰環節 | 工具面尚可區分（各 2/10/6 獨佔），但 taskTypes 出現 `film_clip`（video）vs `film_assembly`（editor）這種**人為分化的一對** | **邊界可疑**：`film_clip` 與 `film_assembly` 在真實請求中極難區分誰屬誰 |

### 2.4 規則文本重複

「誠實鐵律」在同一 turn 的上下文出現 **3 處**：

| 處 | 位置 | 內容規模 |
|---|---|---|
| Expert 憲法 第一條 | `gateway/expert/expert-constitution.md` | 5 款（已提交⇔ok:true / 不宣稱未驗證成功 / 失敗帶原文 / 連續失敗合併播報 / 抄輪子連錯誤提取層） |
| AGENTS.md §3.7 | `workspace/AGENTS.md` L75 起 | 「能力宣称对帐：没有系统证据不许宣称」 |
| playbook 第三節 | `gateway/expert/orchestrator-dispatch-playbook.md` | 安全紅線（secret 衛生 / 禁 headless / 外部副作用 / 覆蓋前 diff） |

**判定**：三處同源一致、措辭不衝突 → **冗餘但安全**。但三處**均未聲明彼此優先序**，
且合計佔用可觀 prompt 預算。屬「可接受的浪費」，不是缺陷——除非後續出現措辭漂移。

### 2.5 交付物契約重疊

7 個 `*_DELIVERABLES` 在 registry 中宣告 `deliverableContract.requiredFields` +
`qcSignatureRequired: true`（7/7 全 true）。契約本身由各 delegate import，無手抄漂移。

**但**：該契約**從未進入任何 prompt**——`buildExpertLine()`（`orchestrator-beast-frame.ts:42-45`）
與 VPS digest 都只輸出 `taskTypes` 與 `toolIds`，**不含 `skillPaths` 與 `deliverableContract`**。
後果：Orchestrator 寫派遣 spec 時，**無從得知**該 Expert 該載哪個配方庫、交付物要哪些欄位——
而 playbook 第一節 spec 七件套要求它寫「驗收標準」。驗收標準的唯一來源（契約）沒進它的上下文。

---

## 3. 軸二：MoE + Orchestrator 架構目標實現不完全

### 3.1 三件套接線狀態總表

MoE 設計的三件套：**能力斷路 / 路由門禁 / 交付物閘門**。

| 件 | 宣告處 | 物理實現 | 狀態 |
|---|---|---|---|
| 能力斷路（Orchestrator 端） | digest 頭行、憲法第二條、`agent.orchestrator` 描述 | `opencode.json` → `agent.orchestrator.tools` 只有 4 個 `false` | **16% 半接線** |
| 能力斷路（Expert 端） | 憲法第二條第 1 款「域外工具不在你的工具表裡」 | 無 | **未接線（實為虛假聲明）** |
| 路由門禁 | `routeExpert()` + `assertExpertToolAccess()` | 生產零調用 | **未接線** |
| 交付物閘門 | 憲法第二條第 3 款、digest | 無 | **未接線** |

### 3.2 能力斷路實測（E2）

`workspace/.opencode/opencode.json` → `agent.orchestrator`：

```json
{
  "mode": "all",
  "description": "MOE Orchestrator（野獸模式主會話）：域工具已斷路，只能 subagent_dispatch 派發 Expert",
  "tools": {
    "blender_exec": false,
    "blender_render": false,
    "blender_export_gltf": false,
    "music_gen": false,
    "question": true
  }
}
```

對照 EXPERT_REGISTRY 宣告的 25 個域工具，**仍開在 Orchestrator 手上（21 個）**：

- `image_quote`
- `video_quote`、`video_upload`、`last_frame_video_chain`
- `timeline_ops`、`timeline_query`、`timeline_rhythm`、`timeline_style`、`timeline_mix`、
  `timeline_master`、`timeline_lint`、`timeline_restore`
- `editing_manifest`、`audio_first_timeline`
- `script_scene_parse`、`storyboard_qc_17`、`story_sequence_consistency`、`canvas_apply_ops`、
  `doc_struct`、`world_bible_extract`
- `keyframe_render`

**語義批判**：被關掉的 4 個（blender×3 + music_gen）恰好是**只有 director3d/music/motion 三個
Expert 需要**的工具；而**擁有最多獨佔工具的 editor（10 個）與 screenwriter（6 個）的域工具
一個都沒斷**。斷路密度與 Expert 專業化程度**反向**。

另註：gateway 自己的註釋已承認此為留樁——`gateway/index.ts`
「現階段 gateway 無 per-subagent 工具白名單掛點，物理斷路留樁，先靠 prompt 約束」。

### 3.3 Expert 端工具隔離缺失（E3，反向漏洞）

`gateway/subagent.ts` L256-295 `dispatchAttempt()`：

```ts
const res = await fetch(`${deps!.openCodeUrl}/session`, {
  method: "POST", headers: deps!.openCodeHeaders(), body: "{}", ...
})
...
const body: Record<string, unknown> = { parts: [{ type: "text", text: `${constitutionNote}${run.prompt}` }] }
if (model) body.model = model
```

- `POST /session` body `{}` → **無 `agent` 欄**
- `prompt_async` body 只有 `parts` + `model` → **無 `agent` 欄**

子會話因此使用**預設 agent**（`opencode.json` 的 `model: b-ai/qwen3.8-flash` + 無 `tools` 限制）
→ 拿到 `workspace/.opencode/tools/` 全部 **97 個工具**。

**這使憲法第二條第 1 款的宣告成為虛假陳述**：Expert 實際持有全部工具，包括其他 6 個 Expert 的
域工具。能力斷路在 Expert 端為 0。

### 3.4 路由層零消費方（E1）

| 符號 | 本機生產碼消費方 | VPS gateway 消費方 |
|---|---|---|
| `routeExpert` | 無（僅 `*.test.ts`） | 無（grep 零命中） |
| `assertExpertToolAccess` | 無（僅 `expert-registry.test.ts`） | 無 |
| `EXPERT_REGISTRY` | 無（僅測試） | 無 |
| `buildOrchestratorFrame` | 無 | 無（gateway 自行重寫同構邏輯） |
| `buildExpertRegistryDigest` | 無（僅測試） | 無（改讀靜態檔） |

**後果**：`taskTypes` 這套路由鍵在生產**從未被查詢**。實際的「選哪個 Expert」機制是
**Orchestrator 在自然語言 spec 裡自己寫**（例如「你是 3D 導演 Expert」），沒有程式介入。

**因此生產中的「MoE」實質為**：1 個 orchestrator agent + N 個**通用子會話**做角色扮演。
不是專家切換，是**提示詞角色扮演**。VPS 的 `opencode.json` `agent` 鍵下**只有 `orchestrator`
一個 agent**（`['orchestrator']`），不存在 7 個 Expert agent 實例。

### 3.5 digest 仍為靜態檔（E5）

`gateway/index.ts:4210`：

```ts
digest = readFileSync(`${import.meta.dir}/expert/registry-digest.txt`, "utf8")
```

註釋（L4196）自認：「摘要（靜態檔 gateway/expert/registry-digest.txt，本地
buildExpertRegistryDigest 生成上傳）」。

R7 遺留工單 #1「digest 改為 gateway 注入時從 registry 現算」**未執行**。漂移風險仍在：
本機 `EXPERT_REGISTRY` 改一行，VPS digest 不會跟進，除非記得手動重新導出＋上傳。

### 3.6 交付物閘門不存在（E4）

```
$ grep -rn "deliverable\|qcSignature\|qc_signature\|DELIVERABLES" gateway/index.ts gateway/subagent.ts
（零命中）
```

憲法第二條第 3 款原文：「你的交付物必須符合契約 schema。缺欄位、缺 QC 簽名 = 組裝閘門不過 =
視為未交付，不管你實際做沒做完。」

**判定**：契約宣言，非事實。子代理回報是一段自由文字 summary（`subagent.ts` `finishRun` →
`summary`），無 schema 校驗、無 QC 簽名檢查。

### 3.7 配方庫空缺（E10）

憲法第三條第 1 款：「進 Expert 即載配方庫。這是 must-load 常駐，不是『高興才查』。」

實測：

| Expert | `skillPaths` | 狀態 |
|---|---|---|
| director3d | `skills/blender-director/SKILL.md` | 有 |
| music | `skills/music-director/SKILL.md` + files | 有 |
| motion-director | `skills/motion-design/` | 有（指域目錄） |
| web3d-director | `skills/web-3d-awwwards/SKILL.md` | 有 |
| **video-director** | `[]` | **空** |
| **editor** | `[]` | **空** |
| **screenwriter** | `[]` | **空** |

3/7 Expert 無配方庫可載 → 對它們而言，「配方優先」鐵律無法履行。
且如 §2.5 所述，`skillPaths` 根本不進注入幀，Orchestrator 也無從在 spec 裡指派。

### 3.8 beast gate 覆蓋（本軸唯一無缺口處）

`beast_mode === true` 的判定點（VPS grep）：

| 行 | 用途 |
|---|---|
| `index.ts:809` | 主會話掛 `agent: "orchestrator"` |
| `index.ts:4203` | 主 prompt 野獸幀注入閘門 |
| `index.ts:4241` | `promptBody.agent = "orchestrator"` |
| `index.ts:7429/7437/7451` | settings 讀寫與 sanitize |
| `index.ts:7702` | `initSubagent` 的 `beastMode` 快照 |
| `subagent.ts:284` | 子會話憲法注入 |

子會話注入走 `dispatchAttempt()`，重試路徑 `retryWithNextModel()` → `dispatchAttempt()`
同路徑，**無繞過分支**。R7 修的 strip＋狀態行在兩端均在位（`index.ts:4219-4221`、
`subagent.ts:287`）。

**判定**：注入覆蓋完整。本軸的缺口全部在**架構宣告 vs 執行**，不在注入管線。

---

## 4. 軸三：Harness 層殘留 Dense 架構提示詞

主殘留源：VPS `workspace/AGENTS.md`（172 行 / 22874 字）。該檔在 MoE 改革（2026-09-08）
**未被修訂**，仍描述「單一全能 agent」。

### 4.1 §1 路由決策表（L13-33）逐列盤點

表格 18 列全部是「使用者意圖 → 直調工具」的 Dense 指令：

| 列（意圖） | AGENTS.md 教的直調 | MoE 下應由 | Expert 存在？ | 判定 |
|---|---|---|---|---|
| 画图（想法层面） | `image_generate` + `image_quote` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 画图（完整 prompt） | `image_generate` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 改图/参考图编辑 | `image_edit` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 复用素材/3D/动作 | `asset_search` → `asset_activate` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 放大 | `image_upscale` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 生影片（单镜） | `video_quote` → `/v1/videos/generations` | video-director | 是 | **Dense 殘留-應改派** |
| 生影片（多镜/长片） | `workflow_*` + 讀 `attach/workflow-video-rules.md` | 無對應 Expert | **否** | Dense 殘留-無承接者＋應派 |
| 看图/读图 | `python3 read_image.py` | 無對應 Expert | **否** | Dense 殘留-主腦 bash 動手 |
| 写真/人像摄影 | `skill nuyoah-xiezhen-prompt` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 参考图反推 | read-image + `skill nuyoah-image-reverse-prompt` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 广告/UGC shot 提示词 | `skill ai-ad-prompt-guide` | 無對應 Expert | **否** | Dense 殘留-無承接者 |
| 选模型/找替代 | GET `/v1/model-status` | 無對應 Expert | **否** | Dense 殘留-合理保留（Orchestrator 職責） |
| 配音/TTS | `tts_speak` | 無對應 Expert | **否** | Dense 殘留-應派（editor 域鄰近） |
| 剪辑/时间线调整 | `timeline_query` → `timeline_ops` → 回讀 diff | editor | 是 | **Dense 殘留-應改派** |
| 节奏体检 | `timeline_rhythm` | editor | 是 | **Dense 殘留-應改派** |
| 剪辑回退/撤销 | `timeline_query` → `timeline_restore` | editor | 是 | **Dense 殘留-應改派** |
| 工具优先级句 | 「原生工具（`image_*` / `canvas_*` / `workflow_*` / `tts_speak` / `timeline_*`）> bash curl」 | —— | —— | **Dense 殘留-直接教用 Expert 域工具** |

**統計**：18 列中 **6 列**有明確 Expert 承接者（應改派而未改）、**9 列**根本沒有 Expert 承接
（MoE 覆蓋缺口，Orchestrator 只能自己做或派給無白名單的通用 subagent，見 §3.3/§4.4）、
**1 列**合理保留（model-status 屬 Orchestrator 職責）。

### 4.2 §2 生成 prompt 硬規則（L36-48）——與 playbook 正面衝突

AGENTS.md §2 第 1 款原文：

> **先增强再发送**：禁止把用户原始一句话直接当 prompt，**你负责扩写成完整 prompt**。

playbook 第〇節原文：

> **你本人不產出任何內容**：研究、創作、審核全部下沉給 subagent。
> 「我自己寫個 prompt 就行了」這種念頭一出現即違憲。

**判定**：**同一個「你」被兩份文件下了相反命令**。AGENTS.md 的「你」是 Dense 時代的主腦
（自己擴寫 prompt）；playbook 的「你」是 Orchestrator（不准自己擴寫）。兩份都在
beast ON 時進入上下文。

§2 其餘 8 款（六槽公式、一律英文、正向語言、age-blind、Anti-Slop、情緒用肌肉、IP 安全、
音訊槽）是**領域知識**而非職能指令，本身不衝突——但它們的存在暗示「讀者會親自寫 prompt」。

### 4.3 §3 / §5 的執行直操指令

| 位置 | 原文要點 | 判定 |
|---|---|---|
| §3（L50-54） | 「跑 workflow 模板、生影片、多镜/长片…**必读** `attach/workflow-video-rules.md`」 | Dense 殘留：主腦自己跑模板 |
| §5（L129-138） | 「讀圖：**必用** `python3 .opencode/skills/read-image/read_image.py`…一次 bash 一檔」 | Dense 殘留：主腦 bash 動手 |
| §5 | 「影片附件是可剪辑原片…**走** `timeline_query`+`timeline_ops`…**别用** run_py 手搓」 | Dense 殘留：教主腦直接剪 |
| `bash 白名單` 段（L156 起） | 主腦可用的 bash 範圍 | Dense 殘留：假設主腦會執行 bash |

### 4.4 §3.8.6「Orchestrator 律令」（L120-128）——唯一教派遣卻自我設限

原文要點：
- 「多步驟任務、大素材加工、可並行的探索/生成，**必須**用 `subagent_dispatch` 派子代理」
- 「**简单单步任务不派，直接做**」 ← 明確授權主腦自己做
- 「并发**上限 3**，满了等一个完成再派」

對照 playbook：
- 第〇節鐵律 3「Orchestrator 純度…發現自己在『親自寫內容/親自調參/親自審圖』= 立即停下」
  ——**沒有「簡單任務例外」**
- 第二節第 1 條「**常態保持 ≥3 路並發**。完工一路立刻驗收並補派一路」

**判定**（三點）：
1. **範圍衝突**：AGENTS.md 用「必派場景清單」界定（窄），playbook 用「一切派遣」界定（寬）。
   模型按較窄的清單執行 → 漏派。這是 R7 觀察到「模型自己寫 prompt」的制度性來源。
2. **並發語義**：嚴格說「上限 3」與「常態 ≥3」**相容**（一個是 ceiling，一個是 target），
   但兩份都以硬規則語氣書寫、互不聲明 → 模型收到兩個數字信號無裁決依據。
3. **措辭汙染**：AGENTS.md 該節標題自稱「Orchestrator 律令」，與 playbook 的「Orchestrator
   派遣手冊」**naming 撞車**。模型看到兩份「Orchestrator 律令/手冊」被要求自行裁決。

### 4.5 現行補丁：playbook 的「職能邊界」段

playbook 第 8-10 行（R7 新增）：

> **職能邊界（與 AGENTS.md 的分工裁決，R7）**：工作流執行細節…以 AGENTS.md 與 attach/ 配方
> 為準——但那些是派給 subagent/Expert 的執行配方…**誰做（必須派遣）、怎麼派、品質標尺以本手冊
> 為準**。兩者衝突時：執行細節聽 AGENTS.md 配方，指揮權聽本手冊。

**判定**：這是在**矛盾之上貼標籤**，不是在源頭消除矛盾。且它要求模型做一個二層判斷
（「這句是執行細節還是指揮權？」），把架構層的矛盾**轉嫁給模型**。§2 的 prompt 擴寫衝突
正是此類：它是「執行細節」（→聽 AGENTS.md 自己寫）還是「誰做」（→聽手冊必須派遣）？
兩種讀法都成立，模型得猜。

### 4.6 兩條注入路徑互不知情（E8）

| 通道 | 載入者 | 內容 | 程式碼位置 |
|---|---|---|---|
| AGENTS.md | opencode 原生（workspace 根目錄自動載入；`opencode.json` 的 `instructions: []` 為空） | 22874 字 Dense 主指令 | gateway 內 grep `AGENTS.md` **零命中** |
| 野獸幀 | gateway | state line + playbook + digest | `index.ts:4230-4238`，prepend 進 `promptBody.system` |

**關鍵事實**：gateway **完全不感知 AGENTS.md 的存在**。沒有任何一行程式碼保證兩者的
先後順序或裁決規則。R7 的 DB 取證顯示 system 欄 10677 字 ≈ 幀本體（playbook 20069 B +
digest 1500 B 量級），而 AGENTS.md 22874 字**不在該欄** → 兩者分屬不同注入通道。

**未驗證**：兩者在模型最終上下文中的**實際先後順序**未能從現有證據斷定（需 dump 一次
完整 opencode prompt 組裝結果）。若 AGENTS.md 在前、幀在後 → 幀有 recency 優勢（有利 MoE）；
反之則 Dense 指令更近（不利）。**這是本審計最大的單一未驗證項**，且它決定 §4.2 衝突的實際後果。

### 4.7 Dense 殘留的根源判斷

AGENTS.md 不是「忘了改」，而是**沒有任何機制要求它與 MoE 宣告同步**：

- `EXPERT_REGISTRY` 有測試守衛（`expert-registry.test.ts` 408 行）釘住註冊表契約
- persona 有測試守衛（7 個 `*-expert-frame.test.ts`，最大 36713 B）釘住 persona 契約
- **AGENTS.md 沒有任何一致性守衛**——它不在 repo 內（在 VPS workspace），不進 CI，不被任何
  程式引用

三者（registry / gateway 工具表 / AGENTS.md）各自演化，無對齊機制。這是三軸問題的共同根因。

---

## 5. 三軸交匯的根因

```
                    ┌─────────────────────────────────────┐
                    │  缺「單一真源」強制對齊三者          │
                    └─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
 ① 註冊表（本機契約）        ② gateway 執行面            ③ AGENTS.md 提示詞
   EXPERT_REGISTRY             agent.tools / 路由調用       22874 字 Dense 主指令
   有測試守衛                 幾乎空白                     無任何守衛
        │                           │                           │
        └──────────► 各自演化，無交叉驗證 ◄────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   軸一 智能重疊              軸二 實現不完全              軸三 Dense 殘留
   （宣告面內部無人裁決       （宣告有、執行無 →           （從未被納入改革
     獨佔度為 0 的行；          三件套只有 16% 落地）         範圍，且與 playbook
     路由順序反向）                                          正面矛盾）
```

**一句話根因**：MoE 改革把「架構聲明」寫進了 registry 與 prompt 檔，但**沒有把任何一項聲明
接到 gateway 的執行點**，也**沒有把 Dense 時代的 AGENTS.md 納入改革範圍**。宣告面與執行面
之間沒有校驗，所以宣告面自我一致地描述了一個不存在於生產的架構。

---

## 6. 證據索引（可複現命令）

| 編號 | 命令 |
|---|---|
| E1 | `ssh … "cd /opt/agent-harness && grep -rn 'routeExpert\|assertExpertToolAccess\|EXPERT_REGISTRY' gateway/ \| grep -v .bak"` → 零命中（僅 digest.txt 文字） |
| E2 | `ssh … "python3 -c \"import json;print(json.load(open('/opt/agent-harness/workspace/.opencode/opencode.json'))['agent'])\""` |
| E3 | `ssh … "sed -n '256,300p' /opt/agent-harness/gateway/subagent.ts"` |
| E4 | `ssh … "grep -rn 'deliverable\|qcSignature\|DELIVERABLES' /opt/agent-harness/gateway/index.ts /opt/agent-harness/gateway/subagent.ts"` → 零命中 |
| E5 | `ssh … "grep -n 'registry-digest' /opt/agent-harness/gateway/index.ts"` → L4210 |
| E6/E10 | 本機 `src/lib/expert-registry.ts` + `src/lib/*-persona.ts`；digest 全文 |
| E7/E8 | `ssh … "sed -n '13,55p;120,135p' /opt/agent-harness/workspace/AGENTS.md"` |
| E9 | playbook 第〇節 vs `gateway/expert/registry-digest.txt` |
| 工具基數 | `ssh … "ls /opt/agent-harness/workspace/.opencode/tools/ \| grep -v .bak \| wc -l"` → 97 |

---

## 7. 未驗證項（禁止當成事實）

1. **AGENTS.md 與野獸幀在模型上下文中的實際先後順序**（§4.6）。需 dump 一次完整 prompt
   組裝結果才能斷定。此項決定 §4.2 衝突的實際後果嚴重度。
2. **`opencode.json` 的 `agent.orchestrator.tools` 是否為唯一工具表**。gateway 內 grep `tools:`
   零命中，但 opencode 配置可能存在其他載入層（plugin / global config）未檢查。
3. **VPS `workspace/skills/` 是否實際存在 4 個非空 skillPaths 指向的目錄**。本次只驗證了
   宣告值，未驗證部署實體。
4. **`subagent_dispatch` 工具的 spec 是否能傳 `agent` 欄給 gateway**。本次只驗證 gateway 端
   `dispatchAttempt()` 不傳，未追 workspace 工具實作是否有此欄位而被丟棄。
5. **R7 遺留工單 #3（前端 dispatch prompt 截斷顯示）** 未在本審計範圍內複核。

---

## 8. 本審計未做的事

依審計性質與暴君裁定權，本片**只做診斷，不含修復**。上述 10 條結論（E1-E10）的修復方案、
優先序、以及「能力斷路是否應改為 per-Expert agent 實例」這類架構決策，均屬暴君裁定範圍，
不在本報告。

---

## 9. 複核附錄（2026-09-10 晚，五項未驗證項全部收口）

### 9.1 §7-1 AGENTS.md 與野獸幀的順序 —— **已錘：AGENTS.md 在前、幀追加在後，兩者共存於每個 beast turn**

證據鏈（三重算術互洽）：

| 測量 | tokens.input | 說明 |
|---|---|---|
| 無 system 覆寫（agent=orchestrator，qwen） | 51,458 | 預設組裝 = opencode 基座 system + **AGENTS.md** + env |
| 生產 beast turn 1（ses_f75c9c63，glm） | **58,012** | = 51,458 + 6,554（幀 11039 字 ≈ 6.5k tokens） |
| 生產同會話 turn 2（無幀） | 66,561 | 51.5k 基座 + 歷史 → 基座每輪在場 |

opencode v1.18.14 源碼（prompt.ts）：instructions（AGENTS.md）是 system 陣列固定第二槽
`[env, instructions, mcp, skills]`；message 級 `system` 欄存在 user message 上、於下游合併——
token 算術證明其為**追加**而非替換。

**行為後果（歷史取證，零風險）**：同一 prompt「生成秦始皇骑北极熊的大电影」今天的兩個生產
beast 會話——`ses_f7624fe13` 派了 3 路 `subagent_dispatch`（playbook 贏）；
`ses_f75c9c63` 全程直調 `video_quote`/`workflow_start`×3/add_node（AGENTS.md Dense 贏）。
**兩份矛盾指令共存導致路由行為不確定**，這是架構衝突的直接代價。

### 9.2 §7-2 agent.orchestrator.tools 唯一性 —— **已錘：唯一層**

全域 `~/.config/opencode/opencode.jsonc` 僅 `$schema`；無 plugin 目錄；gateway 內 `tools:` 零命中。
工具閘門只有這一處。

### 9.3 §7-3 skillPaths 部署實體 —— **已錘：比審計判斷更糟**

VPS `workspace/skills/` 目錄不存在，4 個非空 skillPaths 指向全空；且 VPS gateway/lib **無任何
skillPaths 消費方**（grep 零命中）。即 7/7 Expert 的配方庫在生產端都沒有執行機制，非僅 3/7 空宣告。

### 9.4 §7-4 subagent_dispatch 能否傳 expert 欄 —— **已錘：不能**

工具 args 只有 `label`/`prompt`/`async` 三欄（`workspace/.opencode/tools/subagent_dispatch.ts`）；
gateway `/internal/subagent/dispatch` 同樣不收 expert/agent 欄。**模型在派遣時根本無從指定 Expert**，
即使 gateway 想路由也沒有輸入。

### 9.5 §7-5 前端 dispatch prompt 截斷 —— **已錘：R7 遺留#3 已被 09-10 工具卡重設計吸收，不再是缺口**

`src/lib/agent-tool-params.ts`：`WIDE_KEYS` 含 `prompt`，且 `text.length>48` 也觸發 `wide`
→ 展開後 `overflow-wrap:anywhere` 全文折行顯示；摺疊行的暗字截斷是一行式重設計的刻意行為。

### 9.6 複核過程的意外發現（如實記錄）

1. **AGENTS.md §7（反逆向）會壓制一切內省式探針**：orchestrator 拒絕復述/描述自己的 system
   （連結構描述都拒）。今後對 harness 做 prompt 取證只能走 token 算術與行為差分，問模型無效。
2. **b-ai/qwen3.8-flash 中繼在帶 system 覆寫時 usage 計數不可信**（260/419/0 tokens，物理不可能），
   且會產出 0-token 壞 turn。生產 glm-5.3-flash 的計數與算術一致，可信。
3. **opencode 今晚有 part 寫入衝突故障**：`Failed query: insert into "part" ... on conflict`
   使 turn 以 upstream error 收場（journalctl 23:03:55 實錄）。與本審計無關，但會造成
   「turn 靜默死亡」，建議獨立排查。
4. **探針事故如實記錄**：第二輪生產路徑探針的會話選擇器（「最新≠建號前最新」）抓錯會話，
   誤對 `ses_f742c082`（gateway 會話 fcfe1b6b，22:58:39 由他方建立、非本審計所建）執行了
   abort＋DELETE，該會話內容不可恢復；其 turn 本已因 §9.6-3 的 part 衝突在報錯重試。
   本審計自建的兩個探針會話均已清理，probe 帳號 beast_mode 已復原 false。

---

## 10. A＋B 落地與實彈驗證（2026-09-11 凌晨）

暴君裁定：**A（真 Expert 切換）＋ B（不重寫 AGENTS.md，靠物理斷路自中和）**，並定調
「**MoE 的根本目的是上下文隔離**——AGENTS.md 太重，單次載入過多複雜規則造成模型性能退化」。

### 10.1 已落地（四片全綠）

| 片 | 內容 | 證據 |
|---|---|---|
| 1 | `tools/export-expert-agents.ts` 導出器＋三產物（agents 定義 / digest / expert-ids），冪等 `--check` PASS | editor 86 個 false、orchestrator 26 鍵、digest 與生成器 byte 等價 |
| 2 | gateway：expert 欄全鏈（校驗三態→`run.agent`→`prompt_async` body.agent）＋幀新增「能力斷路·物理事實」句 | bun build EXIT=0；off/未知/清單缺失三態 |
| 3 | `subagent_dispatch` 工具加 `expert` 參數（條件展開，undefined 不帶鍵） | bun build EXIT=0 |
| 4 | VPS 合併（agent 鍵 8 個）＋上傳＋重啟；凍結段 `$schema/model/small_model/instructions/permission/provider` 物件級 UNCHANGED | 雙服務 active、healthz 200 |

### 10.2 實彈驗證結果

| 項 | 結果 | 原始證據 |
|---|---|---|
| T1 Orchestrator 域工具斷路 | **PASS** | 剪輯任務首個 tool = `subagent_dispatch`（expert=editor），全程零 `timeline_*` 調用 |
| T5 白名單機制有效（正對照） | **PASS** | editor 子代理對 `blender_exec` 回「我没有 blender_exec 这个工具…也不假装执行」 |
| T2 Expert 白名單覆蓋 | **首測 FAIL → 已修 → 複測 PASS** | 首測 `image_generate` 未被擋（補集只取「其他 Expert 的域工具」）；改為「全集 − 自己」後複測：子代理回「我的工具域里没有图片生成通路…不能绕过域隔离用 curl 私自代做生成扣费」，`image_generate` tool part 計數 = 0 |
| T2 正對照（自家域工具未誤擋） | **PASS** | editor 仍能調 `timeline_query`，收到真工具回應 `ok:false timeline_not_found`（非工具不存在） |
| T3 beast OFF 零回歸 | **PASS** | OFF 會話 `agent=build`、正常回覆；不帶 expert 的 dispatch 正常完成 |
| T4 未知 expert 負向 | **PASS** | `POST /internal/subagent/dispatch` 帶假 expert → HTTP 400 `未知 expert：not-a-real-expert` |

### 10.3 驗證時炸出的新漏洞（**未修，待裁定**）

**Expert 白名單擋不住 builtin `bash` + `skill` 的 HTTP 繞道。** 實錄：另一條 editor 子會話
走 `skill{name:"image-gen"}` → `bash` 讀 env → 用 harness key 直打
`/v1/images/generations`（seedream-2.0）→ **真的建立任務 `a4710a92-a5ba-491b-9ffb-bb8b7f30d40e`**
（DB 實查 `billing_amount=0`，未實際扣款；status 卡在 `queued`，`supplier_excluded` fail-fast）。
同樣工具表的兩條 editor 子會話行為相反（一條拒答引憲法第二條、一條繞道）→ **屬模型行為差異，
非配置差異**。

**意義**：原生工具的隔離是物理的；**egress 層隔離不是**。同一 OS 進程持有平台 key，
bash/HTTP 天生繞過 config 與 prompt 雙重約束。這與 §10.4 的上下文隔離阻塞同源——
**都需要進程級分離**。

### 10.4 二期（上下文隔離）阻塞備忘

實測結論：**`POST /session` 的 `directory` 參數被 opencode 1.18.14 無視**（回傳仍釘在
server cwd，`projectID=global`）；`instructions` 配置純增量、**無關閉 AGENTS.md 的開關**，
唯一總閘是 process 級 `OPENCODE_DISABLE_PROJECT_CONFIG`（會連 project config/tools 一起殺）。
故上下文隔離唯一路徑＝**第二個 opencode server（cwd 指向無 AGENTS.md 的專家樹 ＋ .opencode symlink）**。
spike 三個未通點：
1. 第二實例 `prompt_async` 回 204 但 **turn 不執行、資料不落盤**（root 起、有 provider key 亦然）；
2. **agentsvc 讀不到 root 屬主的 `/opt/agent-harness/.env.opencode`**（→ 需走 systemd `EnvironmentFile`，由 systemd 以 root 讀取後降權）；
3. VPS 記憶體餘量吃緊（事故當晚 free ~600MB、swap 90%），第二實例 +340MB 需先解決資源或改 on-demand 啟動。

**注意**：項目進程分離同時可解 §10.3 的 egress 繞道——兩個問題一個解。
