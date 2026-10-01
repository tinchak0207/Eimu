# D3：控面代理清單抽單一真源＋漂移棘輪測試（預期 40 分鐘）

工作目錄 `/home/lenovo/Desktop/image-app`（Next.js 15，測試跑法 `npx tsx --test <檔>`，node:test + node:assert）。

## 必讀記憶
- `~/.claude/memory/MEMORY.md`（Tier-0）＋ `~/.claude/memory/packs/infra-deploy.md`
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-gap.md`：beforeFiles 代理清單是逐條列舉；站點 route 若碰 GENERATION_DATABASE_URL 卻沒被代理 → 在 Vercel 跑、沒 DB → 500/503
- `~/.claude/memory/notes/2026-09-28-control-plane-mirror-port-and-verify-recipe.md`：同上，含控面座標
- 記憶與現場證據衝突時以現場為準，並在回報中寫明衝突。

## 背景
`next.config.mjs` 的 `rewrites().beforeFiles` 手寫 10 條代理（`/v1/:path*`、`/api/v1/:path*`、`/api/generate-images`、`/api/generation-jobs`、`/api/generation-jobs/:path*`、`/api/admin/billing-operations/:path*`、`/api/internal/team-membership`、`/api/email/unsubscribe`、`/openai/v1/:path*`），每條都是 `source → ${controlPlaneOrigin}/image-control${source}`。`src/app/api` 下有約 212 支 route.ts，沒有任何機制發現「需要控面 DB 卻沒被代理」的 route。

## 要做的事
1. 新檔 `src/lib/control-plane-proxy-routes.mjs`（純 ESM、無依賴）：
   - `export const CONTROL_PLANE_PROXY_SOURCES = [ ... ]`：上面 10 條 source，**順序不變**；把 next.config.mjs 裡每條 source 上方的說明註解**原文搬過來**放在對應元素上方。
   - `export function controlPlaneRewrites(origin)`：`origin` 為空回 `[]`，否則 `SOURCES.map(s => ({ source: s, destination: \`${origin}/image-control${s}\` }))`。
2. `next.config.mjs`：`controlPlaneRewrites` 陣列改成 `controlPlaneRewrites(controlPlaneOrigin)`（import 上面的檔）。檔尾那段 `CRITICAL: 控制面代理必須放 beforeFiles` 的長註解與 `beforeFiles`/`afterFiles` 結構**一字不動**。
3. 新檔 `src/lib/control-plane-proxy-routes.test.ts`：
   - **行為不變斷言**：`controlPlaneRewrites("https://o.example")` 深等於一份**在測試裡逐字寫死**的 10 條 `{source,destination}`（照改動前的 next.config.mjs 手抄，不許從被測模組推導）；`controlPlaneRewrites("")` 與 `controlPlaneRewrites(undefined)` 回 `[]`。
   - **漂移棘輪**：
     - 掃 `src/app/api/**/route.ts`，檔案路徑轉 URL 路徑（去 `src/app` 前綴與 `/route.ts`、去掉 `(group)` 段、`[id]`/`[...x]` 保留為一段字面）。
     - 「DB 綁定模組」＝ `src/` 下非 `.test.ts` 且原文含字串 `GENERATION_DATABASE_URL` 的檔（測試執行時 grep 得出，不寫死）。
     - 從每支 route.ts 做**遞迴 import 閉包**（只追 `src/` 內：相對路徑與 `@/` → `src/`；解析 `.ts/.tsx/.js/.mjs/index.*`；`import type` 可跳過）。閉包碰到任一 DB 綁定模組 ⇒ 該 route 為「DB 綁定 route」。
     - 比對規則照 Next：精確字串相等；`/x/:path*` 只匹配 `/x/<至少一段>`（**不**匹配裸 `/x`，next.config.mjs 註解有寫這個坑）。
     - 測試內一個 `KNOWN_VERCEL_LOCAL: Record<string, string>`（URL 路徑 → 理由）作為**基線**。斷言：每個 DB 綁定 route 要嘛被某條 source 匹配，要嘛在基線內；**且**基線內每一條目前仍是「DB 綁定且未被代理」（過期條目也要紅，逼基線只縮不漲）。失敗訊息列出所有違規路徑。
   - 基線怎麼填：先跑一次拿到全部違規 route，逐支讀 route.ts：若它在 Vercel 上顯然安全（例如缺 env 時直接回 503、只走 HMAC relay 打控面、只在特定 env 下觸庫），理由寫一句具體原因；看不出來的寫 `"baseline 2026-09-28 未分類"`。
4. **禁止**新增或刪除任何代理條目（那會改生產路由，而控面副本不一定有該 route）。這一步只把現狀鎖住並列出清單。

## 驗收（全部要貼輸出）
- 改前改後各跑一次：`GENERATION_CONTROL_PLANE_PROXY_ORIGIN=https://o.example node -e "import('./next.config.mjs').then(async m=>console.log(JSON.stringify(await m.default.rewrites())))"`，兩次輸出**逐字相等**（用 diff 證明）。
- `npx tsx --test src/lib/control-plane-proxy-routes.test.ts` 全綠。
- 反證：臨時把 `KNOWN_VERCEL_LOCAL` 刪掉一條 → 測試紅且訊息指出該路徑；再還原。
- `npx tsc --noEmit -p .` 對你新增/修改的檔沒有新錯（既有錯與你無關就註明）。

## 紅線
- working tree 有別人未提交的改動（canvas、video-frames 等）：**只 `git add` 你自己的 3 個檔**，禁 `git add -A`／`git commit -a`／stash／checkout／reset。
- 不部署、不碰 VPS、不打任何付費上游。
- 同一錯誤重試 2 次仍失敗 → 停下，回報事實。
- 完成後 `git commit`（訊息中文，`chore(proxy): …`，結尾 `Co-Authored-By: DeepSeek <noreply@deepseek.com>`）。

## 回報格式
commit hash；三個檔的 diff 行數；DB 綁定 route 總數、被代理數、基線數；基線清單（路徑＋理由）全文；驗收命令輸出。
