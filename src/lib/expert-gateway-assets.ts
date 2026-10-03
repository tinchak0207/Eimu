// Expert 憲法／Orchestrator 派遣手冊的**靜態 import 鏡像**（建置可攜性，2026-10-03）。
//
// ① 為何是鏡像，不是執行期讀檔：
//    兩份文本的權威部署來源是 `deploy-staging/expert-gateway/{expert-constitution.md,
//    orchestrator-dispatch-playbook.md}`（與 VPS 活本對齊）。但 `deploy-staging/` 同時被
//    `.vercelignore`（第 95、278 行 `/deploy-staging/`）與 `.gitignore`（第 152 行
//    `/deploy-staging/*`）排除、且**完全未被 git 追蹤** ⇒ 它永遠上不了 Vercel。
//    九個讀取點原先在**執行期從磁碟**讀這兩份文本（七個 delegate 用
//    `readFileSync(resolve(process.cwd(), EXPERT_CONSTITUTION_PATH))`、persona/frame 用
//    `fileURLToPath(import.meta.url)` 相對定位），Vercel serverless 上檔案不存在 ⇒
//    beast mode 一被呼叫就走結構化硬失敗（`constitution_unavailable` /
//    `playbook_unavailable`）。修法＝把兩份文本**逐位元組鏡像**成
//    `src/lib/expert-gateway-assets.json`（`src/` 必然隨部署上傳），改為靜態 import；
//    與 `src/lib/mcp/expert-delivery-contracts.json` 同款輪子。
//    詳見記憶 `2026-10-03-vercel-upload-path-build-time-file-trap`。
//
// ② 權威真源仍是 `deploy-staging/expert-gateway/*.md`（與 VPS 活本對齊的那份），本 JSON
//    只是**建置可打包的鏡像**，兩邊必須逐位元組一致，由
//    `src/lib/expert-gateway-assets.test.ts` 的同步棘輪守住（原檔缺席時 skip，因為該目錄
//    是本機專屬、未進 git）。
//
// ③ 重生成指令（在 repo 根逐字複製執行；原檔更新後跑一次覆蓋鏡像）：
//
//   node -e 'const fs=require("fs");const g=p=>fs.readFileSync(p,"utf8");const out={_generated_note:"本檔由 deploy-staging/expert-gateway/expert-constitution.md 與 deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md 逐位元組鏡像生成；Vercel 拿不到 deploy-staging/（被 .vercelignore 95/278 行與 .gitignore 152 行排除、未進 git），故鏡像到 src/ 以便靜態 import 打包。權威部署來源仍是 deploy-staging/expert-gateway/*.md（與 VPS 活本對齊）。重生成指令見 src/lib/expert-gateway-assets.ts 檔頭。",expert_constitution:g("deploy-staging/expert-gateway/expert-constitution.md"),orchestrator_dispatch_playbook:g("deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md")};fs.writeFileSync("src/lib/expert-gateway-assets.json",JSON.stringify(out,null,2)+"\n")'
//
//    驗證逐位元組一致：
//
//   node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("src/lib/expert-gateway-assets.json","utf8"));console.log("identical:",Buffer.from(a.expert_constitution).equals(fs.readFileSync("deploy-staging/expert-gateway/expert-constitution.md")),Buffer.from(a.orchestrator_dispatch_playbook).equals(fs.readFileSync("deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md")))'
//
// ④ 以此為內容來源的檔：
//    - src/lib/{editor,video,screenwriter,music,critic,motion,web3d}-delegate.ts
//      的 `defaultLoadConstitution()`（`loadConstitution` 注入 seam 不動）。
//    - src/lib/blender-director-persona.ts（`opts.constitutionPath` 顯式 override 仍走 fs；
//      沒給才用本 bundle）。
//    - src/lib/orchestrator-beast-frame.ts（`buildOrchestratorFrame` 的 ON 分支）。
//
// 註：本檔與 JSON 皆 server-only（無任何 src/components 或 client 端引用），可安全打包。

import assets from "./expert-gateway-assets.json";

/** Expert 憲法全文（逐位元組等於 deploy-staging 原 `.md`）。 */
export const EXPERT_CONSTITUTION_TEXT: string = assets.expert_constitution;

/** Orchestrator 派遣手冊全文（逐位元組等於 deploy-staging 原 `.md`）。 */
export const ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT: string = assets.orchestrator_dispatch_playbook;

/**
 * 空白資產判斷（誠實鐵律：空資產＝拒絕裸奔注入）。
 *
 * 導出供單元測試直接對空／全空白字串斷言（無法在不改 bundle 的前提下讓
 * `loadBundled*()` 讀到空字串，故以本函式為判斷的真源）。訊息明寫是
 * 「bundled 鏡像為空」，**不可**用「檔案不可讀」這種誤導字眼（本路徑根本沒讀檔）。
 */
export function assertBundledAssetNonEmpty(text: string, assetLabel: string): string {
  if (text.trim() === "") {
    throw new Error(
      `bundled 鏡像為空（${assetLabel}）：Expert 憲法／Orchestrator 派遣手冊的內建鏡像內容為空或全空白，` +
        `拒絕裸奔注入。請確認 src/lib/expert-gateway-assets.json 已由 deploy-staging/expert-gateway 的原檔正確生成。`,
    );
  }
  return text;
}

/** 讀 Expert 憲法 bundle（空資產拋錯，訊息為「bundled 鏡像為空」）。 */
export function loadBundledExpertConstitution(): string {
  return assertBundledAssetNonEmpty(EXPERT_CONSTITUTION_TEXT, "expert_constitution");
}

/** 讀 Orchestrator 派遣手冊 bundle（空資產拋錯，訊息為「bundled 鏡像為空」）。 */
export function loadBundledOrchestratorPlaybook(): string {
  return assertBundledAssetNonEmpty(ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT, "orchestrator_dispatch_playbook");
}
