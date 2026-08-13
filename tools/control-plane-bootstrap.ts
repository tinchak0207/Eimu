// 控制面开机自举：迁移 → 播种 → 交给 worker 循环。
//
// 为什么必须自动跑：supplier 播种工具在理论上会注册 env:pixai，实际上从没被执行过，
// 于是 pixai 模型没有任何 supplier_capability，生图一律回 overloaded ——
// 而改图/扩图走的是另一条直连路径，看起来是好的。「一个能用一个不能用」
// 这种最难查的现象，根因只是一条部署时没人跑的命令。
//
// 放在 worker 容器而不是 API 容器：
//   - runner 阶段是 Next.js standalone 产物，没有 tsx 也没有 tools/，跑不了；
//   - worker 只有一个实例，不存在多副本同时播种；
//   - compose 里 worker 依赖 postgres 的 healthcheck，起来时库一定就绪。
//
// 迁移工具自带 advisory lock 与校验和，重复执行是安全的；播种是幂等 upsert。
// 任一步失败就退出非零，让 compose 的 restart: always 重试 —— 带着半套 schema
// 跑 worker 只会产生更难解释的失败。

import { spawn } from "node:child_process";

function run(label: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[bootstrap] ${label} 开始。`);
    const child = spawn("npx", ["tsx", ...args], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`[bootstrap] ${label} 完成。`);
        resolve();
        return;
      }
      reject(new Error(`${label} 退出码 ${code}。`));
    });
  });
}

async function main(): Promise<void> {
  if (process.env.CONTROL_PLANE_BOOTSTRAP_SKIP === "1") {
    console.log("[bootstrap] 已按 CONTROL_PLANE_BOOTSTRAP_SKIP=1 跳过迁移与播种。");
  } else {
    await run("数据库迁移", ["tools/migrate-generation-db.ts"]);
    await run("supplier 播种", ["tools/seed-generation-suppliers.ts"]);
  }

  // 用 import 而不是再 spawn 一层：worker 需要成为容器的前台进程，
  // 才能正确收到 compose 发来的 SIGTERM。
  // 路径不带扩展名：tsconfig 未开 allowImportingTsExtensions，而 tsx 能解析。
  await import("../worker/generation-worker");
}

main().catch((error) => {
  console.error("[bootstrap] 自举失败，容器将退出以触发重启。", error);
  process.exit(1);
});
