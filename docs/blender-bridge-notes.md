# blender-bridge 橋接說明與 deny 例外暫存（Astra 3D P0-4，片C，2026-09-06）

分工：橋（`bridge/blender-bridge`，Blender headless 沙箱執行器）由片 A 施工；本檔記錄工具層與橋的
HTTP 契約、錯誤分類，以及 deny 表暫存條目。**橋的啟動方式與內部實現以片 A 的橋源碼/README 為準，
本檔不重複，避免漂移。**

## 1. 工具層現狀（誠實標注）

- 三工具定義+handler 真源：`src/lib/blender-tools.ts`（blender_exec / blender_render / blender_export_gltf）。
- 已登記進 harness 真源清單 `src/lib/harness-tool-registry.ts`（P0-4 片C 完成面）。
- **registry 註冊 ≠ harness 能跑**（2026-08-31 誠實稽核教訓）：VPS `.opencode/tools/` 落位、
  opencode-server 重啟、活體註冊確認、真橋 smoke 均未做，待橋（片 A）就緒後補。
- 定義形狀同構 `src/vendor-bridges/opencode-tools/director_*.ts`；因 `@opencode-ai/plugin` 不在
  src/lib 可解析範圍，`args` 以描述符承載，VPS 落位時逐條譯成 `tool.schema` 調用、execute 體原樣搬運。

## 2. 傳輸契約（與片 A 逐字釘死，雙方不得單方面改動）

橋位址 = 環境變數 `BLENDER_BRIDGE_URL`，默認 `http://127.0.0.1:8765`。

```
GET  /v1/health → 200 {ok:true, blender_version, gpu:"egl"|"cpu", workdir}
POST /v1/execute body {script:string, timeout_ms?:number} →
  200 {ok:true, artifacts:[{path,bytes,kind}], scene_summary:string, stdout_tail:string, duration_ms:number}
  500 {ok:false, error:string, stdout_tail:string}
```

## 3. 工具 → 契約映射

| 工具 | 調用方式 | 說明 |
| --- | --- | --- |
| blender_exec | 直接 POST /v1/execute（script 原樣透傳） | 建場景/改場景/骨架動畫 keyframe；產物寫相對路徑即落橋工作目錄 |
| blender_render | 工具層合成 bpy 腳本 → POST /v1/execute | eevee（BLENDER_EEVEE_NEXT → BLENDER_EEVEE 逐個嘗試）/cycles；frames 幀序列 PNG；turntable=true 走空物體 pivot 旋轉 keyframe + FFMPEG/H264 輸出 mp4（默認 1-96 幀，線性插值） |
| blender_export_gltf | 工具層合成 bpy 腳本 → POST /v1/execute | GLB（默認）/GLTF_SEPARATE；AttributeError 時自動啟用 io_scene_gltf2 再導出 |

超時口徑：客戶端中止 = timeout_ms + 10s 寬限（讓橋的結構化 500 帶 stdout_tail 先到）。
默認值：exec 120s（可傳 timeout_ms 參數）、render 1800s、export 300s（不可傳，防長渲染被客戶端誤殺）。

## 4. 錯誤分類（工具層返回結構化 fail，絕不拋原始 fetch 錯誤）

| code | 觸發 | 文案要點 |
| --- | --- | --- |
| bridge_unavailable | ECONNREFUSED/ENOTFOUND/ECONNRESET/TypeError | 「**桥未启动，请先启动 blender-bridge**（默認地址 + GET /v1/health 驗證）」+ 指向本檔 |
| bridge_timeout | 客戶端中止先於橋響應 | 上限毫秒數 + 可傳更大 timeout_ms 的指引 |
| blender_script_error | 橋回 500 {ok:false} | 透傳橋的 error + stdout_tail（人話，非原始堆疊） |
| bridge_http_error | 非 200 且無 {ok:false} 體 | 異常狀態碼 + health 驗證指引 |
| bridge_bad_response | HTTP 200 但缺 ok:true 成功體 | 契約形狀異常，指向本檔 |
| invalid_args | 本地參數校驗（缺 script / engine/format 枚舉外 / frames 格式） | 不發網絡請求直接返回 |

防逃逸：output_name 白名單化（剝擴展名、路徑分隔符轉 `_`、截 80 字符）；所有嵌入 bpy 腳本的
字符串參數經 pyStr 轉義。腳本內容級沙箱（bpy API blocklist 等）屬橋側職責（片 A）。

## 5. deny 情況（本地勘察結論 + 暫存條目）

**本地勘察**（2026-09-06）：`grep -rn "deny" src/lib --include=*.ts` 零命中——repo 內無本地
deny/沙箱配置真源。deny 表唯一真源 = VPS `/opt/agent-harness/workspace/.opencode/opencode.json`
的 `permission.bash`；repo 內 `deploy-staging/opencode.json` 是 08-24 舊快照，已與 live 漂移，
勿當真源（記憶 agent-harness-deny-table-architecture）。08-29 放寬後 live 表為「預設 allow +
主機破壞紅線 deny」，gateway 每 60s 自動重讀，改表免重啟 gateway。

**暫存條目**（本片未動 VPS；落位時按此對賬）：

1. **工具層無需任何 deny 放行**：opencode 工具執行是 node 進程內 fetch（橋 127.0.0.1:8765），
   不經 bash permission 表。
2. **橋/Blender 進程安全**：橋必須綁 127.0.0.1（禁止 0.0.0.0 對外）；橋側 bpy 腳本執行前建議
   blocklist `import os/subprocess/socket/shutil/ctypes` 與絕對路徑 `open()`（白名單僅橋工作目錄）。
   屬片 A 施工建議，非 deny 表條目。
3. **若 agent 需要用 bash 工具直跑 Blender CLI**（如 `blender --background --python xxx.py`）：
   暫存建議 `"blender *": "allow"`。按 08-29 後 live 表預設 allow 無需改動；僅當日後回退為
   「預設 deny + 白名單」時，才按同構加此條目（並同步確認 `*blender-bridge*` 啟動命令放行）。
4. **不新增任何 deny**：blender 工具族沒有需要收緊的 bash 面；主機破壞紅線（sudo/dd/systemctl 等）
   維持現狀。

## 6. 落位時的驗收對賬（後續片/Astra P0 收尾用）

- [ ] 橋 GET /v1/health 返回 200 且 gpu 欄位非空（片 A 交付物）
- [ ] VPS `.opencode/tools/blender_{exec,render,export_gltf}.ts` 落位 + opencode-server 重啟
- [ ] `/experimental/tool/ids` 活體列出三 id
- [ ] bun 直調 smoke：橋關閉 → bridge_unavailable 人話錯誤；橋開啟 → exec/render/export 真產物
- [ ] 本檔 §5 與 live opencode.json 對賬一次（防 08-29 後再漂移）

## 7. 委託單與回傳接線（P1-4 片H，2026-09-06）

委託單構造器 `composeDelegation(input)`（`src/lib/blender-delegate.ts`）：schema
{effect_description, reference_refs?, shot_count, duration_sec?, style_constraints?,
deliverables[]}，deliverables 白名單 turntable/stills/blend/glb，序列化後 ≤2k token
超限結構化報錯。回傳接線：bridge `/v1/execute` 成功體 artifacts 按 kind 分揀成
Scene3dCardMetadata 六欄（turntable=mp4、stills=png、blend/glb 路徑；缺 mp4 用首張
png 兜底並標注 summary；缺 blend/glb 返回結構化錯誤不產半形）；寫入畫布走既有
canvas_apply_ops 的 add_node op（`buildScene3dCanvasOp`），經 canvas.ops SSE →
前端 normalizeAgentNode（缺尺寸取 420×360 預設）→ toScene3dCard 白名單 →
Scene3dCardBody 渲染。產物 URL 映射 resolveArtifactUrl 可注入（既有
image-proxy/下載連結形，不自造上傳通道）。契約測試 blender-delegate.test.ts 16 案。

## 8. 3D 資產入庫與腳本指紋（P1-5 片I，2026-09-06）

`src/lib/blender-asset-store.ts`：bridge 產物（blend/glb）+ bpy 腳本全文入資產包
（kind `scene_3d`/`bpy_script`，真源 `asset-pack-store.ts` 同構擴展）。
`fingerprintScript`＝引號外去註釋＋空白摺疊（保留縮進）後雙通道 FNV-1a 64 指紋；
`findTemplateByFingerprint` 命中即回腳本模板零 token 復用（成本護欄核心）。
`saveSceneAssets` 冪等入庫固定包 `blender-3d-assets`。契約測試 blender-asset-store.test.ts。

## 9. viewport 預覽通路（P1-3 片P，2026-09-06）

`.blender-work/out/` 不在 Next 靜態服務範圍，image-proxy 只收 https 公網 image/*，
故 glTF 預覽走新分支 `GET /api/blender-artifact?name=<單段檔名>`（requireVerifiedUser；
副檔名白名單 glb/gltf/blend/png/jpg/webp/mp4/webm；禁 traversal；Content-Type 對應
model/gltf-binary 等）。GLTFLoader fetch 帶不了 Bearer 頭（token 在 localStorage），
Scene3dGltfViewport 先 authHeaders fetch 拉 bytes → blob URL → engine.setGltfAsset
（白模 mannequin 共存，片E默認）。場景卡「3D 预览」鈕內嵌切換，殼內不疊卡。

## 10. 視頻嵌合（P2 樁：previz→video 全管線，2026-09-06 片Z）

`src/lib/blender-to-video-bridge.ts`：sceneCard.stills_urls → `GenerationReference[]`
參考卡（i2v 首/尾幀通道 cap 2）；previz 檔 role=composition 不佔幀位，lookdev 可作
style/首尾幀。`src/lib/camera-trajectory-to-prompt.ts`：L1 運鏡 id/bpy keyframes →
六槽 Camera 槽描述詞（seed-mapping §1.2 反向）。接線＝invisible-prompt-director
DirectorOptions 增 sceneCard/cameraTrajectory 九行：會話有 sceneCard 才覆蓋 camera
槽，用戶明示運鏡不干預；無 sceneCard 零行為變化（回歸測試釘死）。

## 11. blender 節點 supplier channel（片Y/片AA，2026-09-06）

blender-bridge 以 supplier channel 形態進 generation-core 派發（staging 稿
`deploy-staging/blender-nodes/NODES-PLAN.md`；registry 條目
`src/lib/supplier-channels.config.ts` marker 區 blender-local、adapter 分支
`src/lib/generation-core/blender-node-upstream.ts`）。能力標籤＝capability
model_id：`blender-render-eevee` / `blender-render-cycles`（catalog 條目，
不入 SUPPORTED_* → C 端選單不可見）。

### env 三件套（值不寫死進庫；本表只記名稱與語義）

| 變數 | 樣板值 | 說明 |
| --- | --- | --- |
| `BLENDER_NODE_LOCAL_URL` | `http://127.0.0.1:8765` | VPS 側值固定此形（片W 反向隧道裁定）；本機直連同值 |
| `BLENDER_NODE_LOCAL_TOKEN` | （隨機生成，不入庫不入 commit） | 橋側 Bearer 共享 token（片W §5 patch 落位前橋無鑑權，值僅滿足 configured 語義） |
| `BLENDER_NODE_LOCAL_ENABLED` | `true` | 清洗後嚴格 `=== "true"` 才 defaultEnabled（registryChannelToDescriptor 語義） |

落位面（缺一則 seed 靜默跳過/靜默出隊——誠實行為非缺陷）：VPS
`.env.control-plane`（worker seed 用）＋ Vercel env（站點隊列用）＋本機 `.env.local`（本地驗證用）。

### adapter 行為要點（`generateWithBlenderNode`）

- 同步 adapter：POST /v1/execute 單幀 job（片L 安全單位），無 provider task id，
  protocolOfAdapter 不映射、不進 provider-reconciliation。
- health 先行（GET /v1/health → workdir/gpu/queue_depth 證據）；產物 png 磁碟直讀
  （workdir/out 相對路徑 + traversal 守衛）→ base64；png 缺席保留 blend/glb 站內路徑。
- 429 queue_full/連線抖動＝瞬態交 worker 重試；橋 500 原文（error+stdout_tail）透傳。
- timeout：`BLENDER_NODE_EXECUTE_TIMEOUT_MS`（默認 600s；橋判定先行，客戶端 +10s 寬限）。

## 11. 工具面穿線（片AC，2026-09-06）

sceneCard/軌跡穿進視頻工具面：`scene3d-video-fusion.ts` 融合層（髒欄回 null）；
`last_frame_video_chain` 輸入增 `scene_card_ref`/`camera_trajectory` → 輸出
`sceneDirector`；C 端 `/api/generate-videos` body 增同名可選欄直通 DirectorOptions，
data URL 幀轉 File 進 multipart（cap 2）。缺欄零行為變化。VPS 消費配方：
`deploy-staging/blender-gateway/ac-video-scene-stitch.md`。
