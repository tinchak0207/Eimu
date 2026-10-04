// Expert 宪法／Orchestrator 派遣手册的**静态 import 镜像**（建置可携性，2026-10-03）。
//
// ① 为何是镜像，不是执行期读档：
//    两份文本的权威部署来源是 `deploy-staging/expert-gateway/{expert-constitution.md,
//    orchestrator-dispatch-playbook.md}`（与 VPS 活本对齐）。但 `deploy-staging/` 同时被
//    `.vercelignore`（第 95、278 行 `/deploy-staging/`）与 `.gitignore`（第 152 行
//    `/deploy-staging/*`）排除、且**完全未被 git 追踪** ⇒ 它永远上不了 Vercel。
//    九个读取点原先在**执行期从磁碟**读这两份文本（七个 delegate 用
//    `readFileSync(resolve(process.cwd(), EXPERT_CONSTITUTION_PATH))`、persona/frame 用
//    `fileURLToPath(import.meta.url)` 相对定位），Vercel serverless 上档案不存在 ⇒
//    beast mode 一被呼叫就走结构化硬失败（`constitution_unavailable` /
//    `playbook_unavailable`）。修法＝把两份文本**逐位元组镜像**成
//    `src/lib/expert-gateway-assets.json`（`src/` 必然随部署上传），改为静态 import；
//    与 `src/lib/mcp/expert-delivery-contracts.json` 同款轮子。
//    详见记忆 `2026-10-03-vercel-upload-path-build-time-file-trap`。
//
// ② 权威真源仍是 `deploy-staging/expert-gateway/*.md`（与 VPS 活本对齐的那份），本 JSON
//    只是**建置可打包的镜像**，两边必须逐位元组一致，由
//    `src/lib/expert-gateway-assets.test.ts` 的同步棘轮守住（原档缺席时 skip，因为该目录
//    是本机专属、未进 git）。
//
// ③ 重生成指令（在 repo 根逐字复制执行；原档更新后跑一次覆盖镜像）：
//
//   node -e 'const fs=require("fs");const g=p=>fs.readFileSync(p,"utf8");const out={_generated_note:"本档由 deploy-staging/expert-gateway/expert-constitution.md 与 deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md 逐位元组镜像生成；Vercel 拿不到 deploy-staging/（被 .vercelignore 95/278 行与 .gitignore 152 行排除、未进 git），故镜像到 src/ 以便静态 import 打包。权威部署来源仍是 deploy-staging/expert-gateway/*.md（与 VPS 活本对齐）。重生成指令见 src/lib/expert-gateway-assets.ts 档头。",expert_constitution:g("deploy-staging/expert-gateway/expert-constitution.md"),orchestrator_dispatch_playbook:g("deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md")};fs.writeFileSync("src/lib/expert-gateway-assets.json",JSON.stringify(out,null,2)+"\n")'
//
//    验证逐位元组一致：
//
//   node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("src/lib/expert-gateway-assets.json","utf8"));console.log("identical:",Buffer.from(a.expert_constitution).equals(fs.readFileSync("deploy-staging/expert-gateway/expert-constitution.md")),Buffer.from(a.orchestrator_dispatch_playbook).equals(fs.readFileSync("deploy-staging/expert-gateway/orchestrator-dispatch-playbook.md")))'
//
// ④ 以此为内容来源的档：
//    - src/lib/{editor,video,screenwriter,music,critic,motion,web3d}-delegate.ts
//      的 `defaultLoadConstitution()`（`loadConstitution` 注入 seam 不动）。
//    - src/lib/blender-director-persona.ts（`opts.constitutionPath` 显式 override 仍走 fs；
//      没给才用本 bundle）。
//    - src/lib/orchestrator-beast-frame.ts（`buildOrchestratorFrame` 的 ON 分支）。
//
// 注：本档与 JSON 皆 server-only（无任何 src/components 或 client 端引用），可安全打包。

import assets from "./expert-gateway-assets.json";

/** Expert 宪法全文（逐位元组等于 deploy-staging 原 `.md`）。 */
export const EXPERT_CONSTITUTION_TEXT: string = assets.expert_constitution;

/** Orchestrator 派遣手册全文（逐位元组等于 deploy-staging 原 `.md`）。 */
export const ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT: string = assets.orchestrator_dispatch_playbook;

/**
 * 空白资产判断（诚实铁律：空资产＝拒绝裸奔注入）。
 *
 * 导出供单元测试直接对空／全空白字串断言（无法在不改 bundle 的前提下让
 * `loadBundled*()` 读到空字串，故以本函式为判断的真源）。讯息明写是
 * 「bundled 镜像为空」，**不可**用「档案不可读」这种误导字眼（本路径根本没读档）。
 */
export function assertBundledAssetNonEmpty(text: string, assetLabel: string): string {
  if (text.trim() === "") {
    throw new Error(
      `bundled 镜像为空（${assetLabel}）：Expert 宪法／Orchestrator 派遣手册的内建镜像内容为空或全空白，` +
        `拒绝裸奔注入。请确认 src/lib/expert-gateway-assets.json 已由 deploy-staging/expert-gateway 的原档正确生成。`,
    );
  }
  return text;
}

/** 读 Expert 宪法 bundle（空资产抛错，讯息为「bundled 镜像为空」）。 */
export function loadBundledExpertConstitution(): string {
  return assertBundledAssetNonEmpty(EXPERT_CONSTITUTION_TEXT, "expert_constitution");
}

/** 读 Orchestrator 派遣手册 bundle（空资产抛错，讯息为「bundled 镜像为空」）。 */
export function loadBundledOrchestratorPlaybook(): string {
  return assertBundledAssetNonEmpty(ORCHESTRATOR_DISPATCH_PLAYBOOK_TEXT, "orchestrator_dispatch_playbook");
}
