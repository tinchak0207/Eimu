import { closeGenerationSql } from "../src/lib/generation-core/database";
import { runGenerationWorker } from "../src/lib/generation-core/worker-service";

// 容器重启等于在飞任务全部停摆 → deadline_exceeded 退款；浮动 promise（心跳/遥测）的 rejection 只记录，不杀进程。
process.on("unhandledRejection", (reason) => {
  console.error("[generation-worker] unhandledRejection（记录不退出）", reason);
});

runGenerationWorker()
  .catch((error) => {
    console.error("[generation-worker] fatal", error);
    process.exitCode = 1;
  })
  .finally(() => closeGenerationSql());
