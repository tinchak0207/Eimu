# 3D 導演台接入 Spec（方向 A：服務端預渲染 SVG + 全屏按需 three.js）

> 2026-09-02 成稿。暴君裁定：方向 A（小卡顯示服務端預渲染 SVG 示意，three.js 只在二期全屏路由載入）。
> 輪子真源：`/home/lenovo/Desktop/kunpeng-vendor`（commit 872a58b，MIT）。

## 0. 端狀態（一句話）

AI 助理在聊天中調用 `director_*` 工具規劃分鏡 → 用戶即時在聊天小卡與畫布小卡看到白模預演 SVG 示意圖與鏡頭/動作參數 → 數據落 VPS 會話文檔存儲 → 二期新分頁全屏 three.js 導演台。

## 1. 輪子現狀清點（vendor 實測，PRD 過時聲明）

`docs/kunpeng-bridge-prd.md` 包 C 寫 15 工具/27 運鏡/57 動作；**vendor 實測已是 16 工具/28 運鏡/58 動作/12 姿勢**，以現場為準：

- `src/lib/director/types.ts`（264 行，純）：v2 序列化 schema 全集（DirectorSceneFile/DirectorPlan/DirectorSequenceShot/DirectorActionClip/元素四型/28 CameraMove/58 ActionId/ASPECT_RATIOS）
- `src/lib/director/playback.ts`（302 行，純）：`evaluateDirectorFrame`/`inspectDirectorPlan`（越軸/入地/碰撞健康檢查）/`planDuration`/`shotAtTime`/`animatedJoints`；type-only 依賴 engine 的 `CameraPose`
- `src/lib/director/poses.ts`（81 行，純）：12 姿勢 + JOINT_SLIDERS
- `src/lib/director/pathCurve.ts`（96 行，純）：cubicBezier/sampleMotionPath/smoothPathFrame
- `src/lib/director/cameraTemplates.ts`（111 行，純）：28 運鏡模板 + `createCameraKeyframes`/`cameraPatchFromTemplate`
- `src/lib/director/motionTemplates.ts`（78 行，純）：58 動作模板 + `createMotionKeyframes`
- `src/lib/director/presetCameras.ts`（70 行，純）：預設機位；type-only 依賴 `@/lib/canvas/cameraPresets`
- `src/lib/director/shotDescription.ts`（94 行，純）：**NDC pinhole 投影數學**（camDir/right/camUp 基、zDepth 深度三分類前景/中景/背景、九宮格位置、朝向判定）——方向 A SVG 渲染的數學真源
- `src/lib/director/agentPlanning.ts`（524 行，混合）：純核 `parseJson/alignRawPlanToPrompt/ensurePlanActions/buildPlans/fallbackPlans/preserveLockedEdits/inferPromptActions*`；`quickChat`（Tauri LLM）不搬
- `src/lib/agent/tools/directorTools.ts`（857 行）：16 個 `director_*` 工具，schema + 兩段式確認守衛照搬，zustand 存取改 GATEWAY loopback
- `stores/directorStore.ts`（698 行）：~20 個 mutation（含 normalizeShotTimes/upgradePlanKeyframes/undo-redo JSON 快照）改寫為純文檔操作
- **不搬**：engine.ts/mannequin.ts/export.ts/DirectorStage.tsx/DirectorChatPanel.tsx/runtimeControl.ts（二期 C6）

隱式依賴：`nanoid`（vendor 未聲明，實際 3.3.11）——image-app 必須顯式安裝。

## 2. 架構（方向 A 分層）

```
agent LLM ──調用──> director_* 工具 ×16（VPS /opt/agent-harness/workspace/.opencode/tools/）
                        │ loopback HTTP（timeline_* 同款：resolveKey Bearer + ok()/fail()）
                        ▼
        gateway/director.ts（VPS /opt/agent-harness/gateway/，本地鏡像 src/vendor-bridges/gateway/director.ts）
          ├─ 文檔存儲 $WORKSPACE_DIR/director/<sid>/project.json + versions/ + log.jsonl（timeline.ts 同款：last 20 + 每第 10 個里程碑）
          ├─ ~20 個純文檔操作（directorStore mutation → JSON 操作）
          ├─ SVG 示意渲染（svgSchematic.ts：shotDescription 投影數學 → 俯視圖 + 鏡頭框圖）
          └─ emitToSession("director.done", …) ＋ canvas.node.created/updated（autoCreateCanvasUnit 同款攔截）
                        │ SSE
                        ▼
        聊天小卡 AgentDirectorCard ＋ 畫布 Director 節點卡（同一事件雙消費）
```

## 3. gateway HTTP 路由契約（釘死，片4/片5 據此並行）

掛進 gateway index.ts 既有 handler（繼承 `resolveSession` 會話鑑權，timeline 路由同款）：

| 路由 | 方法 | 入參 | 出參 |
|---|---|---|---|
| `/agent/v1/director/:sid/state` | GET | — | `{ok, project: DirectorSceneFile, active_plan_id, active_shot_id, health}` |
| `/agent/v1/director/:sid/op` | POST | `{op, …payload}`（文檔操作聯合，見 §4） | `{ok, project, revision}`；副作用：重算 SVG → emit `director.done` |
| `/agent/v1/director/:sid/proposals` | POST | `{instruction}` | `{ok, proposal_ids[], plans[]}`（每案帶 `requires_user_confirmation: true`） |
| `/agent/v1/director/:sid/apply_proposal` | POST | `{proposal_id}` | 無確認記錄 → `{ok:false}`（守衛照搬）；成功 → replacePlans + emit |
| `/agent/v1/director/:sid/schematic` | GET | `?plan=&shot=` | `{ok, top_view_svg, camera_view_svg}` |
| `/agent/v1/director/:sid/reset` | POST | — | 清空會話導演工程 |

工具側錯誤形狀統一 `fail(code, human_message)`；store 未初始化（未 manage_plan 建 project）→ `fail("director_not_initialized", …)`。

## 4. SSE `director.done` 事件契約（釘死）

```ts
{
  session_id: string;
  revision: number;              // project.json 版本號，單調遞增
  action: string;                // 觸發本次變更的操作名（director_upsert_action 等）
  plan: { id; name; summary; shot_count } | null;
  active_shot: { no; name; duration_frames; camera_move; shot_scale } | null;
  schematic: {
    top_view_svg: string;        // <svg …> 俯視圖，≤32KB
    camera_view_svg: string;     // <svg …> 鏡頭框圖，≤32KB
  };
  health: { ok: boolean; issues: Array<{ code; message; shot_id? }> };
  counts: { shots; elements; actions };
}
```

canvas 側：每次變更後 gateway 同步發 `canvas.node.created`（首次）/ `canvas.node.updated`，`node.type: "director"`，`metadata: { pipelineCard: "director", directorSessionId, planName, shotCount, healthOk, topViewSvg, cameraViewSvg }`。SVG 合計 >48KB 時 canvas metadata 省略 SVG（前端卡改走 Vercel 代理抓示意圖），`director.done` 內的 SVG 不省。

## 5. 分片派工

### 片1+片2 純函數層移植 + SVG 渲染器（合併一片派遣；片2 import 片1 產物，不可並行）【預期 100 分鐘，2x 殺線】

**輪子複製**（逐行 cp，禁精簡複製）：

| 源（kunpeng-vendor/src/lib/director/） | 複製到（image-app/src/vendor-bridges/director/） |
|---|---|
| types.ts (264) | types.ts ＋白名單：`CameraPose`、`ElementSnapshotForDesc` 從 engine.ts 移入 |
| playback.ts (302) | playback.ts（import 改 ./types） |
| poses.ts (81) / pathCurve.ts (96) | 原樣 |
| cameraTemplates.ts (111) / motionTemplates.ts (78) | 原樣（nanoid 依賴） |
| presetCameras.ts (70) | 原樣＋cameraPresets type-only 依賴處理（見白名單） |
| shotDescription.ts (94) | 原樣＋拆 engine type-only import |
| agentPlanning.ts (524) | planning-core.ts：只搬純核（§1 清單），quickChat 不搬 |

**白名單全量**：①CameraPose/ElementSnapshotForDesc 移入 types.ts ②import 路徑修正 ③presetCameras/shotDescription 的 `@/lib/canvas/cameraPresets` type-only 依賴→讀 vendor 源檔，將所需類型 verbatim 複製進本目錄 cameraPresets.ts ④agentPlanning 拆純核（LLM 呼叫點切除）。**除此之外一行不許動**——每檔 cp 後跑 `diff`，delta 超出白名單即返工。

**新膠水（非輪子，標注清楚）**：`svgSchematic.ts`——`renderTopViewSvg(plan, elements, shot)`（俯視：元素框+sampleMotionPath 路徑貝塞爾+攝影機位置與視野扇形）與 `renderCameraViewSvg(...)`（shotDescription.ts 投影數學逐行取用：NDC→viewport、深度三分類上色、畫家算法 zDepth 降冪）；輸出 `<svg>` 字串 ≤32KB；白模線框美學（深底白線）。附註：此檔為新寫代碼，投影數學的輪子錨是 shotDescription.ts。

**依賴**：`npm install nanoid@^3`（顯式釘）。

**測試**（node:test 慣例，`src/vendor-bridges/director/director-wheel.test.ts`，跑法 `npx tsx --test src/vendor-bridges/director/director-wheel.test.ts`）：CAMERA_TEMPLATES=28 且逐一 createCameraKeyframes 非空；MOTION_TEMPLATES=58 且逐一 createMotionKeyframes 非空；POSE_PRESETS=12；fixture plan（追逐戲：2 mannequin + walk/run 動作）跑 planDuration/shotAtTime/evaluateDirectorFrame(t=0/中/末)；inspectDirectorPlan 對缺陷 plan 至少報一項；fallbackPlans/inferPromptActions 對中文 prompt 產案；describeShot 非空；renderTopViewSvg/renderCameraViewSvg 輸出含 `<svg` 且 ≤32KB 且 XML 可解析。

**驗證閘**：測試全綠；`npx tsc --noEmit` 對 director 檔零新錯（repo 有既有髒改動，先取 baseline 再比對）。**禁 git commit**。

### 片3 gateway director 模組【預期 90 分鐘，2x 殺線】

本地寫 `src/vendor-bridges/gateway/director.ts`（VPS 真源鏡像，timeline.ts L29-34/L650-709 文檔存儲範式）：會話鎖 withSessionLock、版本保留（last 20 + 每第 10 個里程碑）、log.jsonl、§3 路由全部實現、§4 事件發射（emitToSession + canvas.node 攔截）、svgSchematic 渲染調用、~20 文檔操作（directorStore mutation 語義逐一等價，含 normalizeShotTimes/undo-redo 快照）。路由掛進 VPS gateway/index.ts（root:root → /tmp + python 錨點補丁 + mv 回，錨點前先 grep -n）。部署：sftp-put-443.js（驗 MATCH）→ `sudo systemctl restart agent-gateway` → journalctl 零錯 → curl 實彈 §3 每條路由（原生形狀，非工具規格化形狀）。

### 片4 agent 工具 16 檔【預期 90 分鐘，2x 殺線】

16 檔 `src/vendor-bridges/opencode-tools/director_*.ts` 本地鏡像（VPS 落位在片3 完成後）：`director_get_state/transport/select/update_element/create_element/upsert_action/set_motion_keyframe/set_camera_keyframe/manage_shot/manage_plan/project_control/set_lock/delete/prepare_export/propose_plans/apply_proposal`。schema 逐字段照搬 directorTools.ts；存取層白名單：zustand→GATEWAY loopback fetch（session_id 入 query，resolveKey(context.sessionID, context.abort) Bearer，ok()/fail() 形狀）。守衛照搬：propose_plans 附 `requires_user_confirmation`；apply_proposal 無確認拒絕；prepare_export 只開工作區「不会开始导出」。本地 `harness-tool-registry.ts` HARNESS_TOOL_ID_LIST 加 16 id + 日期註釋（慣例照 L60-67）。片3 部署完成後落 VPS：/tmp + `sudo install -m 644` → **`sudo systemctl restart opencode-server`（新增工具必做）** → `/experimental/tool/ids` 驗 16 id + 實彈 call part（轉錄出現工具名 = 假陽性）。

### 片5 前端雙軌小卡【預期 90 分鐘，2x 殺線】

①`src/lib/agent-chat-types.ts`：AGENT_EVENT_NAMES（L36-68）加 `director.done` + payload interface + parseAgentSseEvent case；②`src/lib/agent-chat-reducer.ts`：`AgentDirectorItem`（會話內唯一活卡，revision 新者替換舊者，不堆積）；③`src/components/agent-chat/AgentTranscript.tsx` 加 case → 新組件 `AgentDirectorCard.tsx`：SVG 用 `data:image/svg+xml;base64` img（免 dangerouslySetInnerHTML）+ 方案名/鏡頭數/健康徽章 + 「全屏開啟（即將上線）」disabled 鈕；④畫布：`CanvasNodeType` 加 `director` + TYPE_LABEL + CANVAS_NODE_DEFAULT_SIZE + NodeBody case + CanvasNodeView typeBadge（既有慣例照抄，SVG 消費 metadata）；⑤Vercel 代理 `src/app/api/agent/sessions/[id]/director/route.ts`（GET/POST → callAgentGateway，512KB 上限同 canvas-state 慣例，二期全屏用）。驗證：`npm run build` 零錯 + director 相關 tsc 乾淨。

## 6. 標準操作配方（貼進每個 subagent spec，不許現場考古）

- SSH：`bash .pixai-refresh/start-ssh443.sh` → `node .dsh-ssh/exec-443.js "<cmd>"`；備援 `ssh -i ~/.ssh/new.pem -p 22443 ubuntu@43.172.85.76`
- 傳檔：`node .gateway-work/sftp-put-443.js <local> <remote>`（內建 md5 驗 MATCH）；或 `scp -S "$SSH_BIN" -i ~/.ssh/new.pem -P 22443 <local> ubuntu@43.172.85.76:/tmp/`（SSH_BIN=/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/25.08/*/files/bin/scp；漏 -S 必失敗）
- root 檔安裝：scp 到 /tmp → `sudo install -m 644 /tmp/<f> /opt/agent-harness/…/<f>`
- 重啟：`sudo -n systemctl restart opencode-server agent-gateway`；驗 `systemctl is-active` + `journalctl -u agent-gateway -n 20 --no-pager`
- gateway index.ts 編輯前先 `grep -n` 錨點行（VPS 源常比本地 HEAD 新）；改前備份 `cp .env .env.bak-*` 慣例適用於所有 VPS 修改

## 7. 必讀記憶節（每個 subagent spec 必含）

1. `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/memory_summary.md`（總索引）
2. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/no-reinvention-copy-verbatim.md` — 禁精簡複製：wheel 每個函數/枚舉/常量逐行保留，砍一行=埋雷
3. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/prd-spec-wheel-anchor.md` — 輪子釘源檔判定法
4. `/home/lenovo/.codex/memories/extensions/ad_hoc/notes/timeline-post-production-buildout-0831.md` — gateway 工具部署配方真源（scp -S / sudo install / 雙重啟 / /experimental/tool/ids 驗證）
5. `/home/lenovo/.zcode/cli/memories/projects/image-app-63c110217f682752/memory/agent-gateway-copy-rules.md` — VPS 工具文案一律簡體；root 檔 sudo+重啟生效
6. 衝突指令：記憶與現場證據衝突時以現場為準並回報衝突。
7. 片1+2 已知遺留（2026-09-02）：vendor `ACTION_KEYWORDS` 詞表全簡體，繁體 prompt 會靜默零動作（inferPromptActions 返回空）——片3/4 工具文案用簡體，二期 quickChat 前加簡繁正規化。

## 8. 驗證閘門（總）

- 片1+2：測試全綠 + tsc 對新檔零錯
- 片3：VPS curl §3 全路由實彈 + 版本檔案落盤 ls 驗證 + journalctl 零錯
- 片4：`/experimental/tool/ids` 含 16 id + 實彈 `"tool":"director_get_state"` call part
- 片5：`npm run build` 零錯
- E2E：真實會話 agent 建方案 → SSE `director.done` → 聊天小卡 + 畫布卡同現 SVG
- 暴君總驗收：www.eimu.dev 對話「規劃一個雨夜追逐戲分鏡」目視兩卡——視覺結果 pending 暴君

## 9. 二期留樁（2026-09-03 暴君裁定升級為施工隊列）

方向 A 一期上線後，暴君視覺復測裁定「SVG 工程圖不合格，要 3D 建模和打光」→ 拍板**前端 three.js 小卡**（C6 引擎層提前）。二期隊列（自主漸進完成）：

| 波次 | 片 | 內容 | 檔案域 | 量級 |
|---|---|---|---|---|
| 1 | 片B | three.js 小卡：engine.ts/mannequin.ts 逐行移植（白名單：Tauri convertFileSrc→URL、import 路徑）+ DirectorMiniViewport 新膠水（動態 import/ResizeObserver/播放循環照 export.ts 輪子用法/WebGL 降級 SVG fallback/context 佇列≤2）+ 聊天/畫布雙卡接線 + CanvasNodeView director 狀態徽章隱藏 | vendor-bridges/director/{engine,mannequin}.ts、components/director-mini/、AgentDirectorCard.tsx、NodeBody.tsx、CanvasNodeView.tsx、package.json(three@^0.184) | ~120 分 |
| 1 | 模板接入 | agent-templates.ts novel_film/shortdrama 兩線「鎖定分鏡」→「渲染關鍵幀」之間插「3D 白模预演」步驟（outputKind "director"→CanvasNodeType.Director，GEN_NODE_TYPE+kindToNodeType+STEP_KINDS+requiredTools director_*+directive 一行）+ 測試 | agent-templates.ts、agent-template-canvas.ts、workflow-dsl/{schema,compile}.ts、測試 | ~半天 |
| 1 | 簡繁正規化 | planning-core.ts ACTION_KEYWORDS 加繁體變體（加法白名單，檔頭聲明）+ 繁體 prompt 測試 | planning-core.ts + 測試 | ~30 分 |
| 2 | C6 全屏 | `/director` 路由：zustand store + DirectorStage.tsx 2625 行 Tauri→web + DirectorChatPanel；數據走既有 Vercel 代理路由 | app/director/、stores、components/director/ | 2-3 週 |
| 2 | C4 生成閉環 | finalRender 白模 ref#1 → 我方生圖渠道 + confirm 門禁 + 寫回畫布；previs 視頻導出 | gateway+finalRender+export 白名單移植 | ~1 週 |
| 2 | LLM 方案 | planning-core LLM 呼叫點接 LLM（vendor quickChat 對應物），替換啟發式 fallback 的創意上限 | planning-core + gateway | ~1 天 |

## 10. 原二期備忘（歷史）

C4 生成閉環（finalRender 白模 ref#1 → 我方生圖渠道）、C6 全屏 `/director` 路由（three@^0.184 + zustand@^4.5 顯式安裝；DirectorStage.tsx 2625 行 Tauri→web 白名單改寫：工程 JSON 讀寫走片5 的 Vercel 代理路由；禁精簡複製——gizmo/鍵盤/時間軸/健康徽章全保留）。片5 代理路由與 director.done payload 已為此預留。
