# 雙真相邊界（W5）

> 2026-09-29 文件化。**本檔只描述，不改碼**——裁定來源＝`eimu-competition-report/Dramagic對稱差-決策表-0928.md:63`：
> 「W5：DSL 只管 world1、world2 另一套真相 → **P2：雙真相邊界文件化**（寫文件，不改碼）」。
> 現場原話（`Eimu能力審視-工業化盤點-0928.md:81`）：「world2 執行圖（模板＋素材注入＋成片）仍走後端原子鋪
> ——兩套真相並存，是設計取捨也是認知負擔」。

## 0. 一句話

**畫布圖（world1）是運行時唯一真相；產線執行圖（world2）是鋪圖的真相。**
兩者在「SSE 事件把節點寫進畫布」這一條縫上相接：world2 的產物是節點，節點之後歸 world1 管。

判準（拿這句話回答 90% 的問題）：**問「畫布上有什麼」→ world1；問「一次產線要跑幾步、每步用什麼模型／門禁／素材」→ world2。**

## 1. world1 ＝ 畫布多步生產鏈

| 角色 | 權威位置 | 說明 |
|---|---|---|
| 契約真源 | `src/lib/canvas/types.ts` 的 `CanvasAgentOp` | 8 op：`add_node`／`update_node`／`delete_nodes`／`connect_nodes`／`delete_connections`／`select_nodes`／`set_viewport`／`run_generation`；2026-09-16（G1）加第 9 個 `set_project_meta`（專案級欄位補丁，唯一能改 `CanvasProject` 頂層的 agent 入口）；2026-10-03 加第 10 個 `revert_node`（節點版本回退＝人機共筆回滾面，執行端＝adapter agent_ops → reducer 既有 `revert_node`；閘道白名單另在 `deploy-staging/gateway/canvas-op-types.ts`） |
| 執行語義 | `src/lib/canvas/reducer.ts`、`src/lib/canvas/layout.ts` | **執行語義全在前端 reducer**（types.ts 註記）；`layout.ts` 另負責節點／metadata 的白名單清洗 |
| AI 的筆 | `src/lib/workflow-dsl/schema.ts` → `compile.ts` → `decompile.ts` | 暴君裁定 2026-09-02：**AI 不直接吐 `CanvasAgentOp`**，只吐 `WorkflowDslSource`，由 `compile.ts` 確定性編譯成 op；`decompile.ts` 支援回讀（round-trip 冪等）。**2026-10-03 讀改回滾三件接通**：讀面＝前端 `src/hooks/canvas/canvas-agent-snapshot.ts` 從全量 state 反推 `dsl`＋`node_versions` 塞快照（gateway `canvas-flow.compactCanvasState`／`canvas-state-summary.buildCanvasReceipt` 透傳）；寫面＝harness `deploy-staging/opencode-runtime/tools/workflow_write.ts`（站點 `/v1/workflow/compile` → `canvas_apply_ops` 通道）；回滾面＝`workflow_history`＋`workflow_rollback`（`revert_node` op） |
| agent 入場 | gateway 工具 `canvas_apply_ops` → SSE `canvas.ops` → `src/hooks/use-canvas-chat.ts` 的佇列（`canvas-agent-ops-queue.ts`）→ reducer | ops 一到即自動落 reducer（畫布操作自動化）；`applyAgentOps` 仍負責 dispatch＋`postCanvasOpsResult` 回報，讓工具調用拿到明確結果而非超時 |
| 失敗語義 | `compile.ts` 的教學式報錯、環路整份拒絕、`layout.ts` 逐欄白名單 | 非法值**省略該鍵**（＝不動該欄），不寫預設值冒充用戶設定 |

## 2. world2 ＝ 後端執行圖（模板＋素材注入＋成片）

| 角色 | 權威位置 | 說明 |
|---|---|---|
| 模板真源 | **VPS** `/opt/agent-harness/gateway/workflow-templates/` | 13 模板、一個模板一個檔（`single_image`／`character_sheet`／`scene_setup`／`single_video`／`feature_film`／`novel_film`／`novel_ip`／`ecom_launch`／`ecom_model`／`shortdrama_visual`／`shortdrama_poster`／`art_curation`／`art_style`）＋`index.ts`（共享註冊）＋`types.ts`；節點 `kind` ∈ `text｜config｜image｜video｜audio｜film`，節點 `role` 是**模板內唯一鍵**，連線寫 `{fromRole, toRole}` |
| 展開與執行 | **VPS** `gateway/workflow-engine.ts`／`workflow-service.ts`／`workflow-gw.ts` 的 `expandTemplate` | **活本在 VPS**（`/opt/agent-harness/gateway/`）。`src/` 內 grep `expandTemplate` 只會命中註釋——但 repo **另有一份可跑的鏡像**：`deploy-staging/gateway/`（見下） |
| repo 鏡像 | `deploy-staging/gateway/`（含 `workflow-engine.ts` 與 `workflow-templates/`） | 這是**測試與建置用的第二份拷貝**：`src/lib/agent-output-cards.test.ts:29` 直接 `import { expandTemplate } from "../../deploy-staging/gateway/workflow-engine"` 跑真引擎（不重寫它的 merge）。AGENTS.md 明記此目錄「勿當真源」。**2026-09-29 實查**：15 個模板檔（13 模板＋`index.ts`＋`types.ts`）與 VPS 逐檔 md5 **全等**，VPS 另多一支 `workflow-templates.test.ts`（W6 常駐回歸）⇒ 此刻兩份一致，但**一致是狀態、不是契約**（逐檔 SFTP 部署、無遞迴同步 ⇒ 隨時可漂） |
| 站點側資料面 | `src/lib/agent-templates.ts`（`AgentPipelineStep`）、`recipe-templates.ts`、`scenario-templates.ts` | 是產線的**資料鏡像與 UI 面**，不是執行引擎 |
| 鋪圖排版 | `src/components/canvas-workstation/agent-template-canvas.ts`（`pipelineToCanvasLayout`） | 模板 → 畫布版面（節點位置／型別徽章），**只排版，不改產線語義** |
| 落圖事件 | `canvas.plan`／`canvas.node.created`／`canvas.node.updated`（`src/lib/agent-chat-types.ts`、`src/lib/canvas/reducer.ts`） | 「首訊 8 秒建骨架」就是這條：模板展開後節點以事件落進畫布，之後歸 world1 |

## 3. 邊界（哪一格歸誰）

| 問題 | 歸屬 |
|---|---|
| 畫布上有哪些節點／連線／選中／視窗 | world1（reducer） |
| 一次生成要跑幾步、每步的模型／門禁／素材注入／成片合成 | world2（gateway 模板＋engine） |
| 產物（圖／影片／音訊／音樂）本身 | 生成平面（`/api/generation-jobs`＋artifact），兩邊都只是**引用**它的節點 metadata |
| 專案級欄位（作品類型／劇集／風格綁定…） | world1 的 `CanvasProject` 頂層；agent 唯一寫入口＝`set_project_meta` |

## 4. 為什麼這是取捨，不是缺陷

- **好處**：兩邊可各自演進——產線可只動模板檔（VPS 逐檔部署、`index.ts` 單獨一趟註冊），畫布 DSL 可只動前端編譯器。多數改動**只需落在其中一邊**。
- **代價**：同一個「步驟」在兩邊各表達一次（模板檔的節點 ↔ 畫布節點），兩者的節點 metadata 靠**雙白名單**同步；漏一處＝鍵**靜默消失**（實例見 `mem show 2026-09-24-ws10-emits-entity-whitelist-strip-fix.md`：`emitsEntity` 被白名單剝除，自動落卡鏈整條失效）。
- **代價二（世界2 自己有兩份）**：產線的活本在 VPS `/opt/agent-harness/gateway/`，repo 另有一份 `deploy-staging/gateway/` 供測試直接跑真 `expandTemplate`。兩份靠**逐檔 SFTP**（`.gateway-work/sftp-put-443.js`，無遞迴同步）維持一致，2026-09-29 實查 15 檔 md5 全等——但「一致」只是當下狀態，改模板時**兩份都要動**，否則測試驗的是舊真相、線上跑的是新真相。
- **代價三**：只讀站點 repo 會誤判「這功能沒實作」。查產線**實際行為**必須上 VPS 看 `gateway/`；站點側的 `agent-templates.ts` 只是資料面。

## 5. 鐵律（改動前先讀本節）

1. 要改「畫布上有什麼」⇒ **只動 world1**：`CanvasAgentOp` 契約 → `reducer.ts` → `layout.ts` 清洗 → 前端。禁把產線圖硬編進 DSL。
2. 要改「產線怎麼跑」⇒ **VPS 模板檔＋engine 與 repo 鏡像 `deploy-staging/gateway/` 兩份同批改**；部署走逐檔 SFTP（無遞迴同步），改完比對 md5。禁在別的目錄另抄第三份 `expandTemplate`。
3. 節點 metadata 出現新鍵 ⇒ **雙白名單同批改**（漏一處＝靜默丟鍵）：
   `src/lib/canvas/node-metadata-fields.ts`（`DURABLE_METADATA_FIELDS` / `AGENT_METADATA_FIELDS`）
   ＋ `src/lib/canvas/layout.ts`（`DURABLE_FIELD_CLEANERS`）
   ＋ `src/hooks/canvas/canvas-chat-types.ts`（`applyAgentFieldTransform`）
   ＋ 對應測試樣本。
4. `CanvasProject` 出現新欄位 ⇒ 逐欄白名單**七處同批**（先例：2026-09-15 的 `projectType`／`currentStep`／`episodes`）：
   型別（`types.ts`）→ `normalizeProject`（`project-store.ts`）→ `CanvasProjectMetaPatch`（`types.ts`）→ `canvasProjectMeta` 與 `normalizeProjectMetaPatch`（`layout.ts`）→ 專案 PUT 透傳（`src/app/api/canvas/projects/route.ts`）→ hook 的 `setProjectMeta` 與還原點（`src/hooks/use-canvas-chat.ts`）→ 匯出／匯入。
5. 事故判準：**當同一個事實需要在兩個地方各寫一次，先問它屬於哪一邊，再寫**——寫在兩邊就是下一次漂移的起點。

## 6. 複核用命令

```bash
# world1 契約與執行語義
grep -n "export type CanvasAgentOp" -A 20 src/lib/canvas/types.ts
grep -n "export function compileWorkflowDsl\|環路\|教學" -A 5 src/lib/workflow-dsl/compile.ts

# world2：活本在 VPS，鏡像在 repo（2026-09-29 實查 md5 全等；僅 VPS 多一支回歸測試）
ls /opt/agent-harness/gateway/workflow-templates/
ssh -i ~/.ssh/new.pem -p 22443 ubuntu@43.172.85.76 \
  "cd /opt/agent-harness/gateway && find workflow-templates -name '*.ts' | sort | xargs md5sum"
cd deploy-staging/gateway && find workflow-templates -name '*.ts' | sort | xargs md5sum   # 逐檔比對

# 雙白名單三處
grep -rn "DURABLE_METADATA_FIELDS\|AGENT_METADATA_FIELDS" src/lib/canvas/node-metadata-fields.ts
grep -rn "DURABLE_FIELD_CLEANERS" src/lib/canvas/layout.ts
grep -rn "applyAgentFieldTransform" src/hooks/canvas/canvas-chat-types.ts
```
