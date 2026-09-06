# ac-video-scene-stitch — last_frame_video_chain 場景卡嵌合 staging 稿（片AC，2026-09-06）

**性質：staging 稿，本片未上 VPS（零 SSH）。** 行為真源 = `src/lib/shortdrama-domain/index.ts`
`videoChain()`（本片新增 `scene_card_ref` / `camera_trajectory` 兩可選欄接線）＋
`src/lib/scene3d-video-fusion.ts`（寬容解析＋融合，只調用片 Z 契約）。
本檔只載 VPS handler 消費配方與落位命令，**行為零新增**。

## 0. 誰是真源、誰是消費端（輪子對照）

| 層 | 檔 | 角色 |
|---|---|---|
| 契約（片 Z，禁改） | `src/lib/blender-to-video-bridge.ts` / `src/lib/camera-trajectory-to-prompt.ts` / `invisible-prompt-director.ts DirectorOptions` | references 組裝 / Camera 詞翻譯 / 接線契約 |
| 融合（片AC 新增） | `src/lib/scene3d-video-fusion.ts` | unknown → 契約形寬容解析；任一形狀不合回 null＝零行為變化 |
| C 端面（片AC 接線） | `src/app/api/generate-videos/route.ts` | body 增 `scene_card`/`camera_trajectory`（snake/camel 雙讀）→ `optimizeVideoPrompt` options 穿 DirectorOptions；data URL 參考幀 → File 進 multipart（cap 2、不頂用戶上傳位） |
| agent 工具面（片AC 接線） | `src/lib/shortdrama-domain/index.ts` `videoChain()` | `last_frame_video_chain` 輸入增 `scene_card_ref`/`camera_trajectory`；同時合法 → 輸出 `sceneDirector`（referenceDirective/cameraDirective/references/notes） |
| VPS 消費端（本稿） | `/opt/agent-harness/workspace/.opencode/lib/shortdrama-video-chain-impl.ts` 同構檔 | 把 `output.sceneDirector.cameraDirective` 併進視頻生成請求 prompt；references 走 C 端直調通道（見 §2） |

## 1. VPS 端 last_frame_video_chain 現狀與補丁

VPS `.opencode/lib/` 的 last_frame_video_chain 實現（08-31 片4 落位，走站點
`/v1/videos/generations` 計費鏈）按本地真源同步時，補兩件事：

1. **輸入 schema** 增兩可選欄（opencode tool.schema 形狀，形同構 director_*.ts）：
   - `scene_card_ref`：`tool.schema.string().optional()`——3D 場景卡引用。**裁定：收
     sceneCard 物件的 JSON 字串**（`JSON.stringify(sceneCard)` 六欄直給），不收節點 id——
     VPS handler 無 canvas 節點索引，解引用＝新增 gateway 依賴；agent 從會話上下文
     （canvas_get_state 或 3D 導演回傳摘要）直接拿到六欄物件，字串化傳遞零新依賴。
   - `camera_trajectory`：`tool.schema.string().optional()`——同為 JSON 字串，
     形如 `{ "moves": ["dolly-in","orbit"], "focalLengthMm": 35 }` 或
     `{ "keyframes": [{ "frame": 0, "position": [0,0,5] }, …] }`（L1 move id 清單
     從 3D 導演 subagent 回傳的場景摘要帶出）。
2. **handler 接線**（偽碼，融合判定全在本地真源同步的 `videoChain` 內）：

```ts
// 融合（實現已同步進 last_frame_video_chain 行為真源；VPS 端只解析 JSON 字串入參）
let scene_card_ref: unknown
try { scene_card_ref = args.scene_card_ref ? JSON.parse(args.scene_card_ref) : undefined } catch { /* 髒欄＝缺欄 */ }
let camera_trajectory: unknown
try { camera_trajectory = args.camera_trajectory ? JSON.parse(args.camera_trajectory) : undefined } catch { /* 髒欄＝缺欄 */ }
// …videoChain(input, capabilities) 出 result.output.sceneDirector 後：
if (output.sceneDirector) {
  // ① prompt 端：cameraDirective ＋ referenceDirective 併進視頻生成 prompt
  const stitched = [prompt, output.sceneDirector.cameraDirective, output.sceneDirector.referenceDirective]
    .filter(Boolean).join(" ")
  // ② 幀端：references 只在 data: URL 時轉 File 上傳（見 §2）；http(s) 幀在
  //    B 端 /v1/videos/generations 無幀欄位（registry 已錘「站點 B 端無 first/last_frame
  //    欄位，幀降級文生視頻」），如實記進 output.notes，不宣稱已附幀。
}
```

**軌跡來源裁定（寫死，不許 handler 自行考古）**：sceneCard 六欄不含軌跡（片 Z 裁定
不動雙白名單契約）。軌跡由 agent 顯式給出——從 3D 導演 subagent 回傳的場景摘要裡的
L1 move id（或 canvas_get_state 場景卡節點上下文）填入 `camera_trajectory`；缺軌跡時
`camera_trajectory` 缺欄 → 融合 null → 零行為變化。

## 2. references 全生效通道（裁定）

- **站點 C 端** `POST /api/generate-videos`（登錄用戶，multipart）：`scene_card` /
  `camera_trajectory` 可作 JSON body 欄位直傳；data URL 參考幀已由 C 端路由轉 File
  進 multipart 圖位（cap 2、用戶已上傳圖優先）→ **references 全生效**。
- **VPS handler 直調 C 端**：`last_frame_video_chain` 若要幀位生效，改調
  `{SITE_ORIGIN}/api/generate-videos`（multipart：prompt/modelId + referenceImages
  File + scene_card/camera_trajectory 欄）而非 `/v1/videos/generations`；需會話鑑欄，
  落位前補 cookie/token 注入配方（待拍板，記此為 §5 前置項）。
- **B 端 `/v1/videos/generations`**（sk-biz-…）：本片不動（對外契約面，增欄屬 B 端
  API 版本決策）。

## 3. 落位命令稿（照 blender-gateway PATCH-PLAN.md §2 範式；本片零執行）

```bash
# 本地真源已含兩欄邏輯；VPS 同步走 repo deploy 流程（shortdrama-domain 屬 src/lib，
# 隨站點部署，不屬 .opencode 落位面）。僅當 VPS handler 是 .opencode/lib 獨立實現時：
vps.py run "sudo cp -a /opt/agent-harness/workspace/.opencode/lib /tmp/lib.bak-MMDD-acstitch"
vps.py put <同步後實現檔> /tmp/shortdrama-video-chain-impl.ts
vps.py run "export PATH=\$PATH:/home/ubuntu/.bun/bin && bun build /tmp/shortdrama-video-chain-impl.ts --target=bun --outfile=/tmp/ac-stitch-check.js && echo BUILD_OK"
vps.py run "sudo install -m 644 /tmp/shortdrama-video-chain-impl.ts /opt/agent-harness/workspace/.opencode/lib/shortdrama-video-chain-impl.ts"
vps.py run "sudo systemctl restart opencode-server"
```

## 4. 驗收配方（落位後）

```bash
# ① 缺欄零變化：不帶兩欄調 last_frame_video_chain → output 無 sceneDirector 鍵
# ② 帶欄生效：scene_card_ref = 六欄 JSON 字串 + camera_trajectory = {"moves":["dolly-in"]}
#    → output.sceneDirector.cameraDirective 含 "Camera: " 前綴、"dolly-in" 語義詞
#    → references 非空且 referenceRole ∈ {composition, style}
# ③ 髒欄不阻斷：scene_card_ref="not-json" → 融合 null → 與①同形
# ④ C 端：POST /api/generate-videos body 帶 scene_card+camera_trajectory（JSON）
#    → 200 videoUrl；同 body 不帶欄 → 行為與舊客戶端逐字同
```
